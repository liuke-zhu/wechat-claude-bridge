#!/usr/bin/env node
// wechat-claude-bridge — Standalone bridge connecting Claude to WeChat
//
// Usage:
//   node index.mjs --login [--name <name>]          # QR code login
//   node index.mjs --login --force [--name <name>]   # Force re-login
//   node index.mjs                                    # Start bridge (all accounts)
//   node index.mjs --account <name>                   # Start bridge for one account
//   node index.mjs --list                             # List all accounts
//   node index.mjs --share [--name <name>]            # Generate share QR
//   node index.mjs --invite <wechatId> [--name <name>] # Send invite

import { mkdirSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { loginFlow } from "./src/auth.mjs";
import { startMonitor } from "./src/monitor.mjs";
import { startScheduler } from "./src/scheduler.mjs";
import { loadConfig, listAccounts, readChatLog } from "./src/store.mjs";
import { notifyStart, notifyStop, sendMessage } from "./src/api.mjs";
import { startWebServer } from "./src/web.mjs";
import { STATE_DIR } from "./src/types.mjs";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const flags = {
  login:  args.includes("--login"),
  force:  args.includes("--force"),
  share:  args.includes("--share"),
  invite: args.includes("--invite"),
  list:   args.includes("--list"),
  chatlog: args.includes("--log"),
  web:    args.includes("--web"),
  help:   args.includes("--help") || args.includes("-h"),
};

const accountArg = getArgValue("--account");
const nameArg     = getArgValue("--name");
const inviteTarget = getArgValue("--invite");
const logTarget   = getArgValue("--log");
const webPort     = parseInt(process.env.PORT || "3000", 10);

if (flags.help) {
  console.log(`
wechat-claude-bridge — 将 Claude AI 接入微信（多账号版）

用法:
  node index.mjs --login [--name <账号名>]    扫码登录微信 Bot
  node index.mjs --login --force [--name <账号名>] 强制重新登录
  node index.mjs --list                        列出所有已配置的账号
  node index.mjs --share [--name <账号名>]     生成分享二维码
  node index.mjs --invite <微信ID> [--name <账号名>] 主动发送邀请消息
  node index.mjs --log [<账号名>]              查看聊天记录（默认 default）
  node index.mjs --web                         启动网页管理 + 桥接（默认端口 3000）
  node index.mjs                              启动所有账号的消息桥接
  node index.mjs --account <账号名>            只启动指定账号的桥接

环境变量:
  ANTHROPIC_API_KEY   必需。Anthropic API key
  CLAUDE_MODEL        可选。默认 claude-sonnet-4-6
  CLAUDE_SYSTEM_PROMPT 可选。全局系统提示词（可被账号级覆盖）
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function doInvite(targetId, accountName) {
  const config = loadConfig(accountName);
  if (!config?.token) {
    console.error(`❌ 账号 "${accountName}" 未找到登录凭据。请先运行: node index.mjs --login --name ${accountName}`);
    process.exit(1);
  }

  if (!targetId) {
    console.error("❌ 请提供朋友的微信 ID。用法: node index.mjs --invite <微信ID> [--name <账号名>]");
    console.error("   朋友的微信 ID 格式类似: xxx@im.wechat");
    process.exit(1);
  }

  console.log(`[${accountName}] 正在向 ${targetId} 发送邀请...`);

  try {
    await sendMessage({
      baseUrl: config.baseUrl,
      token: config.token,
      to: targetId,
      text: "嗨！我是小鱼 🐟 你的朋友邀请我来跟你聊天～有什么想聊的都可以跟我说喔 ✨",
    });
    console.log("✅ 邀请消息已发送！朋友现在可以在微信里看到小鱼了。");
  } catch (err) {
    console.error(`❌ 发送失败: ${err.message}`);
    console.error("");
    console.error("可能的原因：");
    console.error("  1. 朋友的微信 ID 不正确（格式: xxx@im.wechat）");
    console.error("  2. 朋友没有在微信开放平台绑定该 bot");
    console.error("  3. 该 bot 平台不支持主动发起对话");
  }
}

async function doShare(accountName) {
  const config = loadConfig(accountName);
  if (!config?.accountId) {
    console.error(`❌ 账号 "${accountName}" 未找到登录凭据。请先运行: node index.mjs --login --name ${accountName}`);
    process.exit(1);
  }

  const botId = config.accountId;
  console.log(`[${accountName}] Bot ID: ${botId}\n`);

  mkdirSync(STATE_DIR, { recursive: true });
  const sharePath = path.join(STATE_DIR, `share-qr-${accountName}.png`);
  const shareUrl = `weixin://dl/chat?${encodeURIComponent(botId)}`;

  try {
    const QRCode = (await import("qrcode")).default;
    await QRCode.toFile(sharePath, shareUrl, {
      type: "png", width: 400, margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });

    try {
      const cmd = process.platform === "win32"
        ? `start "" "${sharePath}"`
        : process.platform === "darwin"
          ? `open "${sharePath}"`
          : `xdg-open "${sharePath}"`;
      execSync(cmd, { stdio: "ignore" });
    } catch {}
  } catch (err) {
    console.error("生成二维码失败:", err.message);
  }

  console.log(`📱 分享二维码已保存: ${sharePath}`);
  console.log("");
  console.log("分享方式（按推荐顺序）：");
  console.log("");
  console.log("  方式1: 把这个链接发到微信里给朋友，朋友在微信里点开：");
  console.log(`  ${shareUrl}`);
  console.log("");
  console.log("  方式2: 把二维码图片发给朋友，朋友长按扫码");
  console.log("");
  console.log("  方式3: 让朋友在微信搜索: " + botId);
  console.log("");
  console.log("  方式4: 拿到朋友的微信 ID 后运行:");
  console.log(`  node index.mjs --invite <朋友的微信ID> --name ${accountName}`);
}

// ---------------------------------------------------------------------------
// Bridge runner (per account)
// ---------------------------------------------------------------------------

async function runAccount(name, config, signal) {
  const { token, baseUrl, accountId, userId, systemPrompt: cfgPrompt } = config;

  console.log(`[${name}] Bot ID: ${accountId}`);
  if (userId) console.log(`[${name}] User ID: ${userId}`);

  // Notify WeChat backend
  try { await notifyStart({ baseUrl, token }); } catch {}

  // Resolve system prompt: account config > env var > built-in default
  const systemPrompt = cfgPrompt || process.env.CLAUDE_SYSTEM_PROMPT || undefined;

  // Start scheduler (fire-and-forget timer)
  startScheduler({
    token, baseUrl, userId, systemPrompt,
    accountName: name,
    abortSignal: signal,
  });

  // Start monitor (blocks until abort)
  await startMonitor({
    token, baseUrl, systemPrompt,
    accountName: name,
    abortSignal: signal,
    onStatus: (_status) => {},
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("🤖 wechat-claude-bridge v1.1.0\n");

  // --list: show accounts and exit
  if (flags.list) {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.log("没有找到任何账号。运行: node index.mjs --login [--name <账号名>]");
    } else {
      console.log("已配置的账号:");
      for (const a of accounts) {
        const cfg = loadConfig(a.name);
        const status = cfg?.token ? "✅" : "⚠️ 未登录";
        console.log(`  ${status} ${a.name}  →  ${cfg?.accountId ?? "(未登录)"}`);
      }
    }
    process.exit(0);
  }

  // --login mode
  if (flags.login) {
    const targetName = nameArg || "default";
    await loginFlow({ force: flags.force, name: targetName });
    console.log(`\n✅ 账号 "${targetName}" 登录完成！运行 node index.mjs 启动桥接。`);
    process.exit(0);
  }

  // --invite mode
  if (flags.invite) {
    const targetName = nameArg || "default";
    await doInvite(inviteTarget, targetName);
    process.exit(0);
  }

  // --share mode
  if (flags.share) {
    const targetName = nameArg || "default";
    await doShare(targetName);
    process.exit(0);
  }

  // --log mode: show chat history
  if (flags.chatlog) {
    const targetName = logTarget || nameArg || "default";
    const entries = readChatLog(targetName, 50);
    if (entries.length === 0) {
      console.log(`账号 "${targetName}" 暂无聊天记录。`);
    } else {
      console.log(`账号 "${targetName}" 最近 ${entries.length} 条聊天记录:\n`);
      for (const e of entries) {
        const arrow = e.dir === "in" ? "←" : "→";
        const tag = e.dir === "in" ? "对方" : "小鱼";
        console.log(`${e.time.slice(11, 19)} ${arrow} ${tag}: ${e.text.slice(0, 120)}`);
      }
    }
    process.exit(0);
  }

  // -----------------------------------------------------------------------
  // Bridge mode: start monitor + scheduler for one or all accounts
  // -----------------------------------------------------------------------

  // Resolve which account(s) to run
  let accountsToRun = [];

  if (accountArg && accountArg !== "all") {
    const cfg = loadConfig(accountArg);
    if (!cfg?.token) {
      console.error(`❌ 账号 "${accountArg}" 未找到或未登录。`);
      console.error("   运行 node index.mjs --list 查看所有账号。");
      process.exit(1);
    }
    accountsToRun = [{ name: accountArg }];
  } else {
    // "all" or no flag: run all accounts
    accountsToRun = listAccounts();
  }

  const hasAccounts = accountsToRun.length > 0;

  // When running with --web, always start web server even without accounts,
  // so the user can QR-login via the admin page.
  if (!hasAccounts && !flags.web) {
    console.error("❌ 未找到任何账号。请先运行: node index.mjs --login [--name <账号名>]");
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    if (flags.web) {
      console.warn("⚠️  未设置 ANTHROPIC_API_KEY。桥接功能将不可用，但仍可扫码登录。");
    } else {
      console.error("❌ 请设置 ANTHROPIC_API_KEY 环境变量。");
      console.error("   export ANTHROPIC_API_KEY=sk-ant-...");
      process.exit(1);
    }
  }

  console.log(`启动桥接: ${accountsToRun.map(a => a.name).join(", ")}`);
  console.log(`Claude Model: ${process.env.CLAUDE_MODEL || "claude-sonnet-4-6"}`);
  console.log("");

  const abortController = new AbortController();

  // Graceful shutdown — notifyStop for ALL accounts
  const shutdown = async () => {
    console.log("\n🛑 正在关闭...");
    abortController.abort();
    for (const a of accountsToRun) {
      const cfg = loadConfig(a.name);
      if (cfg?.token) {
        try { await notifyStop({ baseUrl: cfg.baseUrl, token: cfg.token }); } catch {}
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start web server if --web flag is set
  if (flags.web) {
    const webServer = startWebServer({ port: webPort });
    abortController.signal.addEventListener("abort", () => webServer.close(), { once: true });
  }

  // If no accounts, web server stays up for QR login; block forever
  if (!hasAccounts) {
    console.log("💡 请访问管理页面 http://localhost:" + webPort + " 扫码登录。");
    console.log("   Railway 用户请访问你的 .up.railway.app 域名。");
    // Keep process alive indefinitely (wait for SIGTERM)
    await new Promise(() => {});
    return;
  }

  // Start each account concurrently
  const tasks = accountsToRun.map(a => {
    const cfg = loadConfig(a.name);
    return runAccount(a.name, cfg, abortController.signal);
  });

  await Promise.all(tasks);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
