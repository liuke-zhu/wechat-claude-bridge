// iLink Bot API client — all HTTP communication with WeChat backend
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASE_URL,
  ILINK_APP_ID,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
} from "./types.mjs";

// ---------------------------------------------------------------------------
// Package metadata (version for headers)
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function readVersion() {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? "1.0.0";
  } catch { return "1.0.0"; }
}
const CHANNEL_VERSION = readVersion();

// ---------------------------------------------------------------------------
// Header builders
// ---------------------------------------------------------------------------
function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildCommonHeaders() {
  const v = CHANNEL_VERSION;
  const parts = v.split(".").map(Number);
  const clientVer = ((parts[0] & 0xff) << 16) | ((parts[1] & 0xff) << 8) | ((parts[2] || 0) & 0xff);
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(clientVer),
  };
}

function buildHeaders(token) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function buildBaseInfo(botAgent = "ClaudeBridge/1.0") {
  return { channel_version: CHANNEL_VERSION, bot_agent: botAgent };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

async function apiPost({ baseUrl, endpoint, body, token, timeoutMs, abortSignal }) {
  const base = ensureTrailingSlash(baseUrl);
  const url = new URL(endpoint, base);
  const controller = timeoutMs ? new AbortController() : null;
  const t = controller && timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify(body),
      signal: controller?.signal ?? abortSignal ?? undefined,
    });
    if (t) clearTimeout(t);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return JSON.parse(text);
  } finally {
    if (t) clearTimeout(t);
  }
}

async function apiGet({ baseUrl, endpoint, timeoutMs }) {
  const base = ensureTrailingSlash(baseUrl);
  const url = new URL(endpoint, base);
  const controller = timeoutMs ? new AbortController() : null;
  const t = controller && timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: buildCommonHeaders(),
      signal: controller?.signal ?? undefined,
    });
    if (t) clearTimeout(t);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return JSON.parse(text);
  } finally {
    if (t) clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// API endpoints
// ---------------------------------------------------------------------------

/** Long-poll for new messages. Returns empty msgs[] on timeout. */
export async function getUpdates({ baseUrl, token, getUpdatesBuf = "", timeoutMs, abortSignal }) {
  const t = timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    return await apiPost({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: { get_updates_buf: getUpdatesBuf, base_info: buildBaseInfo() },
      token,
      timeoutMs: t,
      abortSignal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

/** Send a text message to a user. */
export async function sendMessage({ baseUrl, token, to, text, contextToken, runId }) {
  const items = text ? [{ type: 1, text_item: { text } }] : [];
  return apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: crypto.randomUUID(),
        message_type: 2,    // BOT
        message_state: 2,   // FINISH
        ...(items.length ? { item_list: items } : {}),
        ...(contextToken ? { context_token: contextToken } : {}),
        ...(runId ? { run_id: runId } : {}),
      },
      base_info: buildBaseInfo(),
    },
    token,
    timeoutMs: 15_000,
  });
}

/** Send typing indicator. */
export async function sendTyping({ baseUrl, token, ilinkUserId, typingTicket, status }) {
  return apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: {
      ilink_user_id: ilinkUserId,
      typing_ticket: typingTicket,
      status,
      base_info: buildBaseInfo(),
    },
    token,
    timeoutMs: 10_000,
  });
}

/** Get account config (typing ticket). */
export async function getConfig({ baseUrl, token, ilinkUserId, contextToken }) {
  return apiPost({
    baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: {
      ilink_user_id: ilinkUserId,
      ...(contextToken ? { context_token: contextToken } : {}),
      base_info: buildBaseInfo(),
    },
    token,
    timeoutMs: 10_000,
  });
}

/** Get CDN upload pre-signed URL. */
export async function getUploadUrl({ baseUrl, token, filekey, mediaType, toUserId,
  rawSize, rawMd5, fileSize, thumbRawSize, thumbRawMd5, thumbFileSize, aesKey }) {
  return apiPost({
    baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: rawSize,
      rawfilemd5: rawMd5,
      filesize: fileSize,
      ...(thumbRawSize != null ? { thumb_rawsize: thumbRawSize } : {}),
      ...(thumbRawMd5 ? { thumb_rawfilemd5: thumbRawMd5 } : {}),
      ...(thumbFileSize != null ? { thumb_filesize: thumbFileSize } : {}),
      aeskey: aesKey,
      base_info: buildBaseInfo(),
    },
    token,
    timeoutMs: 15_000,
  });
}

/** Notify server that this client is starting. */
export async function notifyStart({ baseUrl, token }) {
  return apiPost({
    baseUrl,
    endpoint: "ilink/bot/msg/notifystart",
    body: { base_info: buildBaseInfo() },
    token,
    timeoutMs: 10_000,
  }).catch(() => ({})); // Non-critical
}

/** Notify server that this client is stopping. */
export async function notifyStop({ baseUrl, token }) {
  return apiPost({
    baseUrl,
    endpoint: "ilink/bot/msg/notifystop",
    body: { base_info: buildBaseInfo() },
    token,
    timeoutMs: 10_000,
  }).catch(() => ({})); // Non-critical
}

// ---------------------------------------------------------------------------
// QR code login endpoints (no auth required)
// ---------------------------------------------------------------------------

/** Fetch a QR code for login. */
export async function fetchQRCode({ baseUrl = BASE_URL, botType = "3", localTokenList = [] }) {
  return apiPost({
    baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: { local_token_list: localTokenList },
  });
}

/** Poll QR code scan status (long-poll, returns wait on timeout). */
export async function pollQRStatus({ baseUrl = BASE_URL, qrcode, verifyCode }) {
  try {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    return await apiGet({ baseUrl, endpoint, timeoutMs: 35_000 });
  } catch {
    return { status: "wait" };
  }
}

// ---------------------------------------------------------------------------
// Voice message download + transcription
// ---------------------------------------------------------------------------

/** Download a voice file from WeChat CDN. Returns raw audio buffer. */
export async function downloadVoice({ baseUrl, token, voiceUrl, aesKey }) {
  // Build CDN download URL — voiceUrl may be relative or absolute
  let url = voiceUrl;
  if (url && !url.startsWith("http")) {
    url = `https://novac2c.cdn.weixin.qq.com/c2c/${url.replace(/^\//, "")}`;
  }

  const headers = buildHeaders(token);
  delete headers["Content-Type"]; // GET request, no body

  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) throw new Error(`Voice download failed: HTTP ${res.status}`);

  let buffer = Buffer.from(await res.arrayBuffer());

  // Decrypt if AES key is provided (AES-128-ECB)
  if (aesKey && buffer.length > 0) {
    try {
      const key = Buffer.from(aesKey, "hex").slice(0, 16);
      const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
      decipher.setAutoPadding(true);
      buffer = Buffer.concat([decipher.update(buffer), decipher.final()]);
    } catch {
      // If decryption fails, return raw buffer (maybe unencrypted)
    }
  }

  return buffer;
}

/** Get Alibaba Cloud NLS access token using AK/SK signing. */
async function getAliToken(accessKeyId, accessKeySecret) {
  const url = "https://nls-meta.cn-shanghai.aliyuncs.com/pop/2018-05-18/tokens";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `acs ${accessKeyId}:${accessKeySecret}`,
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`获取阿里云 Token 失败: HTTP ${res.status} — ${t}`);
  }
  const data = await res.json();
  if (data.ErrMsg) throw new Error(`阿里云 Token 错误: ${data.ErrMsg}`);
  return data.Token.Id;
}

/** Transcribe voice using Alibaba Cloud NLS (free 5000 calls/month) or OpenAI Whisper fallback. */
export async function transcribeVoice(audioBuffer) {
  const aliKey = process.env.ALIBABA_ACCESS_KEY_ID;
  const aliSecret = process.env.ALIBABA_ACCESS_KEY_SECRET;

  // Prefer Alibaba Cloud (free)
  if (aliKey && aliSecret) {
    const token = await getAliToken(aliKey, aliSecret);
    const appKey = process.env.ALIBABA_NLS_APP_KEY || "nls-service-short-asr-16k";

    const res = await fetch(
      `https://nls-gateway.cn-shanghai.aliyuncs.com/stream/v1/FlashRecognizer?appkey=${appKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-NLS-Token": token,
        },
        body: audioBuffer,
      }
    );

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`阿里云语音识别失败: HTTP ${res.status} — ${t}`);
    }

    const data = await res.json();
    if (data.status !== 20000000) {
      throw new Error(`阿里云语音识别失败: ${data.status_text || JSON.stringify(data)}`);
    }
    return data.result || "";
  }

  // Fallback to OpenAI Whisper
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("请设置 ALIBABA_ACCESS_KEY_ID + ALIBABA_ACCESS_KEY_SECRET 或 OPENAI_API_KEY");

  const { mkdirSync, writeFileSync, unlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");

  const tmpPath = path.join(tmpdir(), `wx-voice-${Date.now()}.amr`);
  mkdirSync(tmpdir(), { recursive: true });
  writeFileSync(tmpPath, audioBuffer);

  try {
    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("file", new Blob([audioBuffer], { type: "audio/amr" }), "voice.amr");
    form.append("language", "zh");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Whisper API 失败: HTTP ${res.status} — ${errText}`);
    }

    const data = await res.json();
    return data.text?.trim() || "";
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}
