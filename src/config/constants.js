import path from "path";

export const ROOT = process.cwd();

// Broadcast
export const DELAY_MS = 55;
export const BROADCAST_CMD = /^\/broadcast(?:\s+([\s\S]+))?$/;

// Welcome defaults
export const DEFAULT_WELCOME =
  "Thanks for starting the bot. How can I help you today?";
export const DEFAULT_REACH_BUTTON_TEXT = "Reach";
export const DEFAULT_RANDOM_CHANNEL_BUTTON_TEXT = "Random Channel";
export const DEFAULT_RANDOM_CHANNEL_URLS = [
  "https://t.me/durov",
  "https://t.me/telegram",
  "https://t.me/telegramtips",
];

// Daily scheduler send times
export const DEFAULT_DAILY_SEND_TIMES = [
  { key: "morning", hour: 9, minute: 0 },
  { key: "afternoon", hour: 16, minute: 30 },
  { key: "night", hour: 20, minute: 30 },
];

// Admin panel
export const PANEL_PORT = Number(process.env.PANEL_PORT ?? "3000");
export const PANEL_HOST = String(process.env.PANEL_HOST ?? "127.0.0.1").trim();
export const PANEL_USERNAME = String(process.env.PANEL_USERNAME ?? "admin").trim();
export const PANEL_PASSWORD = String(process.env.PANEL_PASSWORD ?? "").trim();
export const PANEL_MAX_FAILED_ATTEMPTS = 3;

// File paths
export const TEMPLATES_DIR = path.join(ROOT, "templates");
export const ADMIN_LOGIN_STATE_FILE = path.join(ROOT, "data", "admin-login-state.json");
export const BROADCAST_LOG_FILE = path.join(ROOT, "data", "broadcast-log.json");

// Database
export const PG_CONNECTION_STRING = String(process.env.DATABASE_URL ?? "").trim();

// Message template limits
export const MESSAGE_TEMPLATE_TITLE_MAX = 120;
export const MESSAGE_TEMPLATE_BODY_MAX = 4096;
export const MESSAGE_TEMPLATE_IMAGE_MAX = 2000;
