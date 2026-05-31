// QR code login flow for WeChat iLink Bot
import { mkdirSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { fetchQRCode, pollQRStatus } from "./api.mjs";
import { saveConfig, loadConfig } from "./store.mjs";
import { BASE_URL, BOT_TYPE, STATE_DIR } from "./types.mjs";

// Ensure state directory exists
mkdirSync(STATE_DIR, { recursive: true });

const LOGIN_TIMEOUT_MS = 480_000; // 8 minutes
const MAX_QR_REFRESH = 3;

/**
 * Display QR code as a PNG image file (opens with system viewer).
 * Also renders in terminal as fallback.
 */
async function displayQRCode(qrcodeUrl) {
  // 1. Generate PNG image to disk
  const imgPath = path.join(STATE_DIR, "login-qr.png");
  try {
    const QRCode = (await import("qrcode")).default;
    await QRCode.toFile(imgPath, qrcodeUrl, {
      type: "png",
      width: 400,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });
    console.log(`📱 QR 码图片已保存: ${imgPath}`);
    // Try to open with system viewer
    try {
      const cmd = process.platform === "win32"
        ? `start "" "${imgPath}"`
        : process.platform === "darwin"
          ? `open "${imgPath}"`
          : `xdg-open "${imgPath}"`;
      execSync(cmd, { stdio: "ignore" });
      console.log("   图片已自动打开，请用微信扫描。");
    } catch {
      console.log("   请手动打开该图片文件，用微信扫描。");
    }
  } catch (imgErr) {
    console.log(`QR 图片生成失败: ${imgErr.message}`);
  }

  // 2. Terminal rendering as backup
  try {
    const qrterm = (await import("qrcode-terminal")).default;
    qrterm.generate(qrcodeUrl, { small: true });
  } catch {
    // qrcode-terminal may not work on all terminals
  }

  // 3. The liteapp URL (only works inside WeChat — send to yourself in WeChat first)
  console.log(`\n🔗 微信内打开: ${qrcodeUrl}`);
  console.log(`   (将此链接发到微信聊天中，在微信内点击打开)\n`);
}

/**
 * Read a line from stdin.
 */
function readLine(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    const onData = (chunk) => {
      const str = chunk.toString();
      if (str.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(str.trim());
      }
    };
    process.stdin.on("data", onData);
  });
}

/**
 * Full QR code login flow. Returns { token, accountId, baseUrl, userId } on success.
 */
export async function loginFlow({ force = false, name = "default" } = {}) {
  // Check existing config
  if (!force) {
    const existing = loadConfig(name);
    if (existing?.token) {
      console.log(`✅ 账号 "${name}" 已有登录凭据，无需重复登录。使用 --force 强制重新登录。`);
      return existing;
    }
  }

  console.log("正在获取登录二维码...\n");
  const localTokens = loadConfig(name)?.token ? [loadConfig(name).token] : [];
  const qrResp = await fetchQRCode({ botType: BOT_TYPE, localTokenList: localTokens });

  if (!qrResp.qrcode || !qrResp.qrcode_img_content) {
    throw new Error("获取二维码失败: " + JSON.stringify(qrResp));
  }

  const qrcode = qrResp.qrcode;
  const qrcodeUrl = qrResp.qrcode_img_content;

  await displayQRCode(qrcodeUrl);
  console.log("⏳ 请用手机微信扫描二维码...\n");

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let scannedPrinted = false;
  let qrRefreshCount = 1;
  let currentBaseUrl = BASE_URL;
  let pendingVerifyCode = "";

  while (Date.now() < deadline) {
    const statusResp = await pollQRStatus({ baseUrl: currentBaseUrl, qrcode, verifyCode: pendingVerifyCode });
    const status = statusResp.status;

    switch (status) {
      case "wait":
        process.stdout.write(".");
        break;

      case "scaned":
        // If we had a pending verify code and got scaned, it was accepted
        if (pendingVerifyCode) {
          pendingVerifyCode = "";
        }
        if (!scannedPrinted) {
          process.stdout.write("\n✅ 已扫码，正在确认...\n");
          // Log the full response to potentially capture the scanner's user ID
          if (statusResp.ilink_user_id) {
            console.log(`   📋 扫码者 ID: ${statusResp.ilink_user_id}`);
          }
          console.log(`   📋 完整响应: ${JSON.stringify(statusResp)}`);
          scannedPrinted = true;
        }
        break;

      case "need_verifycode": {
        const prompt = pendingVerifyCode
          ? "❌ 数字不匹配，请重新输入: "
          : "请输入手机微信显示的6位数字: ";
        pendingVerifyCode = await readLine(prompt);
        // Immediately poll again with the verify code
        continue;
      }

      case "expired": {
        qrRefreshCount++;
        if (qrRefreshCount > MAX_QR_REFRESH) {
          throw new Error("二维码多次失效，请稍后重试。");
        }
        console.log(`\n⏳ 二维码已过期，正在刷新 (${qrRefreshCount}/${MAX_QR_REFRESH})...`);
        const newQr = await fetchQRCode({ botType: BOT_TYPE, localTokenList: localTokens });
        await displayQRCode(newQr.qrcode_img_content);
        console.log("🔄 二维码已更新，请重新扫描。\n");
        scannedPrinted = false;
        break;
      }

      case "scaned_but_redirect": {
        if (statusResp.redirect_host) {
          currentBaseUrl = `https://${statusResp.redirect_host}`;
          console.log(`🔄 重定向到: ${currentBaseUrl}`);
        }
        break;
      }

      case "confirmed": {
        if (!statusResp.ilink_bot_id) {
          throw new Error("登录失败：服务器未返回 bot ID。");
        }
        const result = {
          token: statusResp.bot_token,
          accountId: statusResp.ilink_bot_id,
          baseUrl: statusResp.baseurl || BASE_URL,
          userId: statusResp.ilink_user_id,
        };
        saveConfig(result, name);
        console.log(`\n✅ 登录成功！账号 "${name}" | Bot ID: ${result.accountId}`);
        return result;
      }

      case "binded_redirect":
        console.log("\n✅ 此 bot 已绑定，无需重复连接。");
        return loadConfig(name); // Return existing config

      case "verify_code_blocked":
        throw new Error("验证码多次错误，请稍后重试。");

      default:
        console.log(`未知状态: ${status}`);
        break;
    }

    await sleep(1000);
  }

  throw new Error("登录超时，请重试。");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
