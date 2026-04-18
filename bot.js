import "dotenv/config";
import fs from "fs";
import http from "http";
import path from "path";
import crypto from "crypto";
import TelegramBot from "node-telegram-bot-api";
import XLSX from "xlsx";
import Database from "better-sqlite3";

const ROOT = process.cwd();

const DELAY_MS = 55;
const DEFAULT_WELCOME =
  "Thanks for starting the bot. How can I help you today?";
const DEFAULT_REACH_BUTTON_TEXT = "Reach";
const DEFAULT_RANDOM_CHANNEL_BUTTON_TEXT = "Random Channel";
const DEFAULT_RANDOM_CHANNEL_URLS = [
  "https://t.me/durov",
  "https://t.me/telegram",
  "https://t.me/telegramtips",
];
const DEFAULT_DAILY_SEND_TIMES = [
  { key: "morning", hour: 9, minute: 0 },
  { key: "afternoon", hour: 16, minute: 30 },
  { key: "night", hour: 20, minute: 30 },
];
const PANEL_PORT = Number(process.env.PANEL_PORT ?? "3000");
const PANEL_HOST = String(process.env.PANEL_HOST ?? "127.0.0.1").trim();
const PANEL_USERNAME = String(process.env.PANEL_USERNAME ?? "admin").trim();
const PANEL_PASSWORD = String(process.env.PANEL_PASSWORD ?? "").trim();
const PANEL_MAX_FAILED_ATTEMPTS = 3;
const DB_FILE = path.join(ROOT, "data", "config.sqlite");
const TEMPLATES_DIR = path.join(ROOT, "templates");
const ADMIN_LOGIN_STATE_FILE = path.join(ROOT, "data", "admin-login-state.json");
const BROADCAST_LOG_FILE = path.join(ROOT, "data", "broadcast-log.json");

function parseAdminIds(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

function normalizeHeaderKey(k) {
  return String(k)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function parseUrlList(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((url) => /^https?:\/\//i.test(url));
}

function parseWelcomeButtons(norm) {
  const buttons = [];

  const inlinePairs = [
    ["button_1_text", "button_1_url", "button_1_row"],
    ["button_2_text", "button_2_url", "button_2_row"],
    ["button_3_text", "button_3_url", "button_3_row"],
    ["button_4_text", "button_4_url", "button_4_row"],
    ["button_5_text", "button_5_url", "button_5_row"],
  ];

  for (const [textKey, urlKey, rowKey] of inlinePairs) {
    const text = String(norm[textKey] ?? "").trim();
    const url = String(norm[urlKey] ?? "").trim();
    if (text && /^https?:\/\//i.test(url)) {
      const perRow = parseButtonsPerRow(norm[rowKey], 0);
      buttons.push(perRow >= 1 && perRow <= 3 ? { text, url, perRow } : { text, url });
    }
  }

  const rawList = String(
    norm.welcome_buttons ?? norm.buttons ?? norm.inline_buttons ?? ""
  ).trim();
  if (!rawList) return buttons;

  for (const item of rawList.split(",")) {
    const [textRaw, urlRaw] = item.split("|");
    const text = String(textRaw ?? "").trim();
    const url = String(urlRaw ?? "").trim();
    if (text && /^https?:\/\//i.test(url)) {
      buttons.push({ text, url });
    }
  }

  return buttons;
}

function parseButtonsPerRow(raw, fallback = 2) {
  const n = Number(raw);
  if (Number.isNaN(n)) return fallback;
  return Math.max(1, Math.min(3, Math.floor(n)));
}

/** Map Excel row to bot config (incl. optional welcome_image). */
function rowToConfig(row, index) {
  const norm = {};
  for (const [k, v] of Object.entries(row)) {
    norm[normalizeHeaderKey(k)] = v;
  }

  const nameRaw =
    norm.name ??
    norm.bot_name ??
    norm.botname ??
    norm.z ??
    `bot_${index + 1}`;
  const token = String(
    norm.bot_token ?? norm.token ?? norm.bot_api ?? ""
  ).trim();
  const adminsRaw =
    norm.admin_ids ??
    norm.admin_telegram_ids ??
    norm.broadcast_admins ??
    norm.broadcast_admin_ids ??
    norm.admins ??
    norm.admin ??
    "";
  const welcomeMessage = String(
    norm.welcome_message ?? norm.welcome ?? ""
  ).trim();
  const welcomeImage = String(
    norm.welcome_image ??
      norm.welcome_photo ??
      norm.welcome_photo_url ??
      norm.welcome_picture ??
      norm.image ??
      norm.picture ??
      ""
  ).trim();
  const groupChatIdRaw =
    norm.group_chat_id ??
    norm.target_group_id ??
    norm.group_id ??
    norm.channel_id ??
    "";
  const channelUrl = String(
    norm.channel_url ??
      norm.channel_link ??
      norm.reach_url ??
      norm.reach_link ??
      ""
  ).trim();
  const welcomeButtons = parseWelcomeButtons(norm);
  const welcomeButtonsPerRow = parseButtonsPerRow(
    norm.buttons_per_row ?? norm.button_columns ?? norm.button_per_row ?? 2
  );

  let enabled = true;
  const en = norm.enabled;
  if (en != null && String(en).trim() !== "") {
    const s = String(en).trim().toLowerCase();
    if (["no", "false", "0", "n", "off"].includes(s)) enabled = false;
  }

  const slug = slugify(String(nameRaw), index);

  return {
    name: String(nameRaw).trim() || slug,
    slug,
    token,
    adminIds: parseAdminIds(adminsRaw),
    enabled,
    welcomeExtra: welcomeMessage,
    welcomeImage,
    groupChatId: Number(groupChatIdRaw) || null,
    channelUrl,
    randomChannelUrls: [],
    welcomeButtons,
    welcomeButtonsPerRow,
    welcomeButtonLayout: "",
    isFirstAndheriBot: false,
  };
}

function slugify(name, index) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return (base || "bot") + "-" + index;
}

/** If a row has no admin column, use .env ADMIN_TELEGRAM_IDS so broadcast still works. */
function applyGlobalAdminFallback(configs) {
  const globalAdmins = parseAdminIds(process.env.ADMIN_TELEGRAM_IDS ?? "");
  if (globalAdmins.length === 0) return configs;
  return configs.map((c) =>
    c.adminIds.length > 0 ? c : { ...c, adminIds: globalAdmins }
  );
}

function loadBotsFromExcel(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  const configs = rows
    .map((row, i) => rowToConfig(row, i))
    .filter((c) => c.enabled && c.token && c.token !== "PASTE_TOKEN_FROM_BOTFATHER");
  return applyGlobalAdminFallback(configs);
}

function loadBotsFromEnv() {
  const multiRaw = String(
    process.env.BOTS_JSON ?? process.env.BOTS_CONFIG_JSON ?? ""
  ).trim();
  if (multiRaw) {
    try {
      const parsed = JSON.parse(multiRaw);
      if (!Array.isArray(parsed)) return [];
      const configs = parsed
        .map((row, i) => rowToConfig(row, i))
        .filter(
          (c) =>
            c.enabled && c.token && c.token !== "PASTE_TOKEN_FROM_BOTFATHER"
        );
      return applyGlobalAdminFallback(configs);
    } catch (err) {
      console.error("Invalid BOTS_JSON/BOTS_CONFIG_JSON in .env:", err.message);
      return [];
    }
  }

  const token = process.env.BOT_TOKEN?.trim();
  if (!token) return [];
  const adminIds = parseAdminIds(process.env.ADMIN_TELEGRAM_IDS ?? "");
  const welcomeButtons = [];
  for (let i = 1; i <= 5; i += 1) {
    const text = String(process.env[`BUTTON_${i}_TEXT`] ?? "").trim();
    const url = String(process.env[`BUTTON_${i}_URL`] ?? "").trim();
    if (text && /^https?:\/\//i.test(url)) {
      welcomeButtons.push({ text, url });
    }
  }
  const cfg = {
    name: "default",
    slug: "default",
    token,
    adminIds,
    enabled: true,
    welcomeExtra: "",
    welcomeImage: String(process.env.WELCOME_IMAGE ?? "").trim(),
    groupChatId: Number(process.env.GROUP_CHAT_ID ?? "") || null,
    channelUrl: String(process.env.CHANNEL_URL ?? "").trim(),
    randomChannelUrls: [],
    welcomeButtons,
    welcomeButtonsPerRow: parseButtonsPerRow(process.env.BUTTONS_PER_ROW ?? 2),
    welcomeButtonLayout: "",
    isFirstAndheriBot: false,
  };
  return applyGlobalAdminFallback([cfg]);
}

function markFirstAndheriBot(configs) {
  let found = false;
  return configs.map((cfg) => {
    if (
      !found &&
      /a?ndheri/i.test(
        [String(cfg.name ?? ""), String(cfg.welcomeExtra ?? "")].join(" ")
      )
    ) {
      found = true;
      return { ...cfg, isFirstAndheriBot: true };
    }
    return cfg;
  });
}

function openConfigDb() {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS bots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token TEXT NOT NULL,
      admin_ids TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      welcome_message TEXT NOT NULL DEFAULT '',
      welcome_image TEXT NOT NULL DEFAULT '',
      group_chat_id TEXT NOT NULL DEFAULT '',
      channel_url TEXT NOT NULL DEFAULT '',
      random_channel_urls TEXT NOT NULL DEFAULT '',
      welcome_buttons TEXT NOT NULL DEFAULT '',
      buttons_per_row INTEGER NOT NULL DEFAULT 2,
      button_layout TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  try {
    const cols = db.prepare("PRAGMA table_info(bots)").all();
    const hasButtonsPerRow = cols.some((c) => c.name === "buttons_per_row");
    if (!hasButtonsPerRow) {
      db.exec("ALTER TABLE bots ADD COLUMN buttons_per_row INTEGER NOT NULL DEFAULT 2");
    }
    const hasButtonLayout = cols.some((c) => c.name === "button_layout");
    if (!hasButtonLayout) {
      db.exec("ALTER TABLE bots ADD COLUMN button_layout TEXT NOT NULL DEFAULT ''");
    }
  } catch {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  try {
    const cols = db.prepare("PRAGMA table_info(message_templates)").all();
    if (!cols.some((c) => c.name === "buttons")) {
      db.exec("ALTER TABLE message_templates ADD COLUMN buttons TEXT NOT NULL DEFAULT '[]'");
    }
    if (!cols.some((c) => c.name === "buttons_per_row")) {
      db.exec("ALTER TABLE message_templates ADD COLUMN buttons_per_row INTEGER NOT NULL DEFAULT 2");
    }
  } catch {}
  return db;
}

const MESSAGE_TEMPLATE_TITLE_MAX = 120;
const MESSAGE_TEMPLATE_BODY_MAX = 4096;
const MESSAGE_TEMPLATE_IMAGE_MAX = 2000;

function loadMessageTemplates(db) {
  try {
    return db
      .prepare("SELECT * FROM message_templates ORDER BY updated_at DESC, id DESC")
      .all();
  } catch {
    return [];
  }
}

function sanitizeMessageTemplateFields(raw) {
  const title = String(raw.title ?? "")
    .replace(/\0/g, "")
    .trim()
    .slice(0, MESSAGE_TEMPLATE_TITLE_MAX);
  const body = String(raw.body ?? "")
    .replace(/\0/g, "")
    .trim()
    .slice(0, MESSAGE_TEMPLATE_BODY_MAX);
  let imageUrl = String(raw.image_url ?? "")
    .replace(/\0/g, "")
    .trim()
    .slice(0, MESSAGE_TEMPLATE_IMAGE_MAX);
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
    imageUrl = "";
  }
  const buttonsPerRow = parseButtonsPerRow(raw.buttons_per_row ?? 2);
  const buttons = Array.isArray(raw.buttons)
    ? raw.buttons
        .map((b) => ({
          text: String(b?.text ?? "").trim().slice(0, 64),
          url: String(b?.url ?? "").trim().slice(0, 2000),
          row: parseButtonsPerRow(b?.row ?? buttonsPerRow, buttonsPerRow),
        }))
        .filter((b) => b.text && /^https?:\/\//i.test(b.url))
        .slice(0, 5)
    : [];
  return { title, body, imageUrl, buttons, buttonsPerRow };
}

function parseMessageTemplateButtonsFromForm(form) {
  const buttons = [];
  const fallbackPerRow = parseButtonsPerRow(form.get("buttons_per_row") ?? 2);
  for (let i = 1; i <= 5; i += 1) {
    const text = String(form.get(`msg_button_${i}_text`) ?? "").trim();
    const url = String(form.get(`msg_button_${i}_url`) ?? "").trim();
    const row = parseButtonsPerRow(form.get(`msg_button_${i}_row`) ?? "", fallbackPerRow);
    if (text && /^https?:\/\//i.test(url)) buttons.push({ text, url, row });
  }
  return buttons;
}

function parseMessageTemplateButtons(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((b) => ({
        text: String(b?.text ?? ""),
        url: String(b?.url ?? ""),
        row: Number(b?.row ?? 2),
      }))
      .filter((b) => b.text && /^https?:\/\//i.test(b.url));
  } catch {
    return [];
  }
}

function truncateSingleLine(s, maxLen) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(0, maxLen - 1))}…`;
}

function renderMessageLibraryButtonsBlock(buttons, fallbackPerRow) {
  if (!Array.isArray(buttons) || buttons.length === 0) return "";
  let html = "";
  for (let i = 0; i < buttons.length; ) {
    const size = parseButtonsPerRow(buttons[i]?.row, fallbackPerRow);
    const row = buttons.slice(i, i + size);
    html += `<div class="tg-row">${row
      .map((b) => `<span class="tg-btn">${escapeHtml(String(b.text ?? ""))}</span>`)
      .join("")}</div>`;
    i += size;
  }
  return html ? `<div class="tg-buttons">${html}</div>` : "";
}

/** Compact Telegram-style bubble for Message Library list rows (server-rendered). */
function renderMessageLibraryListPreview(templateRow) {
  const imageUrl = String(templateRow.image_url ?? "").trim();
  const okImg = imageUrl && /^https?:\/\//i.test(imageUrl);
  const body = String(templateRow.body ?? "");
  const bodyHtml =
    body.trim() === ""
      ? `<span class="msg-lib-empty-preview">No message text</span>`
      : escapeHtml(body).replaceAll("\n", "<br>");
  const fb = parseButtonsPerRow(templateRow.buttons_per_row ?? 2);
  const rawBtns = parseMessageTemplateButtons(templateRow.buttons);
  const buttons = rawBtns.map((b) => ({
    text: b.text,
    url: b.url,
    row: parseButtonsPerRow(b.row, fb),
  }));
  const imgTag = okImg
    ? `<img class="tg-image" alt="" loading="lazy" decoding="async" src="${escapeHtml(imageUrl)}"/>`
    : "";
  const btnBlock = renderMessageLibraryButtonsBlock(buttons, fb);
  return `<div class="telegram-preview msg-lib-preview-skin"><div class="tg-screen msg-lib-tg-screen"><div class="tg-bubble msg-lib-tg-bubble">${imgTag}<div class="tg-text msg-lib-tg-text">${bodyHtml}</div>${btnBlock}</div></div></div>`;
}

function configToDbRow(cfg) {
  return {
    name: String(cfg.name ?? "").trim(),
    token: String(cfg.token ?? "").trim(),
    admin_ids: (cfg.adminIds ?? []).join(","),
    enabled: cfg.enabled ? 1 : 0,
    welcome_message: String(cfg.welcomeExtra ?? "").trim(),
    welcome_image: String(cfg.welcomeImage ?? "").trim(),
    group_chat_id: cfg.groupChatId ? String(cfg.groupChatId) : "",
    channel_url: String(cfg.channelUrl ?? "").trim(),
    random_channel_urls: "",
    welcome_buttons: JSON.stringify(cfg.welcomeButtons ?? []),
    buttons_per_row: parseButtonsPerRow(cfg.welcomeButtonsPerRow ?? 2),
    button_layout: "",
  };
}

function dbRowToConfig(row, index) {
  let buttons = [];
  try {
    const parsed = JSON.parse(String(row.welcome_buttons ?? "[]"));
    if (Array.isArray(parsed)) {
      buttons = parsed
        .map((b) => ({
          text: String(b.text ?? "").trim(),
          url: String(b.url ?? "").trim(),
          perRow: parseButtonsPerRow(b.perRow, 0),
        }))
        .filter((b) => b.text && /^https?:\/\//i.test(b.url));
    }
  } catch {}

  return {
    id: Number(row.id) || 0,
    name: String(row.name ?? "").trim() || `bot_${index + 1}`,
    slug: slugify(String(row.name ?? ""), index),
    token: String(row.token ?? "").trim(),
    adminIds: parseAdminIds(row.admin_ids ?? ""),
    enabled: Number(row.enabled) !== 0,
    welcomeExtra: String(row.welcome_message ?? "").trim(),
    welcomeImage: String(row.welcome_image ?? "").trim(),
    groupChatId: Number(row.group_chat_id) || null,
    channelUrl: String(row.channel_url ?? "").trim(),
    randomChannelUrls: [],
    welcomeButtons: buttons,
    welcomeButtonsPerRow: parseButtonsPerRow(row.buttons_per_row ?? 2),
    welcomeButtonLayout: "",
    isFirstAndheriBot: false,
  };
}

function seedSqliteIfEmpty(db, seedConfigs) {
  const count = Number(db.prepare("SELECT COUNT(*) AS c FROM bots").get().c || 0);
  if (count > 0 || seedConfigs.length === 0) return false;
  const insert = db.prepare(`
    INSERT INTO bots (
      name, token, admin_ids, enabled, welcome_message, welcome_image,
      group_chat_id, channel_url, random_channel_urls, welcome_buttons, buttons_per_row, button_layout, created_at, updated_at
    ) VALUES (
      @name, @token, @admin_ids, @enabled, @welcome_message, @welcome_image,
      @group_chat_id, @channel_url, @random_channel_urls, @welcome_buttons, @buttons_per_row, @button_layout, @created_at, @updated_at
    )
  `);
  const now = new Date().toISOString();
  const txn = db.transaction((items) => {
    for (const cfg of items) {
      const row = configToDbRow(cfg);
      insert.run({ ...row, created_at: now, updated_at: now });
    }
  });
  txn(seedConfigs);
  return true;
}

function loadBotsFromSqlite(db) {
  const rows = db
    .prepare("SELECT * FROM bots WHERE enabled = 1 ORDER BY id ASC")
    .all();
  return rows
    .map((row, i) => dbRowToConfig(row, i))
    .filter((c) => c.enabled && c.token && c.token !== "PASTE_TOKEN_FROM_BOTFATHER");
}

function loadEnabledConfigsFromDb(db) {
  const rows = db
    .prepare("SELECT * FROM bots WHERE enabled = 1 ORDER BY id ASC")
    .all();
  return rows
    .map((row, i) => dbRowToConfig(row, i))
    .filter((c) => c.enabled && c.token && c.token !== "PASTE_TOKEN_FROM_BOTFATHER");
}

function resolveConfigs() {
  const excelPath = path.resolve(
    ROOT,
    process.env.BOTS_EXCEL_PATH || "bots.xlsx"
  );
  const db = openConfigDb();

  const fromEnv = loadBotsFromEnv();
  const fromExcel = loadBotsFromExcel(excelPath);
  seedSqliteIfEmpty(db, fromEnv.length > 0 ? fromEnv : fromExcel);

  const fromSqlite = loadBotsFromSqlite(db);
  if (fromSqlite.length > 0) {
    return { configs: markFirstAndheriBot(fromSqlite), source: "sqlite", db };
  }

  console.error(
    "No bots found. Either:\n" +
      "  • Add bots in the admin panel, or\n" +
      "  • Set BOTS_JSON/BOT_TOKEN in .env to auto-seed SQLite once, or\n" +
      "  • Create bots.xlsx (run: npm run template) to auto-seed SQLite once."
  );
  process.exit(1);
}

function createUserStore(usersFile) {
  let registerQueue = Promise.resolve();

  function normalizeStoredUsers(data) {
    if (Array.isArray(data?.users)) {
      return data.users
        .map((u) => ({
          chatId: Number(u.chatId),
          username: String(u.username ?? "").trim(),
          firstName: String(u.firstName ?? "").trim(),
          lastName: String(u.lastName ?? "").trim(),
          firstSeenAt: String(u.firstSeenAt ?? "").trim(),
          lastSeenAt: String(u.lastSeenAt ?? "").trim(),
        }))
        .filter((u) => !Number.isNaN(u.chatId));
    }
    const ids = Array.isArray(data?.chatIds) ? data.chatIds : [];
    return [...new Set(ids.map(Number).filter((n) => !Number.isNaN(n)))].map((chatId) => ({
      chatId,
      username: "",
      firstName: "",
      lastName: "",
      firstSeenAt: "",
      lastSeenAt: "",
    }));
  }

  function loadUsers() {
    try {
      const dir = path.dirname(usersFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(usersFile)) return [];
      const data = JSON.parse(fs.readFileSync(usersFile, "utf8"));
      return normalizeStoredUsers(data);
    } catch {
      return [];
    }
  }

  function loadChatIds() {
    return [...new Set(loadUsers().map((u) => Number(u.chatId)).filter((n) => !Number.isNaN(n)))];
  }

  function saveUsers(users) {
    const dir = path.dirname(usersFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const uniqueUsers = [];
    const seen = new Set();
    for (const u of users) {
      const chatId = Number(u.chatId);
      if (Number.isNaN(chatId) || seen.has(chatId)) continue;
      seen.add(chatId);
      uniqueUsers.push({
        chatId,
        username: String(u.username ?? "").trim(),
        firstName: String(u.firstName ?? "").trim(),
        lastName: String(u.lastName ?? "").trim(),
        firstSeenAt: String(u.firstSeenAt ?? "").trim(),
        lastSeenAt: String(u.lastSeenAt ?? "").trim(),
      });
    }
    fs.writeFileSync(
      usersFile,
      JSON.stringify(
        {
          chatIds: uniqueUsers.map((u) => u.chatId),
          users: uniqueUsers,
        },
        null,
        2
      ),
      "utf8"
    );
  }

  function registerUser(msg) {
    registerQueue = registerQueue.then(() => {
      const chatId = Number(msg?.chat?.id);
      if (Number.isNaN(chatId)) return;
      const now = new Date().toISOString();
      const users = loadUsers();
      const idx = users.findIndex((u) => u.chatId === chatId);
      const incoming = {
        chatId,
        username: String(msg?.from?.username ?? "").trim(),
        firstName: String(msg?.from?.first_name ?? "").trim(),
        lastName: String(msg?.from?.last_name ?? "").trim(),
        firstSeenAt: now,
        lastSeenAt: now,
      };
      if (idx >= 0) {
        users[idx] = {
          ...users[idx],
          ...incoming,
          firstSeenAt: users[idx].firstSeenAt || incoming.firstSeenAt,
          lastSeenAt: now,
        };
      } else {
        users.push(incoming);
      }
      saveUsers(users);
    });
  }

  return { loadChatIds, registerUser, loadUsers };
}

function createSchedulerStore(storeFile) {
  function defaultState() {
    return {
      groupChatId: null,
      lastSentDateBySlot: {},
      sentMessageIdsByDate: {},
      nextMessageId: 1,
      library: [],
    };
  }

  function sanitizeState(raw) {
    const base = defaultState();
    const state = raw && typeof raw === "object" ? raw : {};
    const library = Array.isArray(state.library) ? state.library : [];
    const normalizedLibrary = library
      .map((item) => ({
        id: Number(item.id),
        sourceChatId: Number(item.sourceChatId),
        sourceMessageId: Number(item.sourceMessageId),
        kind: String(item.kind ?? "message"),
        preview: String(item.preview ?? ""),
        addedAt: String(item.addedAt ?? new Date().toISOString()),
      }))
      .filter(
        (item) =>
          !Number.isNaN(item.id) &&
          !Number.isNaN(item.sourceChatId) &&
          !Number.isNaN(item.sourceMessageId)
      );
    const maxId = normalizedLibrary.reduce((m, item) => Math.max(m, item.id), 0);
    return {
      groupChatId: Number(state.groupChatId) || null,
      lastSentDateBySlot:
        state.lastSentDateBySlot && typeof state.lastSentDateBySlot === "object"
          ? state.lastSentDateBySlot
          : base.lastSentDateBySlot,
      sentMessageIdsByDate:
        state.sentMessageIdsByDate && typeof state.sentMessageIdsByDate === "object"
          ? state.sentMessageIdsByDate
          : base.sentMessageIdsByDate,
      nextMessageId: Math.max(Number(state.nextMessageId) || 1, maxId + 1),
      library: normalizedLibrary,
    };
  }

  function ensureDir() {
    const dir = path.dirname(storeFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function loadState() {
    try {
      ensureDir();
      if (!fs.existsSync(storeFile)) return defaultState();
      return sanitizeState(JSON.parse(fs.readFileSync(storeFile, "utf8")));
    } catch {
      return defaultState();
    }
  }

  function saveState(state) {
    ensureDir();
    fs.writeFileSync(storeFile, JSON.stringify(state, null, 2), "utf8");
  }

  return { loadState, saveState };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getDateStamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function pickMessageForDate(library, sentIdsToday) {
  if (library.length === 0) return null;
  const remaining = library.filter((m) => !sentIdsToday.includes(m.id));
  const pool = remaining.length > 0 ? remaining : library;
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

function messageKind(msg) {
  if (msg.photo?.length) return "photo";
  if (msg.video) return "video";
  if (msg.animation) return "gif";
  if (msg.document) return "document";
  if (msg.audio) return "audio";
  if (msg.voice) return "voice";
  if (msg.sticker) return "sticker";
  if (msg.text) return "text";
  return "message";
}

function messagePreview(msg) {
  if (msg.text) return msg.text.slice(0, 80);
  if (msg.caption) return msg.caption.slice(0, 80);
  return messageKind(msg);
}

/** Photo for sendPhoto: HTTPS URL, Telegram file_id, or path under project folder. */
function resolveWelcomePhotoInput(raw) {
  const s = String(raw).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const local = path.isAbsolute(s) ? s : path.join(ROOT, s);
  if (fs.existsSync(local)) return fs.createReadStream(local);
  return s;
}

const BROADCAST_CMD = /^\/broadcast(?:\s+([\s\S]+))?$/;

function attachHandlers(bot, cfg, store, logPrefix, hooks = {}) {
  function welcomeReplyMarkup() {
    if (Array.isArray(cfg.welcomeButtons) && cfg.welcomeButtons.length > 0) {
      const inlineKeyboard = [];
      const fallbackPerRow = parseButtonsPerRow(cfg.welcomeButtonsPerRow ?? 2);
      let index = 0;
      while (index < cfg.welcomeButtons.length) {
        const current = cfg.welcomeButtons[index] ?? {};
        const fromButton = parseButtonsPerRow(current.perRow, 0);
        const rowSize = fromButton >= 1 && fromButton <= 3 ? fromButton : fallbackPerRow;
        inlineKeyboard.push(cfg.welcomeButtons.slice(index, index + rowSize));
        index += rowSize;
      }
      return {
        inline_keyboard: inlineKeyboard,
      };
    }

    if (cfg.isFirstAndheriBot) {
      const pool =
        Array.isArray(cfg.randomChannelUrls) && cfg.randomChannelUrls.length > 0
          ? cfg.randomChannelUrls
          : DEFAULT_RANDOM_CHANNEL_URLS;
      const randomUrl = pool[Math.floor(Math.random() * pool.length)];
      return {
        inline_keyboard: [
          [{ text: DEFAULT_RANDOM_CHANNEL_BUTTON_TEXT, url: randomUrl }],
        ],
      };
    }

    const url = String(cfg.channelUrl ?? "").trim();
    if (!/^https?:\/\//i.test(url)) return undefined;
    return {
      inline_keyboard: [
        [{ text: DEFAULT_REACH_BUTTON_TEXT, url }],
      ],
    };
  }

  const { loadChatIds, registerUser } = store;
  const adminIds = cfg.adminIds;
  const scheduleFile = path.join(ROOT, "data", cfg.slug, "schedule.json");
  const schedulerStore = createSchedulerStore(scheduleFile);

  function isAdmin(userId) {
    return !!userId && adminIds.length > 0 && adminIds.includes(userId);
  }

  async function ensureAdmin(chatId, fromId) {
    if (!fromId) return false;
    if (adminIds.length === 0) {
      await bot.sendMessage(
        chatId,
        "Broadcast is not configured. Set admin_ids for this bot in Excel (or ADMIN_TELEGRAM_IDS in .env)."
      );
      return false;
    }
    if (!adminIds.includes(fromId)) {
      await bot.sendMessage(chatId, "You are not allowed to broadcast.");
      return false;
    }
    return true;
  }

  function upsertGroupOnAnyGroupMessage(msg) {
    if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return;
    const state = schedulerStore.loadState();
    if (state.groupChatId === msg.chat.id) return;
    state.groupChatId = msg.chat.id;
    schedulerStore.saveState(state);
  }

  async function runDailyScheduleTick(now = new Date()) {
    const state = schedulerStore.loadState();
    const groupChatId = state.groupChatId || cfg.groupChatId;
    if (!groupChatId) return;
    if (!Array.isArray(state.library) || state.library.length === 0) return;

    const stamp = getDateStamp(now);
    if (!Array.isArray(state.sentMessageIdsByDate[stamp])) {
      state.sentMessageIdsByDate[stamp] = [];
    }
    const hour = now.getHours();
    const minute = now.getMinutes();

    for (const slot of DEFAULT_DAILY_SEND_TIMES) {
      if (slot.hour !== hour || slot.minute !== minute) continue;
      if (state.lastSentDateBySlot[slot.key] === stamp) continue;

      const chosen = pickMessageForDate(
        state.library,
        state.sentMessageIdsByDate[stamp]
      );
      if (!chosen) continue;

      try {
        await bot.copyMessage(
          groupChatId,
          chosen.sourceChatId,
          chosen.sourceMessageId
        );
        state.lastSentDateBySlot[slot.key] = stamp;
        state.sentMessageIdsByDate[stamp].push(chosen.id);
      } catch (err) {
        console.error(`${logPrefix} scheduled send failed:`, err.message);
      }
    }

    const keepDate = stamp;
    for (const k of Object.keys(state.sentMessageIdsByDate)) {
      if (k !== keepDate) delete state.sentMessageIdsByDate[k];
    }
    schedulerStore.saveState(state);
  }

  async function broadcastLoop(chatId, sendOne) {
    const recipients = loadChatIds();
    if (recipients.length === 0) {
      await bot.sendMessage(
        chatId,
        "No users yet. Users are saved when they message this bot in private."
      );
      return;
    }

    await bot.sendMessage(chatId, `Sending to ${recipients.length} user(s)…`);

    let sent = 0;
    let failed = 0;
    for (const uid of recipients) {
      try {
        await sendOne(uid);
        sent++;
      } catch {
        failed++;
      }
      await sleep(DELAY_MS);
    }

    await bot.sendMessage(
      chatId,
      `Done: ${sent} sent, ${failed} failed (blocked bot or invalid).`
    );
  }

  bot.on("message", async (msg) => {
    upsertGroupOnAnyGroupMessage(msg);
    if (msg.chat.type === "private") registerUser(msg);

    if (msg.chat.type !== "private" || !msg.from) return;

    const cap = msg.caption?.trim();
    const capMatch = cap && cap.match(BROADCAST_CMD);
    if (!capMatch) return;

    const hasMedia =
      msg.photo?.length ||
      msg.video ||
      msg.document ||
      msg.animation;
    if (!hasMedia) return;

    if (!(await ensureAdmin(msg.chat.id, msg.from.id))) return;

    const captionText = capMatch[1]?.trim() ?? "";

    if (msg.photo?.length) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      await broadcastLoop(msg.chat.id, (uid) =>
        bot.sendPhoto(uid, fileId, {
          caption: captionText || undefined,
        })
      );
      return;
    }

    if (msg.video) {
      await broadcastLoop(msg.chat.id, (uid) =>
        bot.sendVideo(uid, msg.video.file_id, {
          caption: captionText || undefined,
        })
      );
      return;
    }

    if (msg.document) {
      await broadcastLoop(msg.chat.id, (uid) =>
        bot.sendDocument(uid, msg.document.file_id, {
          caption: captionText || undefined,
        })
      );
      return;
    }

    if (msg.animation) {
      await broadcastLoop(msg.chat.id, (uid) =>
        bot.sendAnimation(uid, msg.animation.file_id, {
          caption: captionText || undefined,
        })
      );
      return;
    }
  });

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const name = msg.from?.first_name ?? "there";
    const extra = cfg.welcomeExtra
      ? `\n\n${cfg.welcomeExtra}`
      : "";
    const welcome = `Welcome, ${name}! 👋\n\n${DEFAULT_WELCOME}${extra}`;
    const replyMarkup = welcomeReplyMarkup();

    const photo = cfg.welcomeImage && resolveWelcomePhotoInput(cfg.welcomeImage);
    if (photo) {
      try {
        await bot.sendPhoto(chatId, photo, {
          caption: welcome,
          reply_markup: replyMarkup,
        });
      } catch (err) {
        console.error(`${logPrefix} welcome image failed:`, err.message);
        await bot.sendMessage(chatId, welcome, { reply_markup: replyMarkup });
      }
    } else {
      await bot.sendMessage(chatId, welcome, { reply_markup: replyMarkup });
    }
  });

  bot.onText(/\/broadcast(?:\s+([\s\S]+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;
    if (!(await ensureAdmin(chatId, fromId))) return;

    const reply = msg.reply_to_message;
    const cmdText = match[1]?.trim() ?? "";

    if (reply) {
      if (reply.photo?.length) {
        const fileId = reply.photo[reply.photo.length - 1].file_id;
        const cap = cmdText || reply.caption?.trim() || "";
        await broadcastLoop(chatId, (uid) =>
          bot.sendPhoto(uid, fileId, { caption: cap || undefined })
        );
        return;
      }
      if (reply.video) {
        const cap = cmdText || reply.caption?.trim() || "";
        await broadcastLoop(chatId, (uid) =>
          bot.sendVideo(uid, reply.video.file_id, { caption: cap || undefined })
        );
        return;
      }
      if (reply.document) {
        const cap = cmdText || reply.caption?.trim() || "";
        await broadcastLoop(chatId, (uid) =>
          bot.sendDocument(uid, reply.document.file_id, {
            caption: cap || undefined,
          })
        );
        return;
      }
      if (reply.animation) {
        const cap = cmdText || reply.caption?.trim() || "";
        await broadcastLoop(chatId, (uid) =>
          bot.sendAnimation(uid, reply.animation.file_id, {
            caption: cap || undefined,
          })
        );
        return;
      }
      if (reply.text) {
        const text = cmdText || reply.text;
        await broadcastLoop(chatId, (uid) => bot.sendMessage(uid, text));
        return;
      }
    }

    if (!cmdText) {
      await bot.sendMessage(
        chatId,
        [
          "Usage:",
          "• Text: /broadcast Your message",
          "• Image (caption): send a photo with caption starting with /broadcast optional caption",
          "• Or: reply to any message with /broadcast optional caption",
        ].join("\n")
      );
      return;
    }

    await broadcastLoop(chatId, (uid) => bot.sendMessage(uid, cmdText));
  });

  bot.onText(/\/setgroup/, async (msg) => {
    if (!isAdmin(msg.from?.id)) return;
    if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
      await bot.sendMessage(
        msg.chat.id,
        "Use /setgroup inside the target group."
      );
      return;
    }
    const state = schedulerStore.loadState();
    state.groupChatId = msg.chat.id;
    schedulerStore.saveState(state);
    await bot.sendMessage(
      msg.chat.id,
      "This group is now set for scheduled daily messages."
    );
  });

  bot.onText(/\/addmsg/, async (msg) => {
    if (!isAdmin(msg.from?.id)) return;
    const source = msg.reply_to_message;
    if (!source) {
      await bot.sendMessage(
        msg.chat.id,
        "Reply to a message with /addmsg to store it for daily scheduling."
      );
      return;
    }
    const state = schedulerStore.loadState();
    const newItem = {
      id: state.nextMessageId,
      sourceChatId: source.chat.id,
      sourceMessageId: source.message_id,
      kind: messageKind(source),
      preview: messagePreview(source),
      addedAt: new Date().toISOString(),
    };
    state.library.push(newItem);
    state.nextMessageId += 1;
    schedulerStore.saveState(state);
    await bot.sendMessage(
      msg.chat.id,
      `Saved message #${newItem.id} (${newItem.kind}) for daily queue.`
    );
  });

  bot.onText(/\/listmsgs/, async (msg) => {
    if (!isAdmin(msg.from?.id)) return;
    const state = schedulerStore.loadState();
    if (state.library.length === 0) {
      await bot.sendMessage(msg.chat.id, "Message library is empty.");
      return;
    }
    const lines = state.library.slice(-30).map((item) => {
      const preview = item.preview ? ` - ${item.preview}` : "";
      return `#${item.id} [${item.kind}]${preview}`;
    });
    await bot.sendMessage(
      msg.chat.id,
      `Stored messages: ${state.library.length}\n` + lines.join("\n")
    );
  });

  bot.onText(/\/delmsg\s+(\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from?.id)) return;
    const id = Number(match[1]);
    const state = schedulerStore.loadState();
    const before = state.library.length;
    state.library = state.library.filter((m) => m.id !== id);
    if (state.library.length === before) {
      await bot.sendMessage(msg.chat.id, `Message #${id} not found.`);
      return;
    }
    schedulerStore.saveState(state);
    await bot.sendMessage(msg.chat.id, `Deleted message #${id}.`);
  });

  setInterval(() => {
    runDailyScheduleTick().catch((err) =>
      console.error(`${logPrefix} schedule tick failed:`, err.message)
    );
  }, 60 * 1000);
  runDailyScheduleTick().catch((err) =>
    console.error(`${logPrefix} initial schedule tick failed:`, err.message)
  );

  bot.on("polling_error", (err) => {
    if (typeof hooks.onPollingError === "function") {
      hooks.onPollingError(err);
    }
    console.error(`${logPrefix} polling error:`, err.message);
  });
}

function startBot(cfg) {
  const usersFile = path.join(ROOT, "data", cfg.slug, "users.json");
  const store = createUserStore(usersFile);
  const logPrefix = `[${cfg.name}]`;
  const runtime = {
    id: Number(cfg.id) || 0,
    name: cfg.name,
    slug: cfg.slug,
    usersFile,
    startedAt: new Date().toISOString(),
    lastPollingError: null,
    pollingErrorCount: 0,
  };

  const bot = new TelegramBot(cfg.token, { polling: true });
  attachHandlers(bot, cfg, store, logPrefix, {
    onPollingError(err) {
      runtime.lastPollingError = String(err?.message ?? "Unknown error");
      runtime.pollingErrorCount += 1;
    },
  });
  console.log(`${logPrefix} running — users file: data/${cfg.slug}/users.json`);
  return { cfg, store, runtime, bot };
}

function countMembers(usersFile) {
  try {
    if (!fs.existsSync(usersFile)) return 0;
    const data = JSON.parse(fs.readFileSync(usersFile, "utf8"));
    const ids = Array.isArray(data.users)
      ? data.users.map((u) => u.chatId)
      : Array.isArray(data.chatIds)
        ? data.chatIds
        : [];
    return [...new Set(ids.map(Number).filter((n) => !Number.isNaN(n)))].length;
  } catch {
    return 0;
  }
}

function loadInteractedUserIdsForSlug(slug) {
  try {
    const usersFile = path.join(ROOT, "data", slug, "users.json");
    if (!fs.existsSync(usersFile)) return [];
    const data = JSON.parse(fs.readFileSync(usersFile, "utf8"));
    const users = Array.isArray(data.users)
      ? data.users
          .map((u) => ({
            chatId: String(u.chatId ?? "").trim(),
            username: String(u.username ?? "").trim(),
            firstName: String(u.firstName ?? "").trim(),
            lastName: String(u.lastName ?? "").trim(),
          }))
          .filter((u) => u.chatId)
      : [];
    if (users.length > 0) {
      const seen = new Set();
      return users.filter((u) => {
        if (seen.has(u.chatId)) return false;
        seen.add(u.chatId);
        return true;
      });
    }
    const ids = Array.isArray(data.chatIds) ? data.chatIds : [];
    return [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))].map((id) => ({
      chatId: id,
      username: "",
      firstName: "",
      lastName: "",
    }));
  } catch {
    return [];
  }
}

function getStatusRows(instances) {
  return instances.map(({ runtime }) => {
    const members = countMembers(runtime.usersFile);
    return {
      id: Number(runtime.id || 0),
      name: runtime.name,
      slug: runtime.slug,
      members,
      pollingErrorCount: runtime.pollingErrorCount,
      lastPollingError: runtime.lastPollingError,
      startedAt: runtime.startedAt,
      healthy: runtime.pollingErrorCount === 0,
    };
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseCookies(req) {
  const raw = String(req.headers.cookie ?? "");
  const cookies = {};
  for (const item of raw.split(";")) {
    const [k, ...rest] = item.trim().split("=");
    if (!k) continue;
    cookies[k] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseButtonsFromForm(form) {
  const buttons = [];
  const fallbackPerRow = parseButtonsPerRow(form.get("buttons_per_row") ?? 2);
  for (let i = 1; i <= 5; i += 1) {
    const text = String(form.get(`button_${i}_text`) ?? "").trim();
    const url = String(form.get(`button_${i}_url`) ?? "").trim();
    const perRow = parseButtonsPerRow(form.get(`button_${i}_row`) ?? "", fallbackPerRow);
    if (text && /^https?:\/\//i.test(url)) {
      buttons.push({ text, url, perRow });
    }
  }
  return buttons;
}

function parseBroadcastButtonsFromForm(form) {
  const buttons = [];
  const fallbackPerRow = parseButtonsPerRow(form.get("broadcast_buttons_per_row") ?? 2);
  for (let i = 1; i <= 5; i += 1) {
    const text = String(form.get(`broadcast_button_${i}_text`) ?? "").trim();
    const url = String(form.get(`broadcast_button_${i}_url`) ?? "").trim();
    const perRow = parseButtonsPerRow(form.get(`broadcast_button_${i}_row`) ?? "", fallbackPerRow);
    if (text && /^https?:\/\//i.test(url)) {
      buttons.push({ text, url, perRow });
    }
  }
  return buttons;
}

/** Same row layout as welcome inline keyboard (per-button row size + fallback). */
function buildUrlButtonReplyMarkup(buttons, fallbackPerRow = 2) {
  if (!Array.isArray(buttons) || buttons.length === 0) return undefined;
  const fb = parseButtonsPerRow(fallbackPerRow, 2);
  const inlineKeyboard = [];
  let index = 0;
  while (index < buttons.length) {
    const current = buttons[index] ?? {};
    const fromButton = parseButtonsPerRow(current.perRow, 0);
    const rowSize = fromButton >= 1 && fromButton <= 3 ? fromButton : fb;
    inlineKeyboard.push(
      buttons.slice(index, index + rowSize).map((b) => ({ text: b.text, url: b.url }))
    );
    index += rowSize;
  }
  return { inline_keyboard: inlineKeyboard };
}

function loadBotRows(db) {
  return db.prepare("SELECT * FROM bots ORDER BY id ASC").all();
}

function readTemplateFile(name) {
  return fs.readFileSync(path.join(TEMPLATES_DIR, name), "utf8");
}

function readAdminLoginState() {
  try {
    const raw = fs.readFileSync(ADMIN_LOGIN_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      failedAttempts: Number(parsed.failedAttempts || 0),
      locked: Boolean(parsed.locked),
      lockedAt: String(parsed.lockedAt ?? ""),
    };
  } catch {
    return { failedAttempts: 0, locked: false, lockedAt: "" };
  }
}

function writeAdminLoginState(state) {
  fs.mkdirSync(path.dirname(ADMIN_LOGIN_STATE_FILE), { recursive: true });
  fs.writeFileSync(ADMIN_LOGIN_STATE_FILE, JSON.stringify(state, null, 2));
}

function loadBroadcastLogs(limit = 20) {
  try {
    if (!fs.existsSync(BROADCAST_LOG_FILE)) return [];
    const rows = JSON.parse(fs.readFileSync(BROADCAST_LOG_FILE, "utf8"));
    if (!Array.isArray(rows)) return [];
    return rows.slice(-limit).reverse();
  } catch {
    return [];
  }
}

function appendBroadcastLog(entry) {
  const now = new Date().toISOString();
  const next = {
    at: now,
    botName: String(entry.botName ?? "").trim(),
    mode: String(entry.mode ?? "full").trim(),
    recipients: Number(entry.recipients || 0),
    sent: Number(entry.sent || 0),
    failed: Number(entry.failed || 0),
    ok: Boolean(entry.ok),
    note: String(entry.note ?? "").trim(),
  };
  let rows = [];
  try {
    if (fs.existsSync(BROADCAST_LOG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(BROADCAST_LOG_FILE, "utf8"));
      if (Array.isArray(parsed)) rows = parsed;
    }
  } catch {}
  rows.push(next);
  if (rows.length > 200) rows = rows.slice(rows.length - 200);
  fs.mkdirSync(path.dirname(BROADCAST_LOG_FILE), { recursive: true });
  fs.writeFileSync(BROADCAST_LOG_FILE, JSON.stringify(rows, null, 2));
}

function renderLoginPage(error = "") {
  const tpl = readTemplateFile("login.html");
  return tpl.replace(
    "{{error_block}}",
    error ? `<div class="err">${escapeHtml(error)}</div>` : ""
  );
}

function renderPanelPage({
  botRows,
  statusRows,
  editingId = 0,
  templateEditId = 0,
  templateNew = false,
  notice = "",
  view = "dashboard",
  db,
}) {
  const rowsBySlug = new Map(statusRows.map((r) => [r.slug, r]));
  const totalBots = botRows.length;
  const enabledBots = botRows.filter((b) => Number(b.enabled) !== 0).length;
  const totalMembers = statusRows.reduce((sum, r) => sum + Number(r.members || 0), 0);
  const healthyBots = statusRows.filter((r) => r.healthy).length;
  const totalErrors = statusRows.reduce(
    (sum, r) => sum + Number(r.pollingErrorCount || 0),
    0
  );
  const topBots = [...statusRows]
    .sort((a, b) => Number(b.members) - Number(a.members))
    .slice(0, 5);
  const tableRows = botRows
    .map((b, idx) => {
      const slug = slugify(String(b.name ?? ""), idx);
      const live = rowsBySlug.get(slug);
      const members = live ? live.members : 0;
      const health = live && live.healthy ? "Healthy" : "Not Running";
      const healthClass = live && live.healthy ? "ok" : "warn";
      const enabledLabel = Number(b.enabled) ? "Yes" : "No";
      return `<tr data-searchable="${escapeHtml(
        `${b.name} ${members} ${health} ${enabledLabel}`
      )}"><td>${escapeHtml(b.name)}</td><td>${members}</td><td><span class="pill ${healthClass}">${health}</span></td><td>${enabledLabel}</td><td class="actions">
      <a href="/panel?view=add&edit=${b.id}">Edit</a>
      <form method="POST" action="/panel/delete" onsubmit="return confirm('Delete this bot?');"><input type="hidden" name="id" value="${b.id}"/><button type="submit">Delete</button></form>
      </td></tr>`;
    })
    .join("");
  const current = botRows.find((b) => Number(b.id) === Number(editingId));
  const runningBotOptions = botRows
    .map((b) => {
      const live = statusRows.find((r) => Number(r.id || 0) === Number(b.id || 0));
      if (!live) return null;
      const members = Number(live.members || 0);
      return `<option value="${Number(b.id)}">${escapeHtml(String(b.name ?? ""))} (${members} users)</option>`;
    })
    .filter(Boolean)
    .join("");
  const broadcastHistoryRows = loadBroadcastLogs(25)
    .map(
      (r) =>
        `<tr data-searchable="${escapeHtml(`${r.botName} ${r.mode} ${r.sent} ${r.failed} ${r.note}`)}"><td>${escapeHtml(
          String(r.at ?? "")
        )}</td><td>${escapeHtml(r.botName)}</td><td>${escapeHtml(r.mode)}</td><td>${Number(
          r.recipients || 0
        )}</td><td>${Number(r.sent || 0)}</td><td>${Number(r.failed || 0)}</td><td>${escapeHtml(
          r.note || (r.ok ? "OK" : "Failed")
        )}</td></tr>`
    )
    .join("");
  const buttons = (() => {
    try {
      const parsed = JSON.parse(String(current?.welcome_buttons ?? "[]"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  const buttonAt = (i, key) => escapeHtml(buttons[i - 1]?.[key] ?? "");
  const buttonRowAt = (i) =>
    parseButtonsPerRow(buttons[i - 1]?.perRow ?? current?.buttons_per_row ?? 2);
  const hasButtonAt = (i) => {
    const text = String(buttons[i - 1]?.text ?? "").trim();
    const url = String(buttons[i - 1]?.url ?? "").trim();
    return Boolean(text && /^https?:\/\//i.test(url));
  };
  const dashboardTopBots = topBots
    .map(
      (r) =>
        `<tr data-searchable="${escapeHtml(
          `${r.name} ${Number(r.members || 0)} ${r.healthy ? "Healthy" : "Issue"}`
        )}"><td>${escapeHtml(r.name)}</td><td>${Number(r.members || 0)}</td><td><span class="pill ${
          r.healthy ? "ok" : "warn"
        }">${r.healthy ? "Healthy" : "Issue"}</span></td></tr>`
    )
    .join("");
  const interactedRows = botRows.map((b, idx) => {
    const slug = slugify(String(b.name ?? ""), idx);
    const users = loadInteractedUserIdsForSlug(slug);
    return {
      name: String(b.name ?? ""),
      slug,
      count: users.length,
      users,
    };
  });
  const totalInteractedUsers = interactedRows.reduce((sum, r) => sum + r.count, 0);
  const uniqueInteractedUsers = new Set(
    interactedRows.flatMap((r) => r.users.map((u) => u.chatId))
  ).size;
  const usersTableRows = interactedRows
    .map((r) => {
      const preview =
        r.users.length > 0
          ? r.users
              .slice(0, 6)
              .map((u) => {
                const handle = u.username ? `@${u.username}` : "";
                const fullName = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
                return (
                  handle ||
                  (fullName ? `${escapeHtml(fullName)} (${escapeHtml(u.chatId)})` : escapeHtml(u.chatId))
                );
              })
              .join(", ")
          : "No users yet";
      return `<tr data-searchable="${escapeHtml(`${r.name} ${preview} ${r.count}`)}">
        <td>${escapeHtml(r.name)}</td>
        <td>${r.count}</td>
        <td><code>${preview}</code></td>
      </tr>`;
    })
    .join("");
  const content = (() => {
    if (view === "bots") {
      return `<div class="panel"><h2>All Bots</h2><table><thead><tr><th>Bot</th><th>Members</th><th>Status</th><th>Enabled</th><th>Actions</th></tr></thead><tbody>${tableRows || "<tr><td colspan='5'>No bots found.</td></tr>"}</tbody></table></div>`;
    }
    if (view === "logs") {
      const logRows = statusRows
        .map((r) => {
          const level = r.lastPollingError ? "ERROR" : "INFO";
          const msg = r.lastPollingError
            ? r.lastPollingError
            : `${r.name} operational with ${r.members} members tracked.`;
          return `<div class="log-line" data-searchable="${escapeHtml(
            `${r.name} ${level} ${msg}`
          )}"><span class="log-time">[${new Date()
            .toISOString()
            .slice(11, 19)}]</span><strong>${level}</strong> ${escapeHtml(msg)}</div>`;
        })
        .join("");
      return `<div class="panel"><h2>Global Logs</h2><div class="logs-box">${
        logRows || "<div class='log-line'>No logs yet.</div>"
      }</div></div>`;
    }
    if (view === "analytics") {
      const avg = totalBots > 0 ? (totalMembers / totalBots).toFixed(1) : "0";
      return `<div class="panel"><h2>User Analytics</h2><div class="text-screen">
        <p>Total tracked members: <strong>${totalMembers}</strong></p>
        <p>Average members per bot: <strong>${avg}</strong></p>
        <p>Enabled bot share: <strong>${enabledBots}/${totalBots}</strong></p>
        <p>Polling error count (live session): <strong>${totalErrors}</strong></p>
      </div></div>`;
    }
    if (view === "users") {
      return `<div class="panel"><h2>Interacted Users</h2>
        <div class="text-screen">
          <p>Total interactions recorded: <strong>${totalInteractedUsers}</strong></p>
          <p>Unique user IDs across all bots: <strong>${uniqueInteractedUsers}</strong></p>
        </div>
        <table>
          <thead>
            <tr><th>Bot</th><th>User Count</th><th>Sample User IDs</th></tr>
          </thead>
          <tbody>${usersTableRows || "<tr><td colspan='3'>No user interactions found yet.</td></tr>"}</tbody>
        </table>
      </div>`;
    }
    if (view === "messages") {
      const templates = loadMessageTemplates(db);
      const editId = Number(templateEditId || 0);
      const editingTpl =
        editId > 0 ? templates.find((t) => Number(t.id) === editId) || null : null;
      const unknownEdit = editId > 0 && !editingTpl && !templateNew;
      const showCompose = Boolean(templateNew || (editId > 0 && editingTpl));

      // --- Editor page (dedicated view for Add / Edit) ---
      if (showCompose) {
        const formTitle = escapeHtml(editingTpl?.title ?? "");
        const formBody = escapeHtml(editingTpl?.body ?? "");
        const formImage = escapeHtml(editingTpl?.image_url ?? "");
        const formId = editingTpl ? Number(editingTpl.id) : 0;
        const composePublicId =
          editingTpl != null ? `MSG-${Number(editingTpl.id)}` : "";
        const composeHeading = editingTpl
          ? `Edit ${escapeHtml(composePublicId)}`
          : "New Saved Message";
        const currentBtns = editingTpl
          ? parseMessageTemplateButtons(editingTpl.buttons)
          : [];
        const currentBpr = parseButtonsPerRow(editingTpl?.buttons_per_row ?? 2);
        const mtButtonAt = (i, key) => escapeHtml(currentBtns[i - 1]?.[key] ?? "");
        const mtButtonRowAt = (i) =>
          parseButtonsPerRow(currentBtns[i - 1]?.row ?? currentBpr, currentBpr);
        const mtHasButtonAt = (i) =>
          Boolean(currentBtns[i - 1]?.text || currentBtns[i - 1]?.url);
        const previewImageAttrs =
          editingTpl?.image_url && /^https?:\/\//i.test(String(editingTpl.image_url))
            ? `src="${escapeHtml(String(editingTpl.image_url))}"`
            : "hidden";
        const mtButtonRowsHtml = [1, 2, 3, 4, 5]
          .map(
            (i) =>
              `<div class="row button-row msg-button-row" data-msg-button-row="${i}" ${
                i === 1 || mtHasButtonAt(i) ? "" : "style='display:none'"
              }><label>Button ${i} Text<input name="msg_button_${i}_text" placeholder="Optional" value="${mtButtonAt(i, "text")}"/></label><label>Button ${i} URL<input name="msg_button_${i}_url" placeholder="https://..." value="${mtButtonAt(i, "url")}"/></label><label>Row Size<select name="msg_button_${i}_row"><option value="1" ${
                mtButtonRowAt(i) === 1 ? "selected" : ""
              }>1/1</option><option value="2" ${
                mtButtonRowAt(i) === 2 ? "selected" : ""
              }>1/2</option><option value="3" ${
                mtButtonRowAt(i) === 3 ? "selected" : ""
              }>1/3</option></select></label>${
                i === 1
                  ? "<div></div>"
                  : `<button type="button" class="muted msg-remove-btn" data-remove-msg-button="${i}">Remove</button>`
              }</div>`
          )
          .join("");
        return `<div class="panel">
  <div class="panel-heading-row">
    <h2>${composeHeading}</h2>
    <a class="muted panel-heading-action" href="/panel?view=messages">Back to list</a>
  </div>
  <form class="main message-template-form" method="POST" action="/panel/message-save">
    <input type="hidden" name="id" value="${formId}"/>
    ${
      editingTpl
        ? `<div class="msg-template-id-banner">Reference ID: <code>${escapeHtml(composePublicId)}</code></div>`
        : ""
    }
    <label>Title<input name="title" required maxlength="${MESSAGE_TEMPLATE_TITLE_MAX}" placeholder="e.g. Weekly promo" value="${formTitle}"/></label>
    <label>Message<textarea name="body" required maxlength="${MESSAGE_TEMPLATE_BODY_MAX}" placeholder="Full message text…">${formBody}</textarea></label>
    <div class="row"><label>Image URL (optional)<input name="image_url" maxlength="${MESSAGE_TEMPLATE_IMAGE_MAX}" placeholder="https://…" value="${formImage}"/></label><label>Buttons Per Row
      <select name="buttons_per_row">
        <option value="1" ${currentBpr === 1 ? "selected" : ""}>1</option>
        <option value="2" ${currentBpr === 2 ? "selected" : ""}>2</option>
        <option value="3" ${currentBpr === 3 ? "selected" : ""}>3</option>
      </select>
    </label></div>
    ${mtButtonRowsHtml}
    <div class="submit"><button type="button" class="muted" data-add-msg-button>Add Button</button></div>
    <div class="telegram-preview" data-preview-box>
      <h2>Message Preview</h2>
      <div class="tg-screen">
        <div class="tg-bubble">
          <img class="tg-image" data-message-template-preview-image alt="" ${previewImageAttrs}/>
          <div class="tg-text" data-message-template-preview-text>${formBody || "Message will appear here…"}</div>
          <div class="tg-buttons" data-message-template-preview-buttons></div>
        </div>
      </div>
    </div>
    <div class="submit">
      <button class="primary" type="submit">${editingTpl ? "Update Message" : "Save Message"}</button>
      <a class="muted" href="/panel?view=messages">Cancel</a>
    </div>
  </form>
</div>`;
      }

      // --- List page: masonry gallery (same Telegram shell as editor preview) ---
      const hasCards = templates.length > 0;
      const cards = templates
        .map((t) => {
          const tid = Number(t.id);
          const publicId = `MSG-${tid}`;
          const body = String(t.body ?? "");
          const img = String(t.image_url ?? "").trim();
          const updatedTxt = String(t.updated_at ?? "")
            .slice(0, 16)
            .replace("T", " ");
          const searchBlob = `${publicId} ${t.title ?? ""} ${truncateSingleLine(body, 200)} ${img}`;
          const previewHtml = renderMessageLibraryListPreview(t);
          return `<article class="msg-card" data-searchable="${escapeHtml(searchBlob)}">
        <div class="msg-card-preview">${previewHtml}</div>
        <div class="msg-card-bottom">
          <div class="msg-card-title">${escapeHtml(String(t.title ?? "Untitled"))}</div>
          <div class="msg-card-meta-row">
            <code class="msg-template-id">${escapeHtml(publicId)}</code>
            <span class="msg-card-updated">${escapeHtml(updatedTxt)}</span>
          </div>
          <footer class="msg-card-foot">
            <a class="msg-card-action msg-card-edit" href="/panel?view=messages&edit=${tid}">
              <span class="material-symbols-outlined">edit</span>Edit
            </a>
            <form method="POST" action="/panel/message-delete" onsubmit="return confirm('Delete ${escapeHtml(publicId)}?');">
              <input type="hidden" name="id" value="${tid}"/>
              <button type="submit" class="msg-card-action msg-card-delete">
                <span class="material-symbols-outlined">delete</span>Delete
              </button>
            </form>
          </footer>
        </div>
      </article>`;
        })
        .join("");
      return `<div class="panel">
  <div class="panel-heading-row">
    <h2>Message Library</h2>
    <a class="muted panel-heading-action panel-heading-cta" href="/panel?view=messages&new=1">
      <span class="material-symbols-outlined">add</span>
      Add Message
    </a>
  </div>
  ${unknownEdit ? `<div class="note" style="margin:0 22px 14px;">No saved message with that id.</div>` : ""}
  ${
    hasCards
      ? `<div class="msg-gallery">${cards}</div>`
      : `<div class="msg-empty">No saved messages yet. Click <strong>Add Message</strong> to create one.</div>`
  }
</div>`;
    }
    if (view === "broadcast") {
      const broadcastButtonRowsHtml = [1, 2, 3, 4, 5]
        .map(
          (i) =>
            `<div class="row button-row broadcast-button-row" data-broadcast-button-row="${i}" ${
              i === 1 ? "" : "style='display:none'"
            }><label>Button ${i} Text<input name="broadcast_button_${i}_text" placeholder="Optional"/></label><label>Button ${i} URL<input name="broadcast_button_${i}_url" placeholder="https://..."/></label><label>Row Size<select name="broadcast_button_${i}_row"><option value="1">1/1</option><option value="2" selected>1/2</option><option value="3">1/3</option></select></label>${
              i === 1
                ? "<div></div>"
                : `<button type="button" class="muted broadcast-remove-btn" data-remove-broadcast-button="${i}">Remove</button>`
            }</div>`
        )
        .join("");
      return `<div class="panel"><h2>Broadcast</h2>
<form class="main" method="POST" action="/panel/broadcast">
<div class="row"><label>Select Bot(s)
  <select name="bot_ids" multiple required>
    ${runningBotOptions}
  </select>
</label><label>Test Chat ID (optional)<input name="test_chat_id" placeholder="123456789"/></label></div>
<div class="hint">Hold Cmd/Ctrl to select multiple bots.</div>
<label>Message<textarea name="broadcast_message" required placeholder="Type broadcast message..."></textarea></label>
<div class="row"><label>Broadcast Image URL (optional)<input name="broadcast_image" placeholder="https://..."/></label><label>Buttons Per Row (fallback)
  <select name="broadcast_buttons_per_row">
    <option value="1">1</option>
    <option value="2" selected>2</option>
    <option value="3">3</option>
  </select>
</label></div>
${broadcastButtonRowsHtml}
<div class="submit"><button type="button" class="muted" data-add-broadcast-button>Add Button</button></div>
<div class="telegram-preview" data-preview-box>
  <h2>Broadcast Preview</h2>
  <div class="tg-screen">
    <div class="tg-bubble">
      <img class="tg-image" data-broadcast-preview-image alt="" hidden/>
      <div class="tg-text" data-broadcast-preview-text>Broadcast message will appear here...</div>
      <div class="tg-buttons" data-broadcast-preview-buttons></div>
    </div>
  </div>
</div>
<label class="check"><input type="checkbox" name="test_mode" /> Test mode (send only once to Test Chat ID)</label>
<div class="submit"><button class="primary" type="submit">Send Broadcast</button></div>
</form>
<table>
  <thead><tr><th>Time</th><th>Bot</th><th>Mode</th><th>Recipients</th><th>Sent</th><th>Failed</th><th>Note</th></tr></thead>
  <tbody>${broadcastHistoryRows || "<tr><td colspan='7'>No broadcast history yet.</td></tr>"}</tbody>
</table>
</div>`;
    }
    if (view === "add") {
      return `<div class="panel"><h2>${current ? "Edit Bot" : "Add Bot"}</h2>
<form class="main" method="POST" action="/panel/save">
<input type="hidden" name="id" value="${current ? current.id : ""}"/>
<div class="row"><label>Name<input name="name" required value="${escapeHtml(current?.name ?? "")}"/></label><label>Token<input name="token" required value="${escapeHtml(current?.token ?? "")}"/></label></div>
<div class="row"><label>Admin IDs (comma)<input name="admin_ids" value="${escapeHtml(current?.admin_ids ?? "")}"/></label><label>Group Chat ID<input name="group_chat_id" value="${escapeHtml(current?.group_chat_id ?? "")}"/></label></div>
<div class="row"><label>Buttons Per Row
  <select name="buttons_per_row">
    <option value="1" ${parseButtonsPerRow(current?.buttons_per_row ?? 2) === 1 ? "selected" : ""}>1</option>
    <option value="2" ${parseButtonsPerRow(current?.buttons_per_row ?? 2) === 2 ? "selected" : ""}>2</option>
    <option value="3" ${parseButtonsPerRow(current?.buttons_per_row ?? 2) === 3 ? "selected" : ""}>3</option>
  </select>
</label><div></div></div>
<label>Welcome Message<textarea name="welcome_message">${escapeHtml(current?.welcome_message ?? "")}</textarea></label>
<div class="row"><label>Welcome Image URL<input name="welcome_image" value="${escapeHtml(current?.welcome_image ?? "")}"/></label><label>Channel URL<input name="channel_url" value="${escapeHtml(current?.channel_url ?? "")}"/></label></div>
<div class="row button-row save-button-row" data-save-button-row="1"><label>Button 1 Text<input name="button_1_text" value="${buttonAt(1, "text")}"/></label><label>Button 1 URL<input name="button_1_url" value="${buttonAt(1, "url")}"/></label><label>Row Size<select name="button_1_row"><option value="1" ${buttonRowAt(1) === 1 ? "selected" : ""}>1/1</option><option value="2" ${buttonRowAt(1) === 2 ? "selected" : ""}>1/2</option><option value="3" ${buttonRowAt(1) === 3 ? "selected" : ""}>1/3</option></select></label><div></div></div>
<div class="row button-row save-button-row" data-save-button-row="2" ${hasButtonAt(2) ? "" : "style='display:none'"}><label>Button 2 Text<input name="button_2_text" value="${buttonAt(2, "text")}"/></label><label>Button 2 URL<input name="button_2_url" value="${buttonAt(2, "url")}"/></label><label>Row Size<select name="button_2_row"><option value="1" ${buttonRowAt(2) === 1 ? "selected" : ""}>1/1</option><option value="2" ${buttonRowAt(2) === 2 ? "selected" : ""}>1/2</option><option value="3" ${buttonRowAt(2) === 3 ? "selected" : ""}>1/3</option></select></label><button type="button" class="muted save-remove-btn" data-remove-save-button="2">Remove</button></div>
<div class="row button-row save-button-row" data-save-button-row="3" ${hasButtonAt(3) ? "" : "style='display:none'"}><label>Button 3 Text<input name="button_3_text" value="${buttonAt(3, "text")}"/></label><label>Button 3 URL<input name="button_3_url" value="${buttonAt(3, "url")}"/></label><label>Row Size<select name="button_3_row"><option value="1" ${buttonRowAt(3) === 1 ? "selected" : ""}>1/1</option><option value="2" ${buttonRowAt(3) === 2 ? "selected" : ""}>1/2</option><option value="3" ${buttonRowAt(3) === 3 ? "selected" : ""}>1/3</option></select></label><button type="button" class="muted save-remove-btn" data-remove-save-button="3">Remove</button></div>
<div class="row button-row save-button-row" data-save-button-row="4" ${hasButtonAt(4) ? "" : "style='display:none'"}><label>Button 4 Text<input name="button_4_text" value="${buttonAt(4, "text")}"/></label><label>Button 4 URL<input name="button_4_url" value="${buttonAt(4, "url")}"/></label><label>Row Size<select name="button_4_row"><option value="1" ${buttonRowAt(4) === 1 ? "selected" : ""}>1/1</option><option value="2" ${buttonRowAt(4) === 2 ? "selected" : ""}>1/2</option><option value="3" ${buttonRowAt(4) === 3 ? "selected" : ""}>1/3</option></select></label><button type="button" class="muted save-remove-btn" data-remove-save-button="4">Remove</button></div>
<div class="row button-row save-button-row" data-save-button-row="5" ${hasButtonAt(5) ? "" : "style='display:none'"}><label>Button 5 Text<input name="button_5_text" value="${buttonAt(5, "text")}"/></label><label>Button 5 URL<input name="button_5_url" value="${buttonAt(5, "url")}"/></label><label>Row Size<select name="button_5_row"><option value="1" ${buttonRowAt(5) === 1 ? "selected" : ""}>1/1</option><option value="2" ${buttonRowAt(5) === 2 ? "selected" : ""}>1/2</option><option value="3" ${buttonRowAt(5) === 3 ? "selected" : ""}>1/3</option></select></label><button type="button" class="muted save-remove-btn" data-remove-save-button="5">Remove</button></div>
<div class="submit"><button type="button" class="muted" data-add-save-button>Add Button</button></div>
<div class="telegram-preview" data-preview-box>
  <h2>Message Preview</h2>
  <div class="tg-screen">
    <div class="tg-bubble">
      <img class="tg-image" data-preview-image alt="" ${
        current?.welcome_image
          ? `src="${escapeHtml(current.welcome_image)}"`
          : "hidden"
      }/>
      <div class="tg-text" data-preview-text>${escapeHtml(current?.welcome_message ?? "") || "Welcome message will appear here..."}</div>
      <div class="tg-buttons" data-preview-buttons></div>
    </div>
  </div>
</div>
<label class="check"><input type="checkbox" name="enabled" ${Number(current?.enabled ?? 1) ? "checked" : ""}/> Enabled</label>
<div class="submit"><button class="primary" type="submit">Save Bot</button><a class="muted" href="/panel?view=add">Reset</a></div></form></div>`;
    }
    return `<section class="dashboard-hero">
      <h2 class="hero-title">Fleet Command</h2>
      <p class="hero-sub">Real-time oversight and resource allocation for your Telegram bot ecosystem.</p>
      <div class="stats-grid">
        <div class="stat"><div class="k">Active Fleet</div><div class="v">${healthyBots}</div></div>
        <div class="stat"><div class="k">Total Users</div><div class="v">${totalMembers}</div></div>
        <div class="stat"><div class="k">Total Members</div><div class="v">${totalMembers}</div></div>
        <div class="stat"><div class="k">Enabled Bots</div><div class="v">${enabledBots}</div></div>
        <div class="stat"><div class="k">API Reliability Alerts</div><div class="v">${totalErrors}</div></div>
      </div>
    </section>
    <section class="dashboard-grid">
      <div class="panel"><h2>Top Bots by Members</h2><table><thead><tr><th>Bot</th><th>Members</th><th>Status</th></tr></thead><tbody>${
        dashboardTopBots || "<tr><td colspan='3'>No member data yet.</td></tr>"
      }</tbody></table></div>
      <div class="panel"><h2>Quick Insights</h2><ul class="mini-list">
        <li class="mini-item" data-searchable="live coverage healthy bots"><div><div class="name">Live Coverage</div><div class="sub">Bots currently healthy</div></div><div class="num">${healthyBots}/${totalBots}</div></li>
        <li class="mini-item" data-searchable="member base tracked users"><div><div class="name">Member Base</div><div class="sub">Total tracked private users</div></div><div class="num">${totalMembers}</div></li>
        <li class="mini-item" data-searchable="risk alerts polling errors"><div><div class="name">Risk Alerts</div><div class="sub">Polling conflicts and other errors</div></div><div class="num">${totalErrors}</div></li>
      </ul></div>
    </section>`;
  })();
  const tpl = readTemplateFile("panel.html");
  return tpl
    .replace("{{dashboard_active}}", view === "dashboard" ? "active" : "")
    .replace("{{bots_active}}", view === "bots" ? "active" : "")
    .replace("{{logs_active}}", view === "logs" ? "active" : "")
    .replace("{{analytics_active}}", view === "analytics" ? "active" : "")
    .replace("{{users_active}}", view === "users" ? "active" : "")
    .replace("{{broadcast_active}}", view === "broadcast" ? "active" : "")
    .replace("{{messages_active}}", view === "messages" ? "active" : "")
    .replace("{{add_active}}", view === "add" ? "active" : "")
    .replace("{{content}}", content)
    .replace(
      "{{notice_block}}",
      notice ? `<div class="panel"><div class="note">${escapeHtml(notice)}</div></div>` : ""
    );
}

function startAdminPanel(db, instances) {
  const sessions = new Set();
  const isAuthed = (req) => sessions.has(parseCookies(req).session || "");
  const runtimeOpsByBotId = new Map();
  const queueRuntimeOp = (id, task) => {
    const botId = Number(id || 0);
    if (!botId) return Promise.resolve();
    const prev = runtimeOpsByBotId.get(botId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (runtimeOpsByBotId.get(botId) === next) {
          runtimeOpsByBotId.delete(botId);
        }
      });
    runtimeOpsByBotId.set(botId, next);
    return next;
  };
  const findInstanceIndexByBotId = (id) =>
    instances.findIndex((item) => Number(item?.cfg?.id || 0) === Number(id || 0));
  const stopInstanceAt = async (idx) => {
    if (idx < 0 || idx >= instances.length) return;
    const inst = instances[idx];
    try {
      await inst.bot.stopPolling({ cancel: true });
    } catch {}
    try {
      inst.bot.removeAllListeners();
    } catch {}
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch {}
    instances.splice(idx, 1);
  };
  const applyRuntimeForBotId = async (id) => {
    const botId = Number(id || 0);
    if (!botId) return;
    await queueRuntimeOp(botId, async () => {
      const enabledConfigs = loadEnabledConfigsFromDb(db);
      const nextCfg = enabledConfigs.find((c) => Number(c.id || 0) === botId);
      const idx = findInstanceIndexByBotId(botId);
      const current = idx >= 0 ? instances[idx] : null;

      // If token/slug are unchanged, update config in-place without poller restart.
      // This avoids any temporary overlap while applying message/button edits.
      if (
        current &&
        nextCfg &&
        String(current.cfg.token) === String(nextCfg.token) &&
        String(current.cfg.slug) === String(nextCfg.slug)
      ) {
        current.cfg.name = nextCfg.name;
        current.cfg.adminIds = nextCfg.adminIds;
        current.cfg.enabled = nextCfg.enabled;
        current.cfg.welcomeExtra = nextCfg.welcomeExtra;
        current.cfg.welcomeImage = nextCfg.welcomeImage;
        current.cfg.groupChatId = nextCfg.groupChatId;
        current.cfg.channelUrl = nextCfg.channelUrl;
        current.cfg.welcomeButtons = nextCfg.welcomeButtons;
        current.cfg.welcomeButtonsPerRow = nextCfg.welcomeButtonsPerRow;
        current.cfg.isFirstAndheriBot = nextCfg.isFirstAndheriBot;
        current.runtime.name = nextCfg.name;
        return;
      }

      await stopInstanceAt(idx);
      if (!nextCfg) return;
      instances.push(startBot(nextCfg));
    });
  };
  const runPanelBroadcastOne = async ({
    botId,
    message,
    image,
    testMode,
    testChatId,
    broadcastButtons,
    broadcastButtonsPerRow,
  }) => {
    const instance = instances.find((i) => Number(i?.cfg?.id || 0) === Number(botId || 0));
    if (!instance) {
      appendBroadcastLog({
        botName: `#${Number(botId || 0)}`,
        mode: testMode ? "test" : "full",
        ok: false,
        note: "Selected bot is not running",
      });
      return { ok: false, sent: 0, failed: 0, recipients: 0, notice: "Bot not running." };
    }
    const botName = String(instance.cfg?.name ?? `#${Number(botId || 0)}`);
    const text = String(message ?? "").trim();
    if (!text) {
      appendBroadcastLog({
        botName,
        mode: testMode ? "test" : "full",
        ok: false,
        note: "Empty broadcast message",
      });
      return { ok: false, sent: 0, failed: 0, recipients: 0, notice: "Broadcast message is required." };
    }
    const recipients = instance.store.loadChatIds();
    const buttons = Array.isArray(broadcastButtons) ? broadcastButtons : [];
    const fb = parseButtonsPerRow(broadcastButtonsPerRow ?? 2);
    const replyMarkup = buildUrlButtonReplyMarkup(buttons, fb);
    const sendOptions = replyMarkup
      ? { disable_web_page_preview: false, reply_markup: replyMarkup }
      : { disable_web_page_preview: false };
    const photoUrl = String(image ?? "").trim();
    const sendBroadcast = (target) => {
      if (photoUrl && /^https?:\/\//i.test(photoUrl)) {
        return instance.bot.sendPhoto(target, photoUrl, {
          caption: text,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
      }
      return instance.bot.sendMessage(target, text, sendOptions);
    };
    if (testMode) {
      const target = Number(testChatId || 0);
      if (!target) {
        appendBroadcastLog({
          botName,
          mode: "test",
          ok: false,
          note: "Missing test chat id",
        });
        return { ok: false, sent: 0, failed: 0, recipients: 0, notice: "Test mode needs a valid Test Chat ID." };
      }
      try {
        await sendBroadcast(target);
        appendBroadcastLog({
          botName,
          mode: "test",
          recipients: 1,
          sent: 1,
          failed: 0,
          ok: true,
          note: `Test sent to ${target}`,
        });
        return { ok: true, sent: 1, failed: 0, recipients: 1, notice: "Test broadcast sent successfully." };
      } catch (err) {
        appendBroadcastLog({
          botName,
          mode: "test",
          recipients: 1,
          sent: 0,
          failed: 1,
          ok: false,
          note: `Test send failed: ${String(err?.message ?? "unknown")}`,
        });
        return {
          ok: false,
          sent: 0,
          failed: 1,
          recipients: 1,
          notice: `Test send failed: ${String(err?.message ?? "unknown")}`,
        };
      }
    }
    if (recipients.length === 0) {
      appendBroadcastLog({
        botName,
        mode: "full",
        recipients: 0,
        sent: 0,
        failed: 0,
        ok: false,
        note: "No interacted users found",
      });
      return { ok: false, sent: 0, failed: 0, recipients: 0, notice: "No interacted users found for this bot." };
    }
    let sent = 0;
    let failed = 0;
    for (const uid of recipients) {
      try {
        await sendBroadcast(uid);
        sent += 1;
      } catch {
        failed += 1;
      }
      await sleep(DELAY_MS);
    }
    appendBroadcastLog({
      botName,
      mode: "full",
      recipients: recipients.length,
      sent,
      failed,
      ok: true,
      note: "Completed",
    });
    return {
      ok: true,
      sent,
      failed,
      recipients: recipients.length,
      notice: `Broadcast done: ${sent} sent, ${failed} failed.`,
    };
  };
  const runPanelBroadcast = async ({
    botIds,
    message,
    image,
    testMode,
    testChatId,
    broadcastButtons,
    broadcastButtonsPerRow,
  }) => {
    const ids = Array.isArray(botIds)
      ? [...new Set(botIds.map((x) => Number(x || 0)).filter((n) => n > 0))]
      : [];
    if (ids.length === 0) return { ok: false, notice: "Select at least one bot." };
    let totalRecipients = 0;
    let totalSent = 0;
    let totalFailed = 0;
    let okCount = 0;
    for (const id of ids) {
      const r = await runPanelBroadcastOne({
        botId: id,
        message,
        image,
        testMode,
        testChatId,
        broadcastButtons,
        broadcastButtonsPerRow,
      });
      totalRecipients += Number(r.recipients || 0);
      totalSent += Number(r.sent || 0);
      totalFailed += Number(r.failed || 0);
      if (r.ok) okCount += 1;
    }
    const mode = testMode ? "test" : "full";
    return {
      ok: okCount > 0,
      notice: `Broadcast (${mode}) across ${ids.length} bot(s): recipients ${totalRecipients}, sent ${totalSent}, failed ${totalFailed}.`,
    };
  };
  const redirect = (res, to) => {
    res.writeHead(302, { Location: to });
    res.end();
  };
  const readForm = async (req) => new URLSearchParams(await parseBody(req));
  const saveStmt = db.prepare(`
    INSERT INTO bots (
      name, token, admin_ids, enabled, welcome_message, welcome_image, group_chat_id,
      channel_url, random_channel_urls, welcome_buttons, buttons_per_row, button_layout, created_at, updated_at
    ) VALUES (
      @name, @token, @admin_ids, @enabled, @welcome_message, @welcome_image, @group_chat_id,
      @channel_url, @random_channel_urls, @welcome_buttons, @buttons_per_row, @button_layout, @created_at, @updated_at
    )
  `);
  const updateStmt = db.prepare(`
    UPDATE bots SET
      name=@name, token=@token, admin_ids=@admin_ids, enabled=@enabled, welcome_message=@welcome_message,
      welcome_image=@welcome_image, group_chat_id=@group_chat_id, channel_url=@channel_url,
      random_channel_urls=@random_channel_urls, welcome_buttons=@welcome_buttons,
      buttons_per_row=@buttons_per_row, button_layout=@button_layout, updated_at=@updated_at
    WHERE id=@id
  `);
  const deleteStmt = db.prepare("DELETE FROM bots WHERE id = ?");
  const messageInsertStmt = db.prepare(`
    INSERT INTO message_templates (title, body, image_url, buttons, buttons_per_row, created_at, updated_at)
    VALUES (@title, @body, @image_url, @buttons, @buttons_per_row, @created_at, @updated_at)
  `);
  const messageUpdateStmt = db.prepare(`
    UPDATE message_templates
    SET title=@title, body=@body, image_url=@image_url, buttons=@buttons,
        buttons_per_row=@buttons_per_row, updated_at=@updated_at
    WHERE id=@id
  `);
  const messageDeleteStmt = db.prepare("DELETE FROM message_templates WHERE id = ?");

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && reqUrl.pathname === "/assets/login.css") {
        const css = readTemplateFile("assets/login.css");
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
        res.end(css);
        return;
      }
      if (req.method === "GET" && reqUrl.pathname === "/assets/panel.css") {
        const css = readTemplateFile("assets/panel.css");
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
        res.end(css);
        return;
      }
      if (req.method === "GET" && reqUrl.pathname === "/login") {
        const loginState = readAdminLoginState();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          renderLoginPage(
            loginState.locked
              ? "Login is locked after 3 failed attempts. Reset from server SSH."
              : ""
          )
        );
        return;
      }
      if (req.method === "POST" && reqUrl.pathname === "/login") {
        const loginState = readAdminLoginState();
        if (loginState.locked) {
          res.writeHead(423, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderLoginPage("Login is locked. Reset from server SSH."));
          return;
        }
        const form = await readForm(req);
        const user = String(form.get("username") ?? "").trim();
        const pass = String(form.get("password") ?? "");
        if (user === PANEL_USERNAME && pass === PANEL_PASSWORD && PANEL_PASSWORD) {
          writeAdminLoginState({ failedAttempts: 0, locked: false, lockedAt: "" });
          const sid = crypto.randomBytes(24).toString("hex");
          sessions.add(sid);
          res.writeHead(302, {
            Location: "/panel",
            "Set-Cookie": `session=${sid}; HttpOnly; SameSite=Lax; Path=/`,
          });
          res.end();
          return;
        }
        const nextFailedAttempts = Number(loginState.failedAttempts || 0) + 1;
        const shouldLock = nextFailedAttempts >= PANEL_MAX_FAILED_ATTEMPTS;
        writeAdminLoginState({
          failedAttempts: nextFailedAttempts,
          locked: shouldLock,
          lockedAt: shouldLock ? new Date().toISOString() : "",
        });
        res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          renderLoginPage(
            shouldLock
              ? "Login locked after 3 failed attempts. Reset from server SSH."
              : `Invalid credentials. Attempt ${nextFailedAttempts}/${PANEL_MAX_FAILED_ATTEMPTS}.`
          )
        );
        return;
      }
      if (req.method === "GET" && reqUrl.pathname === "/logout") {
        const sid = parseCookies(req).session || "";
        sessions.delete(sid);
        res.writeHead(302, {
          Location: "/login",
          "Set-Cookie": "session=; Max-Age=0; Path=/",
        });
        res.end();
        return;
      }
      if (!isAuthed(req)) {
        redirect(res, "/login");
        return;
      }
      if (req.method === "GET" && (reqUrl.pathname === "/" || reqUrl.pathname === "/panel")) {
        const rows = loadBotRows(db);
        const live = getStatusRows(instances);
        const edit = Number(reqUrl.searchParams.get("edit") || 0);
        const notice = reqUrl.searchParams.get("notice") || "";
        const view = String(reqUrl.searchParams.get("view") || "dashboard");
        const editingBotId = view === "add" ? edit : 0;
        const templateNew = view === "messages" && String(reqUrl.searchParams.get("new") || "") === "1";
        const templateEditId = view === "messages" && !templateNew ? edit : 0;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          renderPanelPage({
            botRows: rows,
            statusRows: live,
            editingId: editingBotId,
            templateEditId,
            templateNew,
            notice,
            view,
            db,
          })
        );
        return;
      }
      if (req.method === "POST" && reqUrl.pathname === "/panel/save") {
        const form = await readForm(req);
        const buttons = parseButtonsFromForm(form);
        const payload = {
          id: Number(form.get("id") || 0),
          name: String(form.get("name") ?? "").trim(),
          token: String(form.get("token") ?? "").trim(),
          admin_ids: String(form.get("admin_ids") ?? "").trim(),
          enabled: form.get("enabled") ? 1 : 0,
          welcome_message: String(form.get("welcome_message") ?? "").trim(),
          welcome_image: String(form.get("welcome_image") ?? "").trim(),
          group_chat_id: String(form.get("group_chat_id") ?? "").trim(),
          channel_url: String(form.get("channel_url") ?? "").trim(),
          random_channel_urls: "",
          welcome_buttons: JSON.stringify(buttons),
          buttons_per_row: parseButtonsPerRow(form.get("buttons_per_row") ?? 2),
          button_layout: "",
          updated_at: new Date().toISOString(),
        };
        if (!payload.name || !payload.token) {
          redirect(res, "/panel?view=add&notice=Name%20and%20token%20are%20required");
          return;
        }
        if (payload.id > 0) {
          updateStmt.run(payload);
          await applyRuntimeForBotId(payload.id);
          redirect(
            res,
            "/panel?view=bots&notice=Bot%20updated%20and%20applied%20live."
          );
          return;
        }
        const result = saveStmt.run({ ...payload, created_at: payload.updated_at });
        await applyRuntimeForBotId(result.lastInsertRowid);
        redirect(
          res,
          "/panel?view=bots&notice=Bot%20created%20and%20applied%20live."
        );
        return;
      }
      if (req.method === "POST" && reqUrl.pathname === "/panel/broadcast") {
        const form = await readForm(req);
        const botIds = String(form.getAll("bot_ids").join(","))
          .split(",")
          .map((s) => Number(String(s).trim()))
          .filter((n) => !Number.isNaN(n) && n > 0);
        const result = await runPanelBroadcast({
          botIds,
          message: String(form.get("broadcast_message") ?? "").trim(),
          image: String(form.get("broadcast_image") ?? "").trim(),
          testMode: Boolean(form.get("test_mode")),
          testChatId: Number(form.get("test_chat_id") || 0),
          broadcastButtons: parseBroadcastButtonsFromForm(form),
          broadcastButtonsPerRow: parseButtonsPerRow(form.get("broadcast_buttons_per_row") ?? 2),
        });
        redirect(
          res,
          `/panel?view=broadcast&notice=${encodeURIComponent(result.notice)}`
        );
        return;
      }
      if (req.method === "POST" && reqUrl.pathname === "/panel/delete") {
        const form = await readForm(req);
        const id = Number(form.get("id") || 0);
        if (id > 0) {
          await stopInstanceAt(findInstanceIndexByBotId(id));
          deleteStmt.run(id);
        }
        redirect(
          res,
          "/panel?view=bots&notice=Bot%20deleted%20and%20stopped%20live."
        );
        return;
      }
      if (req.method === "POST" && reqUrl.pathname === "/panel/message-save") {
        const form = await readForm(req);
        const id = Number(form.get("id") || 0);
        const rawButtons = parseMessageTemplateButtonsFromForm(form);
        const { title, body, imageUrl, buttons, buttonsPerRow } =
          sanitizeMessageTemplateFields({
            title: form.get("title"),
            body: form.get("body"),
            image_url: form.get("image_url"),
            buttons: rawButtons,
            buttons_per_row: form.get("buttons_per_row") ?? 2,
          });
        if (!title || !body) {
          redirect(
            res,
            `/panel?view=messages&notice=${encodeURIComponent("Title and message are required.")}`
          );
          return;
        }
        const buttonsJson = JSON.stringify(buttons);
        const now = new Date().toISOString();
        if (id > 0) {
          const row = db.prepare("SELECT id FROM message_templates WHERE id = ?").get(id);
          if (!row) {
            redirect(
              res,
              `/panel?view=messages&notice=${encodeURIComponent("Saved message not found.")}`
            );
            return;
          }
          messageUpdateStmt.run({
            id,
            title,
            body,
            image_url: imageUrl,
            buttons: buttonsJson,
            buttons_per_row: buttonsPerRow,
            updated_at: now,
          });
          redirect(
            res,
            `/panel?view=messages&edit=${id}&notice=${encodeURIComponent("Message updated.")}`
          );
          return;
        }
        const ins = messageInsertStmt.run({
          title,
          body,
          image_url: imageUrl,
          buttons: buttonsJson,
          buttons_per_row: buttonsPerRow,
          created_at: now,
          updated_at: now,
        });
        const newId = Number(ins.lastInsertRowid || 0);
        redirect(
          res,
          newId > 0
            ? `/panel?view=messages&edit=${newId}&notice=${encodeURIComponent("Message saved.")}`
            : `/panel?view=messages&notice=${encodeURIComponent("Message saved.")}`
        );
        return;
      }
      if (req.method === "POST" && reqUrl.pathname === "/panel/message-delete") {
        const form = await readForm(req);
        const id = Number(form.get("id") || 0);
        if (id > 0) messageDeleteStmt.run(id);
        redirect(
          res,
          `/panel?view=messages&notice=${encodeURIComponent("Message deleted.")}`
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Server error");
      console.error("Panel error:", err.message);
    }
  });

  server.listen(PANEL_PORT, PANEL_HOST, () => {
    console.log(`Admin panel: http://${PANEL_HOST}:${PANEL_PORT}/login`);
  });
}

const { configs, source, db } = resolveConfigs();
console.log(`Config: ${configs.length} bot(s) from ${source}`);
const instances = [];
for (const cfg of configs) {
  instances.push(startBot(cfg));
}
console.log("All bots polling. Press Ctrl+C to stop.");
startAdminPanel(db, instances);
