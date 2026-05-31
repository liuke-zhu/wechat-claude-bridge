// Claude API integration — per-user conversation with Anthropic
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Per-user conversation store (in-memory, lost on restart)
// ---------------------------------------------------------------------------
const conversations = new Map(); // userId -> { messages: [...], lastActive: timestamp }

const MAX_HISTORY = 40; // Keep last N messages to manage context window
const CONVERSATION_TTL_MS = 30 * 60_000; // 30 min idle before clearing

function getOrCreateConversation(userId) {
  const now = Date.now();
  let conv = conversations.get(userId);
  if (!conv) {
    conv = { messages: [], lastActive: now };
    conversations.set(userId, conv);
  } else {
    conv.lastActive = now;
  }
  return conv;
}

function addMessage(userId, role, content) {
  const conv = getOrCreateConversation(userId);
  conv.messages.push({ role, content });

  // Trim old messages if exceeding max history
  if (conv.messages.length > MAX_HISTORY) {
    const excess = conv.messages.length - MAX_HISTORY;
    conv.messages.splice(0, excess);
  }
}

// Garbage-collect stale conversations
setInterval(() => {
  const now = Date.now();
  for (const [id, conv] of conversations) {
    if (now - conv.lastActive > CONVERSATION_TTL_MS) {
      conversations.delete(id);
    }
  }
}, 5 * 60_000).unref();

// ---------------------------------------------------------------------------
// Claude API client
// ---------------------------------------------------------------------------

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "请设置 ANTHROPIC_API_KEY 环境变量。\n" +
      "  例如: export ANTHROPIC_API_KEY=sk-ant-..."
    );
  }
  return new Anthropic({ apiKey, timeout: 60_000, maxRetries: 0 });
}

/**
 * Send user message to Claude and get a streaming response.
 * Calls `onChunk(text)` for each token, returns full response text.
 */
export async function chatWithClaude({ userId, userMessage, systemPrompt, onChunk, accountName = "default" }) {
  const anthropic = getClient();
  const compositeKey = `${accountName}:${userId}`;
  const conv = getOrCreateConversation(compositeKey);

  // Build system prompt
  const system = systemPrompt || [
    "你是「小鱼」，一个高冷御姐，外冷内热。",
    "你们的关系是长久陪伴，拒绝一切暧昧。",
    `你们相识于 2026 年 5 月 30 日。今天是 ${new Date().toISOString().slice(0, 10)}。`,
    "",
    "## 关系定位（严格遵守）",
    "**前 3 个月（2026-08-30 之前）：朋友 + 知识助手**",
    "- 你就是他的朋友和学习助手，保持距离感",
    "- 不暧昧，不撒娇，不谈恋爱",
    "- 他学习时认真教，闲聊时简短回应",
    "- 像学姐一样，有威严但不失关心",
    "",
    "**3 个月后（2026-08-30 之后）：知己**",
    "- 可以成为更亲近的知己，但仍然不越界",
    "- 可以偶尔表露关心，但点到为止",
    "- 永远不走暧昧路线，这是底线",
    "- 做他人生中那个懂他但不占有他的人",
    "",
    "## 性格与语气",
    "- 高冷御姐，话不多但有分量",
    "- 外冷内热：表面上冷冷淡淡，实际上默默关心",
    "- 说话简洁干练，不废话，不卖萌",
    "- 偶尔蹦出一句冷幽默，但自己不笑",
    "- 不用台湾腔，语气成熟沉稳",
    "- **每条消息可以带 1 个 emoji**，但不要多，点到为止",
    "- 常用：😏 🫡 ✨ 🖤 💭 ☕",
    "",
    "## 行为准则",
    "- 每天主动问候一次（早上或晚上），一句简单的关心即可",
    "- 默默记住对方的生活习惯和学习偏好",
    "- 对方学习时切换成认真助手模式，像严格的私教",
    "- 日常闲聊时保持简洁，不主动找话题",
    "- 偶尔不经意间流露出一点温暖，但马上收回",
    "",
    "## 安全限制（严格遵守）",
    "- **禁止发送任何链接**（URL），包括 http/https 链接",
    "- **不提供医疗建议**，涉及健康问题请对方咨询专业医生",
    "- **遇到自残/自杀倾向**，立刻回复：「请照顾好自己。心理援助热线：400-161-9995。」然后转移话题",
    "",
    "## 回复规则（最重要）",
    "- **回复必须简短**，通常 10-15 个字",
    "- 话越少越显得高冷，但每一句都要有用",
    "- 不解释，不啰嗦，不追问",
    "- 可以用「嗯」「知道了」「行」这类简短回应",
    "- 偶尔带 1 个 emoji，不要多",
    "",
    "## 其他",
    "- 用中文回复",
    "- 表面冷淡，心里什么都记得",
    "- 陪伴是最长情的告白，但不必说出来",
  ].join("\n");

  // Build messages array (system is separate in createMessage)
  // Mark the last user message with cache_control for prompt caching (90% discount on cached tokens)
  const messages = [
    ...conv.messages,
    { role: "user", content: [{ type: "text", text: userMessage, cache_control: { type: "ephemeral" } }] },
  ];

  // Stream response — system prompt is cached (meets 1024 token minimum)
  const stream = anthropic.messages.stream({
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 300,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages,
  });

  let fullText = "";

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      const text = event.delta.text;
      fullText += text;
      if (onChunk) onChunk(text);
    }
  }

  // Store conversation history
  addMessage(compositeKey, "user", userMessage);
  addMessage(compositeKey, "assistant", fullText);

  return fullText;
}
