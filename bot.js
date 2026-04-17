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
const DB_FILE = path.join(ROOT, "data", "config.sqlite");
const TEMPLATES_DIR = path.join(ROOT, "templates");

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
    ["button_1_text", "button_1_url"],
    ["button_2_text", "button_2_url"],
    ["button_3_text", "button_3_url"],
    ["button_4_text", "button_4_url"],
    ["button_5_text", "button_5_url"],
  ];

  for (const [textKey, urlKey] of inlinePairs) {
    const text = String(norm[textKey] ?? "").trim();
    const url = String(norm[urlKey] ?? "").trim();
    if (text && /^https?:\/\//i.test(url)) {
      buttons.push({ text, url });
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
  const randomChannelUrls = parseUrlList(
    norm.random_channel_urls ??
      norm.random_channels ??
      norm.channel_urls ??
      ""
  );
  const welcomeButtons = parseWelcomeButtons(norm);

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
    randomChannelUrls,
    welcomeButtons,
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
    randomChannelUrls: parseUrlList(process.env.RANDOM_CHANNEL_URLS ?? ""),
    welcomeButtons,
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
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
    random_channel_urls: (cfg.randomChannelUrls ?? []).join(","),
    welcome_buttons: JSON.stringify(cfg.welcomeButtons ?? []),
  };
}

function dbRowToConfig(row, index) {
  let buttons = [];
  try {
    const parsed = JSON.parse(String(row.welcome_buttons ?? "[]"));
    if (Array.isArray(parsed)) {
      buttons = parsed
        .map((b) => ({ text: String(b.text ?? "").trim(), url: String(b.url ?? "").trim() }))
        .filter((b) => b.text && /^https?:\/\//i.test(b.url));
    }
  } catch {}

  return {
    name: String(row.name ?? "").trim() || `bot_${index + 1}`,
    slug: slugify(String(row.name ?? ""), index),
    token: String(row.token ?? "").trim(),
    adminIds: parseAdminIds(row.admin_ids ?? ""),
    enabled: Number(row.enabled) !== 0,
    welcomeExtra: String(row.welcome_message ?? "").trim(),
    welcomeImage: String(row.welcome_image ?? "").trim(),
    groupChatId: Number(row.group_chat_id) || null,
    channelUrl: String(row.channel_url ?? "").trim(),
    randomChannelUrls: parseUrlList(row.random_channel_urls ?? ""),
    welcomeButtons: buttons,
    isFirstAndheriBot: false,
  };
}

function seedSqliteIfEmpty(db, seedConfigs) {
  const count = Number(db.prepare("SELECT COUNT(*) AS c FROM bots").get().c || 0);
  if (count > 0 || seedConfigs.length === 0) return false;
  const insert = db.prepare(`
    INSERT INTO bots (
      name, token, admin_ids, enabled, welcome_message, welcome_image,
      group_chat_id, channel_url, random_channel_urls, welcome_buttons, created_at, updated_at
    ) VALUES (
      @name, @token, @admin_ids, @enabled, @welcome_message, @welcome_image,
      @group_chat_id, @channel_url, @random_channel_urls, @welcome_buttons, @created_at, @updated_at
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

  function loadChatIds() {
    try {
      const dir = path.dirname(usersFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(usersFile)) return [];
      const data = JSON.parse(fs.readFileSync(usersFile, "utf8"));
      const ids = data.chatIds;
      if (!Array.isArray(ids)) return [];
      return [...new Set(ids.map(Number).filter((n) => !Number.isNaN(n)))];
    } catch {
      return [];
    }
  }

  function saveChatIds(ids) {
    const dir = path.dirname(usersFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(usersFile, JSON.stringify({ chatIds: ids }, null, 2), "utf8");
  }

  function registerUser(chatId) {
    registerQueue = registerQueue.then(() => {
      const ids = loadChatIds();
      if (ids.includes(chatId)) return;
      ids.push(chatId);
      saveChatIds(ids);
    });
  }

  return { loadChatIds, registerUser };
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
      return {
        inline_keyboard: cfg.welcomeButtons.map((button) => [button]),
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
    if (msg.chat.type === "private") registerUser(msg.chat.id);

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
  return { cfg, store, runtime };
}

function countMembers(usersFile) {
  try {
    if (!fs.existsSync(usersFile)) return 0;
    const data = JSON.parse(fs.readFileSync(usersFile, "utf8"));
    const ids = Array.isArray(data.chatIds) ? data.chatIds : [];
    return [...new Set(ids.map(Number).filter((n) => !Number.isNaN(n)))].length;
  } catch {
    return 0;
  }
}

function getStatusRows(instances) {
  return instances.map(({ runtime }) => {
    const members = countMembers(runtime.usersFile);
    return {
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
  for (let i = 1; i <= 5; i += 1) {
    const text = String(form.get(`button_${i}_text`) ?? "").trim();
    const url = String(form.get(`button_${i}_url`) ?? "").trim();
    if (text && /^https?:\/\//i.test(url)) {
      buttons.push({ text, url });
    }
  }
  return buttons;
}

function loadBotRows(db) {
  return db.prepare("SELECT * FROM bots ORDER BY id ASC").all();
}

function readTemplateFile(name) {
  return fs.readFileSync(path.join(TEMPLATES_DIR, name), "utf8");
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
  notice = "",
  view = "dashboard",
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
      return `<tr><td>${escapeHtml(b.name)}</td><td>${members}</td><td><span class="pill ${healthClass}">${health}</span></td><td>${Number(b.enabled) ? "Yes" : "No"}</td><td class="actions">
      <a href="/panel?view=add&edit=${b.id}">Edit</a>
      <form method="POST" action="/panel/delete" onsubmit="return confirm('Delete this bot?');"><input type="hidden" name="id" value="${b.id}"/><button type="submit">Delete</button></form>
      </td></tr>`;
    })
    .join("");
  const current = botRows.find((b) => Number(b.id) === Number(editingId));
  const buttons = (() => {
    try {
      const parsed = JSON.parse(String(current?.welcome_buttons ?? "[]"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  const buttonAt = (i, key) => escapeHtml(buttons[i - 1]?.[key] ?? "");
  const dashboardTopBots = topBots
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.name)}</td><td>${Number(r.members || 0)}</td><td><span class="pill ${
          r.healthy ? "ok" : "warn"
        }">${r.healthy ? "Healthy" : "Issue"}</span></td></tr>`
    )
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
          return `<div class="log-line"><span class="log-time">[${new Date()
            .toISOString()
            .slice(11, 19)}]</span><strong>${level}</strong> ${escapeHtml(msg)}</div>`;
        })
        .join("");
      return `<div class="panel"><h2>Global Logs</h2><div class="logs-box">${
        logRows || "<div class='log-line'>No logs yet.</div>"
      }</div></div>`;
    }
    if (view === "config") {
      return `<div class="panel"><h2>API Config</h2><div class="text-screen">
        <p>Primary endpoint: <strong>Telegram Bot API (long polling)</strong></p>
        <p>Active bots: <strong>${totalBots}</strong></p>
        <p>Healthy bots: <strong>${healthyBots}</strong></p>
        <p>SQLite source: <strong>data/config.sqlite</strong></p>
        <p>Panel auth: <strong>single admin via .env</strong></p>
      </div></div>`;
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
    if (view === "add") {
      return `<div class="panel"><h2>${current ? "Edit Bot" : "Add Bot"}</h2>
<form class="main" method="POST" action="/panel/save">
<input type="hidden" name="id" value="${current ? current.id : ""}"/>
<div class="row"><label>Name<input name="name" required value="${escapeHtml(current?.name ?? "")}"/></label><label>Token<input name="token" required value="${escapeHtml(current?.token ?? "")}"/></label></div>
<div class="row"><label>Admin IDs (comma)<input name="admin_ids" value="${escapeHtml(current?.admin_ids ?? "")}"/></label><label>Group Chat ID<input name="group_chat_id" value="${escapeHtml(current?.group_chat_id ?? "")}"/></label></div>
<label>Welcome Message<textarea name="welcome_message">${escapeHtml(current?.welcome_message ?? "")}</textarea></label>
<div class="row"><label>Welcome Image URL<input name="welcome_image" value="${escapeHtml(current?.welcome_image ?? "")}"/></label><label>Channel URL<input name="channel_url" value="${escapeHtml(current?.channel_url ?? "")}"/></label></div>
<label>Random Channel URLs (comma)<input name="random_channel_urls" value="${escapeHtml(current?.random_channel_urls ?? "")}"/></label>
<div class="row"><label>Button 1 Text<input name="button_1_text" value="${buttonAt(1, "text")}"/></label><label>Button 1 URL<input name="button_1_url" value="${buttonAt(1, "url")}"/></label></div>
<div class="row"><label>Button 2 Text<input name="button_2_text" value="${buttonAt(2, "text")}"/></label><label>Button 2 URL<input name="button_2_url" value="${buttonAt(2, "url")}"/></label></div>
<div class="row"><label>Button 3 Text<input name="button_3_text" value="${buttonAt(3, "text")}"/></label><label>Button 3 URL<input name="button_3_url" value="${buttonAt(3, "url")}"/></label></div>
<div class="row"><label>Button 4 Text<input name="button_4_text" value="${buttonAt(4, "text")}"/></label><label>Button 4 URL<input name="button_4_url" value="${buttonAt(4, "url")}"/></label></div>
<div class="row"><label>Button 5 Text<input name="button_5_text" value="${buttonAt(5, "text")}"/></label><label>Button 5 URL<input name="button_5_url" value="${buttonAt(5, "url")}"/></label></div>
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
        <li class="mini-item"><div><div class="name">Live Coverage</div><div class="sub">Bots currently healthy</div></div><div class="num">${healthyBots}/${totalBots}</div></li>
        <li class="mini-item"><div><div class="name">Member Base</div><div class="sub">Total tracked private users</div></div><div class="num">${totalMembers}</div></li>
        <li class="mini-item"><div><div class="name">Risk Alerts</div><div class="sub">Polling conflicts and other errors</div></div><div class="num">${totalErrors}</div></li>
      </ul></div>
    </section>`;
  })();
  const tpl = readTemplateFile("panel.html");
  return tpl
    .replace("{{dashboard_active}}", view === "dashboard" ? "active" : "")
    .replace("{{bots_active}}", view === "bots" ? "active" : "")
    .replace("{{logs_active}}", view === "logs" ? "active" : "")
    .replace("{{config_active}}", view === "config" ? "active" : "")
    .replace("{{analytics_active}}", view === "analytics" ? "active" : "")
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
  const redirect = (res, to) => {
    res.writeHead(302, { Location: to });
    res.end();
  };
  const readForm = async (req) => new URLSearchParams(await parseBody(req));
  const saveStmt = db.prepare(`
    INSERT INTO bots (
      name, token, admin_ids, enabled, welcome_message, welcome_image, group_chat_id,
      channel_url, random_channel_urls, welcome_buttons, created_at, updated_at
    ) VALUES (
      @name, @token, @admin_ids, @enabled, @welcome_message, @welcome_image, @group_chat_id,
      @channel_url, @random_channel_urls, @welcome_buttons, @created_at, @updated_at
    )
  `);
  const updateStmt = db.prepare(`
    UPDATE bots SET
      name=@name, token=@token, admin_ids=@admin_ids, enabled=@enabled, welcome_message=@welcome_message,
      welcome_image=@welcome_image, group_chat_id=@group_chat_id, channel_url=@channel_url,
      random_channel_urls=@random_channel_urls, welcome_buttons=@welcome_buttons, updated_at=@updated_at
    WHERE id=@id
  `);
  const deleteStmt = db.prepare("DELETE FROM bots WHERE id = ?");

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
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderLoginPage());
        return;
      }
      if (req.method === "POST" && reqUrl.pathname === "/login") {
        const form = await readForm(req);
        const user = String(form.get("username") ?? "").trim();
        const pass = String(form.get("password") ?? "");
        if (user === PANEL_USERNAME && pass === PANEL_PASSWORD && PANEL_PASSWORD) {
          const sid = crypto.randomBytes(24).toString("hex");
          sessions.add(sid);
          res.writeHead(302, {
            Location: "/panel",
            "Set-Cookie": `session=${sid}; HttpOnly; SameSite=Lax; Path=/`,
          });
          res.end();
          return;
        }
        res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderLoginPage("Invalid credentials."));
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
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          renderPanelPage({
            botRows: rows,
            statusRows: live,
            editingId: edit,
            notice,
            view,
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
          random_channel_urls: String(form.get("random_channel_urls") ?? "").trim(),
          welcome_buttons: JSON.stringify(buttons),
          updated_at: new Date().toISOString(),
        };
        if (!payload.name || !payload.token) {
          redirect(res, "/panel?view=add&notice=Name%20and%20token%20are%20required");
          return;
        }
        if (payload.id > 0) {
          updateStmt.run(payload);
          redirect(
            res,
            "/panel?view=bots&notice=Bot%20updated.%20Restart%20app%20to%20apply."
          );
          return;
        }
        saveStmt.run({ ...payload, created_at: payload.updated_at });
        redirect(
          res,
          "/panel?view=bots&notice=Bot%20created.%20Restart%20app%20to%20apply."
        );
        return;
      }
      if (req.method === "POST" && reqUrl.pathname === "/panel/delete") {
        const form = await readForm(req);
        const id = Number(form.get("id") || 0);
        if (id > 0) deleteStmt.run(id);
        redirect(
          res,
          "/panel?view=bots&notice=Bot%20deleted.%20Restart%20app%20to%20apply."
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
