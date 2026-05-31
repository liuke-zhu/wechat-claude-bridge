// Message monitor — long-poll loop + message processing
import { getUpdates, sendMessage, getConfig, sendTyping, downloadVoice, transcribeVoice } from "./api.mjs";
import { chatWithClaude } from "./claude.mjs";
import {
  loadSyncBuf, saveSyncBuf,
  getContextToken, setContextToken,
  appendChatLog,
} from "./store.mjs";
import { BASE_URL, TypingStatus, SESSION_EXPIRED_ERRCODE } from "./types.mjs";

const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_PAUSE_MS = 15 * 60_000; // 15 min pause when session expired

/**
 * Split long text into chunks under WeChat's 4000-char limit.
 * Tries to split at paragraph boundaries.
 */
function chunkText(text, maxLen = 3800) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  const paragraphs = text.split(/\n\n+/);

  let current = "";
  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxLen && current.length > 0) {
      chunks.push(current.trim());
      current = para;
      // If a single paragraph exceeds maxLen, split it further
      if (current.length > maxLen) {
        while (current.length > maxLen) {
          chunks.push(current.slice(0, maxLen));
          current = current.slice(maxLen);
        }
      }
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Extract text body from a WeChat message's item_list.
 */
function extractText(itemList) {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === 1 && item.text_item?.text) { // TEXT
      return String(item.text_item.text);
    }
  }
  return "";
}

/**
 * Extract voice info from a WeChat message's item_list.
 * Returns { text } if WeChat already transcribed it, or { url, aesKey } for download.
 */
function extractVoice(itemList) {
  if (!itemList?.length) return null;
  for (const item of itemList) {
    if (item.type === 3 && item.voice_item) { // VOICE
      const v = item.voice_item;
      // WeChat may already provide transcription
      if (v.text) return { text: v.text };
      // Otherwise get download URL from media object
      const media = v.media || {};
      const url = media.full_url || media.url || v.url || "";
      const aesKey = media.aes_key || v.aes_key || "";
      if (url) return { url, aesKey };
    }
  }
  return null;
}

/**
 * Main long-poll loop. Runs until abortSignal fires.
 */
export async function startMonitor({
  token, baseUrl = BASE_URL, abortSignal,
  systemPrompt, onStatus,
  accountName = "default",
}) {
  let getUpdatesBuf = loadSyncBuf(accountName);
  let nextTimeoutMs = 35_000;
  let consecutiveFailures = 0;

  if (getUpdatesBuf) {
    console.log(`[monitor:${accountName}] 从上次游标恢复 (${getUpdatesBuf.length} bytes)`);
  }

  console.log(`[monitor:${accountName}] 开始监听消息... (baseUrl=${baseUrl})`);

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl, token, getUpdatesBuf, timeoutMs: nextTimeoutMs, abortSignal,
      });

      // Update suggested timeout
      if (resp.longpolling_timeout_ms) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      // Check for API errors
      if (resp.ret !== undefined && resp.ret !== 0 || resp.errcode) {
        if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
          console.error(`[monitor:${accountName}] session 过期，暂停 ${SESSION_PAUSE_MS / 60_000} 分钟后重试...`);
          consecutiveFailures = 0;
          await sleep(SESSION_PAUSE_MS, abortSignal);
          continue;
        }

        consecutiveFailures++;
        console.error(
          `[monitor:${accountName}] getUpdates 失败: ret=${resp.ret} errcode=${resp.errcode} ` +
          `errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`
        );

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      // Reset on success
      consecutiveFailures = 0;
      onStatus?.("ok");

      // Save sync cursor
      if (resp.get_updates_buf) {
        saveSyncBuf(resp.get_updates_buf, accountName);
        getUpdatesBuf = resp.get_updates_buf;
      }

      // Process messages
      const msgs = resp.msgs ?? [];
      for (const msg of msgs) {
        await processOneMessage(msg, { baseUrl, token, systemPrompt, accountName });
      }
    } catch (err) {
      if (abortSignal?.aborted) return;
      consecutiveFailures++;
      console.error(`[monitor:${accountName}] 网络错误: ${err.message} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }

  console.log(`[monitor:${accountName}] 已停止。`);
}

/**
 * Process a single incoming message: extract text → call Claude → reply.
 */
async function processOneMessage(msg, { baseUrl, token, systemPrompt, accountName }) {
  const fromUserId = msg.from_user_id;
  const contextToken = msg.context_token;
  let textBody = extractText(msg.item_list);

  if (!fromUserId) return;

  // Handle voice messages — prefer built-in transcription, fallback to download + ASR
  const voice = extractVoice(msg.item_list);
  if (!textBody.trim() && voice) {
    if (voice.text) {
      // WeChat already transcribed it
      textBody = voice.text;
      console.log(`\n🎤 [${accountName}:${fromUserId}] 语音(微信已识别): ${textBody.slice(0, 80)}${textBody.length > 80 ? "…" : ""}`);
      appendChatLog(accountName, { dir: "in", userId: fromUserId, text: `[语音] ${textBody}` });
    } else {
      // Need to download + ASR
      console.log(`\n🎤 [${accountName}:${fromUserId}] 语音消息，下载并识别中...`);
      appendChatLog(accountName, { dir: "in", userId: fromUserId, text: "[语音]" });

      try {
        const audioBuf = await downloadVoice({
          baseUrl, token,
          voiceUrl: voice.url,
          aesKey: voice.aesKey,
        });
        textBody = await transcribeVoice(audioBuf);
        console.log(`   🎤 识别结果: ${textBody.slice(0, 80)}${textBody.length > 80 ? "…" : ""}`);
        appendChatLog(accountName, { dir: "in", userId: fromUserId, text: `[语音→文字] ${textBody}` });
      } catch (err) {
        console.error(`   ❌ 语音处理失败: ${err.message}`);
        try {
          await sendMessage({
            baseUrl, token, to: fromUserId,
            text: "抱歉，语音识别失败了 😅 可以发文字给我吗？",
            contextToken: contextToken ?? getContextToken(fromUserId, accountName),
          });
        } catch {}
        return;
      }
    }
  }

  if (!textBody.trim()) return;

  console.log(`\n📩 [${accountName}:${fromUserId}] ${textBody.slice(0, 80)}${textBody.length > 80 ? "…" : ""}`);
  if (!voice) {
    appendChatLog(accountName, { dir: "in", userId: fromUserId, text: textBody });
  }

  // Save context token for future replies
  if (contextToken) {
    setContextToken(fromUserId, contextToken, accountName);
  }

  const replyCtx = contextToken ?? getContextToken(fromUserId, accountName);

  // Get typing ticket and start typing indicator
  let typingTicket;
  try {
    const configResp = await getConfig({
      baseUrl, token, ilinkUserId: fromUserId, contextToken: replyCtx,
    });
    typingTicket = configResp.typing_ticket;
  } catch {
    // Non-critical, continue without typing indicator
  }

  // Start typing
  if (typingTicket) {
    sendTyping({
      baseUrl, token, ilinkUserId: fromUserId, typingTicket,
      status: TypingStatus.TYPING,
    }).catch(() => {});
  }

  const startTime = Date.now();

  try {
    // Call Claude with streaming
    let replyText = "";
    const replyCtxToken = contextToken ?? getContextToken(fromUserId, accountName);

    replyText = await chatWithClaude({
      userId: fromUserId,
      userMessage: textBody,
      systemPrompt,
      accountName,
      onChunk: (_chunk) => {
        // Streaming chunk received — we could send progressive replies here,
        // but WeChat's sendMessage doesn't support editing. Just collect.
      },
    });

    // Stop typing
    if (typingTicket) {
      sendTyping({
        baseUrl, token, ilinkUserId: fromUserId, typingTicket,
        status: TypingStatus.CANCEL,
      }).catch(() => {});
    }

    // Send response (chunked if too long)
    const chunks = chunkText(replyText);
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : "";
      await sendMessage({
        baseUrl, token,
        to: fromUserId,
        text: prefix + chunks[i],
        contextToken: replyCtxToken,
      });
      if (i < chunks.length - 1) await sleep(300); // Small delay between chunks
    }

    const elapsed = Date.now() - startTime;
    console.log(`✅ [${accountName}:${fromUserId}] 回复完成 (${elapsed}ms, ${replyText.length} chars)`);
    appendChatLog(accountName, { dir: "out", userId: fromUserId, text: replyText });
  } catch (err) {
    // Stop typing on error
    if (typingTicket) {
      sendTyping({
        baseUrl, token, ilinkUserId: fromUserId, typingTicket,
        status: TypingStatus.CANCEL,
      }).catch(() => {});
    }

    console.error(`❌ [${accountName}:${fromUserId}] Claude 调用失败: ${err.message}`);

    // Send error notice to user
    try {
      await sendMessage({
        baseUrl, token,
        to: fromUserId,
        text: `⚠️ 处理消息时出错：${err.message.slice(0, 200)}`,
        contextToken: contextToken ?? getContextToken(fromUserId, accountName),
      });
    } catch {
      // Can't even send error message — give up
    }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}
