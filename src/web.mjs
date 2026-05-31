// Minimal web server — QR login page + dashboard (zero dependencies)
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fetchQRCode, pollQRStatus } from "./api.mjs";
import { saveConfig, loadConfig, listAccounts } from "./store.mjs";
import { BASE_URL, BOT_TYPE, STATE_DIR } from "./types.mjs";

// In-memory login session state
const sessions = new Map(); // qrcode → { qrcode, baseUrl, createdAt }

const QR_IMG_PATH = path.join(STATE_DIR, "login-qr.png");

// ---------------------------------------------------------------------------
// HTML templates
// ---------------------------------------------------------------------------

const STYLE = `
* { box-sizing:border-box; margin:0; padding:0 }
body { font-family:-apple-system,Segoe UI,sans-serif; background:#f0f2f5; color:#333; min-height:100vh; display:flex; justify-content:center; padding-top:60px }
.card { background:#fff; border-radius:12px; box-shadow:0 2px 12px rgba(0,0,0,.08); padding:32px; max-width:420px; width:90% }
h1 { font-size:24px; margin-bottom:8px }
h2 { font-size:18px; margin-bottom:16px }
.sub { color:#888; font-size:14px; margin-bottom:24px }
.btn { display:block; width:100%; padding:12px; border:none; border-radius:8px; font-size:16px; cursor:pointer; background:#07c160; color:#fff; margin:8px 0 }
.btn:disabled { opacity:.5; cursor:default }
.btn-outline { background:#fff; color:#07c160; border:1px solid #07c160 }
.qr-wrap { text-align:center; margin:16px 0 }
.qr-wrap img { width:240px; height:240px; border:1px solid #eee; border-radius:8px }
.status { text-align:center; font-size:15px; margin:12px 0; padding:8px; border-radius:6px }
.status.waiting { background:#fff3cd; color:#856404 }
.status.scanned { background:#cce5ff; color:#004085 }
.status.success { background:#d4edda; color:#155724 }
.status.error { background:#f8d7da; color:#721c24 }
.code-input { display:flex; gap:8px; margin:12px 0 }
.code-input input { flex:1; padding:10px; border:1px solid #ddd; border-radius:6px; font-size:18px; text-align:center; letter-spacing:4px }
.hidden { display:none !important }
.account-row { display:flex; align-items:center; gap:12px; padding:12px 0; border-bottom:1px solid #eee }
.dot { width:10px; height:10px; border-radius:50%; display:inline-block }
.dot.on { background:#07c160 }
.dot.off { background:#ccc }
.acct-info { flex:1 }
.acct-id { font-size:13px; color:#888 }
.back-link { display:block; margin-top:20px; text-align:center; color:#07c160; text-decoration:none; font-size:14px }
`;

function page(title, body) {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

function loginPage(error) {
  return page("扫码登录", `
<div class="card">
  <h1>🤖 wechat-claude-bridge</h1>
  <p class="sub">扫码登录微信 Bot</p>
  ${error ? `<div class="status error">${error}</div>` : ""}
  <div id="step-start">
    <input id="acct-name" type="text" placeholder="输入账号名（例如: default、friend、朋友名字）" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:15px;margin-bottom:8px" value="">
    <p style="font-size:12px;color:#999;margin-bottom:8px">新名字会自动创建独立账号，互不干扰</p>
    <button class="btn" onclick="startLogin()">获取登录二维码</button>
    <a class="back-link" href="/dashboard">查看已登录账号 →</a>
  </div>
  <div id="step-qr" class="hidden">
    <div class="qr-wrap"><img id="qr-img" src="" alt="QR Code"></div>
    <div id="status" class="status waiting">⏳ 请用微信扫描二维码...</div>
    <div id="code-box" class="code-input hidden">
      <input id="code-inp" type="text" maxlength="6" placeholder="输入6位数字" inputmode="numeric">
      <button class="btn" style="width:auto" onclick="submitCode()">确认</button>
    </div>
    <button class="btn btn-outline hidden" id="retry-btn" onclick="resetLogin()">重新获取</button>
    <a class="back-link" href="/dashboard">查看已登录账号 →</a>
  </div>
</div>
<script>
let currentQrcode = "";
let pollTimer = null;
let accountName = "default";

async function startLogin() {
  accountName = document.getElementById("acct-name").value.trim() || "default";
  document.getElementById("step-start").classList.add("hidden");
  document.getElementById("step-qr").classList.remove("hidden");
  document.getElementById("status").textContent = "⏳ 正在获取二维码...";
  document.getElementById("status").className = "status waiting";
  document.getElementById("code-box").classList.add("hidden");
  document.getElementById("retry-btn").classList.add("hidden");

  try {
    const r = await fetch("/api/start-login?name=" + encodeURIComponent(accountName), { method: "POST" });
    if (!r.ok) { const t = await r.text(); showError(t); return; }
    const data = await r.json();
    currentQrcode = data.qrcode;
    document.getElementById("qr-img").src = "/qr.png?t=" + Date.now();
    document.getElementById("status").textContent = "⏳ 请用微信扫描二维码...";
    document.getElementById("status").className = "status waiting";
    pollTimer = setInterval(pollStatus, 2000);
  } catch(e) {
    showError("网络错误: " + e.message);
  }
}

async function pollStatus() {
  try {
    const r = await fetch("/api/poll", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ qrcode: currentQrcode, verifyCode: window._pendingCode || "" })
    });
    window._pendingCode = "";
    if (!r.ok) { const t = await r.text(); showError(t); return; }
    const data = await r.json();
    const el = document.getElementById("status");

    switch(data.status) {
      case "wait":
        el.textContent = "⏳ 请用微信扫描二维码...";
        el.className = "status waiting";
        document.getElementById("code-box").classList.add("hidden");
        break;
      case "scaned":
        el.textContent = "✅ 已扫码，请在手机上确认...";
        el.className = "status scanned";
        document.getElementById("code-box").classList.add("hidden");
        break;
      case "need_verifycode":
        el.textContent = data.message || "请输入手机微信显示的6位数字";
        el.className = "status waiting";
        document.getElementById("code-box").classList.remove("hidden");
        document.getElementById("code-inp").focus();
        break;
      case "confirmed":
        el.textContent = "🎉 登录成功！Bot ID: " + data.accountId;
        el.className = "status success";
        document.getElementById("code-box").classList.add("hidden");
        clearInterval(pollTimer);
        setTimeout(() => location.href = "/dashboard", 2000);
        break;
      case "expired":
        el.textContent = "⏰ 二维码已过期，请重新获取";
        el.className = "status error";
        document.getElementById("retry-btn").classList.remove("hidden");
        clearInterval(pollTimer);
        break;
      default:
        el.textContent = data.status + ": " + (data.message || "");
        el.className = "status error";
    }
  } catch(e) {
    // ignore poll errors silently, will retry
  }
}

function submitCode() {
  const code = document.getElementById("code-inp").value.trim();
  if (code.length !== 6) return;
  window._pendingCode = code;
  document.getElementById("code-inp").value = "";
  pollStatus();
}

function resetLogin() {
  clearInterval(pollTimer);
  currentQrcode = "";
  document.getElementById("step-qr").classList.add("hidden");
  document.getElementById("step-start").classList.remove("hidden");
}

function showError(msg) {
  document.getElementById("step-qr").classList.add("hidden");
  document.getElementById("step-start").classList.remove("hidden");
  // Try to inject error
  const card = document.querySelector(".card");
  let errDiv = document.getElementById("err-msg");
  if (!errDiv) {
    errDiv = document.createElement("div");
    errDiv.id = "err-msg";
    errDiv.className = "status error";
    errDiv.style.marginBottom = "12px";
    card.insertBefore(errDiv, card.firstChild.nextSibling);
  }
  errDiv.textContent = msg;
  clearInterval(pollTimer);
}

document.getElementById("code-inp").addEventListener("keydown", e => {
  if (e.key === "Enter") submitCode();
});
</script>`);
}

function dashboardPage() {
  const accounts = listAccounts();
  let rows = "";
  for (const a of accounts) {
    const cfg = loadConfig(a.name);
    const online = !!cfg?.token;
    rows += `
    <div class="account-row">
      <span class="dot ${online ? "on" : "off"}"></span>
      <div class="acct-info">
        <strong>${a.name}</strong>
        <div class="acct-id">${cfg?.accountId || "未登录"}${cfg?.userId ? " · " + cfg.userId : ""}</div>
      </div>
      <span style="font-size:13px;color:#888">${online ? "✅" : "未登录"}</span>
    </div>`;
  }

  return page("控制面板", `
<div class="card">
  <h1>🤖 控制面板</h1>
  <p class="sub">wechat-claude-bridge v1.2.0</p>
  ${rows || "<p style='color:#888'>暂无账号</p>"}
  <a href="/"><button class="btn btn-outline" style="margin-top:16px">+ 添加账号</button></a>
  <a class="back-link" href="/">返回登录 →</a>
</div>`);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function text(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function html(res, body) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function serveFile(res, filePath, mime) {
  try {
    if (!existsSync(filePath)) { res.writeHead(404); res.end("Not Found"); return; }
    const data = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(500);
    res.end("Internal Error");
  }
}

async function handleAPI(req, res, url) {
  const { pathname, searchParams } = url;

  // POST /api/start-login?name=xxx
  if (pathname === "/api/start-login" && req.method === "POST") {
    const name = searchParams.get("name") || "default";
    try {
      const qrResp = await fetchQRCode({ botType: BOT_TYPE, localTokenList: [] });
      if (!qrResp.qrcode || !qrResp.qrcode_img_content) {
        text(res, "获取二维码失败", 502);
        return;
      }

      // Generate QR PNG
      const QRCode = (await import("qrcode")).default;
      mkdirSync(STATE_DIR, { recursive: true });
      await QRCode.toFile(QR_IMG_PATH, qrResp.qrcode_img_content, {
        type: "png", width: 400, margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });

      sessions.set(qrResp.qrcode, {
        qrcode: qrResp.qrcode,
        baseUrl: BASE_URL,
        accountName: name,
        createdAt: Date.now(),
      });

      json(res, { qrcode: qrResp.qrcode, qrcodeUrl: qrResp.qrcode_img_content, accountName: name });
    } catch (err) {
      text(res, "获取二维码失败: " + err.message, 502);
    }
    return;
  }

  // POST /api/poll { qrcode, verifyCode? }
  if (pathname === "/api/poll" && req.method === "POST") {
    const body = await readBody(req);
    let data;
    try { data = JSON.parse(body); } catch { text(res, "Invalid JSON", 400); return; }

    const { qrcode, verifyCode } = data;
    if (!qrcode) { text(res, "Missing qrcode", 400); return; }

    const session = sessions.get(qrcode);
    if (!session) { json(res, { status: "expired", message: "Session not found" }); return; }

    try {
      const statusResp = await pollQRStatus({
        baseUrl: session.baseUrl,
        qrcode,
        verifyCode: verifyCode || "",
      });

      const status = statusResp.status;

      // On confirmed, save config
      if (status === "confirmed" && statusResp.bot_token) {
        saveConfig({
          token: statusResp.bot_token,
          accountId: statusResp.ilink_bot_id,
          baseUrl: statusResp.baseurl || BASE_URL,
          userId: statusResp.ilink_user_id,
        }, session.accountName);

        sessions.delete(qrcode);

        json(res, {
          status: "confirmed",
          accountId: statusResp.ilink_bot_id,
          userId: statusResp.ilink_user_id,
        });
        return;
      }

      if (status === "scaned" && statusResp.ilink_user_id) {
        json(res, {
          status: "scaned",
          message: "已扫码，请在手机上确认",
          ilinkUserId: statusResp.ilink_user_id,
        });
        return;
      }

      if (status === "need_verifycode") {
        json(res, { status: "need_verifycode", message: "请输入手机微信显示的6位数字" });
        return;
      }

      if (status === "expired") {
        sessions.delete(qrcode);
        json(res, { status: "expired", message: "二维码已过期" });
        return;
      }

      json(res, { status: status || "unknown" });
    } catch (err) {
      json(res, { status: "error", message: err.message });
    }
    return;
  }

  // Not found
  text(res, "Not Found", 404);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

export function startWebServer({ port = 3000 } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    try {
      // API routes
      if (url.pathname.startsWith("/api/")) {
        await handleAPI(req, res, url);
        return;
      }

      // Static routes
      if (url.pathname === "/qr.png") {
        serveFile(res, QR_IMG_PATH, "image/png");
        return;
      }

      if (url.pathname === "/dashboard") {
        html(res, dashboardPage());
        return;
      }

      if (url.pathname === "/" || url.pathname === "/login") {
        html(res, loginPage());
        return;
      }

      text(res, "Not Found", 404);
    } catch (err) {
      console.error("[web]", err.message);
      text(res, "Internal Error: " + err.message, 500);
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[web] 管理页面: http://0.0.0.0:${port}`);
    console.log(`[web] 控制面板: http://0.0.0.0:${port}/dashboard`);
  });

  return server;
}
