// Daily greeting scheduler — checks every 30 min, greets at configured times
import { chatWithClaude } from "./claude.mjs";
import { sendMessage } from "./api.mjs";
import { getContextToken } from "./store.mjs";
import { BASE_URL } from "./types.mjs";

// Greeting window (local time): one per day
const GREETING_SLOTS = [
  { hour: 8, minuteMin: 0, minuteMax: 59, label: "早安" },
];

const CHECK_INTERVAL_MS = 30 * 60_000; // 30 minutes

/**
 * Start the daily greeting scheduler for a specific account.
 * Runs independently alongside the monitor loop.
 */
export function startScheduler({
  token, baseUrl = BASE_URL, abortSignal,
  accountName = "default",
  userId,
  systemPrompt,
}) {
  if (!userId) {
    console.log(`[scheduler:${accountName}] 没有 userId，跳过定时问候`);
    return;
  }

  const lastGreeted = {};

  async function checkAndGreet() {
    if (abortSignal?.aborted) return;

    const now = new Date();
    const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const hour = now.getHours();
    const minute = now.getMinutes();

    for (const slot of GREETING_SLOTS) {
      if (hour !== slot.hour) continue;
      if (minute < slot.minuteMin || minute > slot.minuteMax) continue;

      const key = `${today}-${slot.label}`;
      if (lastGreeted[key]) continue;

      lastGreeted[key] = true;
      console.log(`[scheduler:${accountName}] 发送${slot.label}问候...`);

      try {
        const greetingPrompt = "早上好。现在是你的问候时间。用高冷简洁的语气，一句话问候对方即可。不用太热情，点到为止。";

        const replyText = await chatWithClaude({
          userId: `${userId}-greeting`,
          userMessage: greetingPrompt,
          accountName,
          systemPrompt,
          onChunk: () => {},
        });

        await sendMessage({
          baseUrl, token,
          to: userId,
          text: replyText,
          contextToken: getContextToken(userId, accountName),
        });

        console.log(`[scheduler:${accountName}] ${slot.label}问候已发送`);
      } catch (err) {
        console.error(`[scheduler:${accountName}] ${slot.label}问候发送失败: ${err.message}`);
        lastGreeted[key] = false; // Allow retry
      }
    }
  }

  // Check immediately on start, then every 30 min
  checkAndGreet();
  const timer = setInterval(checkAndGreet, CHECK_INTERVAL_MS);

  abortSignal?.addEventListener("abort", () => {
    clearInterval(timer);
  }, { once: true });

  console.log(`[scheduler:${accountName}] 定时问候已启动 (每天 8:00)`);
}
