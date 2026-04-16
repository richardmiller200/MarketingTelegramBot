import "dotenv/config";
import fs from "fs";
import path from "path";
import TelegramBot from "node-telegram-bot-api";
import XLSX from "xlsx";

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
  const token = process.env.BOT_TOKEN?.trim();
  if (!token) return [];
  const adminIds = parseAdminIds(process.env.ADMIN_TELEGRAM_IDS ?? "");
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
    welcomeButtons: [],
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

function resolveConfigs() {
  const excelPath = path.resolve(
    ROOT,
    process.env.BOTS_EXCEL_PATH || "bots.xlsx"
  );
  const fromExcel = loadBotsFromExcel(excelPath);
  if (fromExcel.length > 0) {
    return { configs: markFirstAndheriBot(fromExcel), source: excelPath };
  }

  const fromEnv = loadBotsFromEnv();
  if (fromEnv.length > 0) {
    return { configs: markFirstAndheriBot(fromEnv), source: ".env" };
  }

  console.error(
    "No bots found. Either:\n" +
      "  • Create bots.xlsx (run: npm run template) and add rows with bot_token + admin_ids, or\n" +
      "  • Set BOT_TOKEN (and ADMIN_TELEGRAM_IDS) in .env for a single bot."
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

function attachHandlers(bot, cfg, store, logPrefix) {
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
    console.error(`${logPrefix} polling error:`, err.message);
  });
}

function startBot(cfg) {
  const usersFile = path.join(ROOT, "data", cfg.slug, "users.json");
  const store = createUserStore(usersFile);
  const logPrefix = `[${cfg.name}]`;

  const bot = new TelegramBot(cfg.token, { polling: true });
  attachHandlers(bot, cfg, store, logPrefix);
  console.log(`${logPrefix} running — users file: data/${cfg.slug}/users.json`);
}

const { configs, source } = resolveConfigs();
console.log(`Config: ${configs.length} bot(s) from ${source}`);
for (const cfg of configs) {
  startBot(cfg);
}
console.log("All bots polling. Press Ctrl+C to stop.");
