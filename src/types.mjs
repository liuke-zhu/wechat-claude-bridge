// iLink Bot protocol constants and types (mirrors proto definitions)

export const BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const ILINK_APP_ID = "bot";
export const BOT_TYPE = "3";
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

export const MessageType = { NONE: 0, USER: 1, BOT: 2 };
export const MessageItemType = {
  NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5,
};
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 };
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 };
export const TypingStatus = { TYPING: 1, CANCEL: 2 };

// Session expiration errcode from server
export const SESSION_EXPIRED_ERRCODE = -14;

import { fileURLToPath } from "node:url";
import path from "node:path";

// State directory for persistent data
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STATE_DIR = path.join(__dirname, "..", "state");
export const CONFIGS_DIR = path.join(STATE_DIR, "configs");
