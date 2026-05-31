// Persistent storage for tokens and state — multi-account aware
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { STATE_DIR, CONFIGS_DIR } from "./types.mjs";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function configPath(name) {
  return path.join(CONFIGS_DIR, `${name}.json`);
}

function stateDir(name) {
  return path.join(STATE_DIR, name);
}

function syncBufPath(name) {
  return path.join(stateDir(name), "sync-buf.json");
}

function contextTokensPath(name) {
  return path.join(stateDir(name), "context-tokens.json");
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Lazy migration from old flat-file layout
// ---------------------------------------------------------------------------

const OLD_CONFIG_FILES = {
  "default": "config.json",
  "friend": "config-friend.json",
};

function migrateConfig(name) {
  const target = configPath(name);
  if (existsSync(target)) return;

  const oldFile = OLD_CONFIG_FILES[name];
  if (!oldFile) return;

  const oldPath = path.join(STATE_DIR, oldFile);
  if (!existsSync(oldPath)) return;

  ensureDir(CONFIGS_DIR);
  const data = readFileSync(oldPath, "utf-8");
  writeFileSync(target, data, "utf-8");
  console.log(`[store] 已将 ${oldFile} 迁移到 configs/${name}.json`);
}

function migrateStateFile(name, filename, legacyFilename) {
  const dir = stateDir(name);
  const target = path.join(dir, filename);
  if (existsSync(target)) return;

  const legacy = path.join(STATE_DIR, legacyFilename);
  if (!existsSync(legacy)) return;

  ensureDir(dir);
  const data = readFileSync(legacy, "utf-8");
  writeFileSync(target, data, "utf-8");
  console.log(`[store] 已将 ${legacyFilename} 迁移到 ${name}/${filename}`);
}

// ---------------------------------------------------------------------------
// Config (token, baseUrl, accountId, userId, systemPrompt?)
// ---------------------------------------------------------------------------

export function loadConfig(accountName = "default") {
  migrateConfig(accountName);
  try {
    const p = configPath(accountName);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch { return null; }
}

export function saveConfig(data, accountName = "default") {
  ensureDir(CONFIGS_DIR);
  const existing = loadConfig(accountName) ?? {};
  const next = {
    ...existing,
    ...(data.token ? { token: data.token, savedAt: new Date().toISOString() } : {}),
    ...(data.baseUrl ? { baseUrl: data.baseUrl } : {}),
    ...(data.accountId ? { accountId: data.accountId } : {}),
    ...(data.userId ? { userId: data.userId } : {}),
    ...(data.systemPrompt !== undefined ? { systemPrompt: data.systemPrompt } : {}),
  };
  writeFileSync(configPath(accountName), JSON.stringify(next, null, 2), "utf-8");
}

export function listAccounts() {
  const accounts = [];
  const seen = new Set();

  // New format: state/configs/*.json
  if (existsSync(CONFIGS_DIR)) {
    for (const f of readdirSync(CONFIGS_DIR)) {
      if (f.endsWith(".json")) {
        const name = f.replace(/\.json$/, "");
        seen.add(name);
        accounts.push({ name });
      }
    }
  }

  // Old format fallback (not yet migrated)
  if (!seen.has("default") && existsSync(path.join(STATE_DIR, "config.json"))) {
    accounts.push({ name: "default" });
  }
  if (!seen.has("friend") && existsSync(path.join(STATE_DIR, "config-friend.json"))) {
    accounts.push({ name: "friend" });
  }

  return accounts;
}

// ---------------------------------------------------------------------------
// Sync buffer (getUpdates cursor) — per-account
// ---------------------------------------------------------------------------

export function loadSyncBuf(accountName = "default") {
  if (accountName === "default") {
    migrateStateFile("default", "sync-buf.json", "sync-buf.json");
  }
  try {
    const p = syncBufPath(accountName);
    if (!existsSync(p)) return "";
    const data = JSON.parse(readFileSync(p, "utf-8"));
    return data.buf ?? "";
  } catch { return ""; }
}

export function saveSyncBuf(buf, accountName = "default") {
  if (!buf) return;
  const dir = stateDir(accountName);
  ensureDir(dir);
  writeFileSync(syncBufPath(accountName), JSON.stringify({ buf }), "utf-8");
}

// ---------------------------------------------------------------------------
// Context tokens (per-user conversation context) — per-account
// ---------------------------------------------------------------------------

export function loadContextTokens(accountName = "default") {
  if (accountName === "default") {
    migrateStateFile("default", "context-tokens.json", "context-tokens.json");
  }
  try {
    const p = contextTokensPath(accountName);
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch { return {}; }
}

export function getContextToken(userId, accountName = "default") {
  const tokens = loadContextTokens(accountName);
  return tokens[userId] ?? undefined;
}

export function setContextToken(userId, token, accountName = "default") {
  const dir = stateDir(accountName);
  ensureDir(dir);
  const tokens = loadContextTokens(accountName);
  tokens[userId] = token;
  writeFileSync(contextTokensPath(accountName), JSON.stringify(tokens, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Chat log (append-only JSONL) — per-account
// ---------------------------------------------------------------------------

function chatLogPath(accountName) {
  return path.join(stateDir(accountName), "chat-log.jsonl");
}

export function appendChatLog(accountName, entry) {
  const dir = stateDir(accountName);
  ensureDir(dir);
  const line = JSON.stringify({ ...entry, time: new Date().toISOString() }) + "\n";
  writeFileSync(chatLogPath(accountName), line, { flag: "a" });
}

export function readChatLog(accountName = "default", maxLines = 50) {
  try {
    const p = chatLogPath(accountName);
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, "utf-8").trim().split("\n").filter(Boolean);
    return lines.slice(-maxLines).map(l => JSON.parse(l));
  } catch { return []; }
}
