import "dotenv/config";
import fs from "fs";
import path from "path";
import TelegramBot from "node-telegram-bot-api";
import XLSX from "xlsx";

const ROOT = process.cwd();

const DELAY_MS = 55;
const DEFAULT_WELCOME =
  "Thanks for starting the bot. How can I help you today?";

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
  };
  return applyGlobalAdminFallback([cfg]);
}

function resolveConfigs() {
  const excelPath = path.resolve(
    ROOT,
    process.env.BOTS_EXCEL_PATH || "bots.xlsx"
  );
  const fromExcel = loadBotsFromExcel(excelPath);
  if (fromExcel.length > 0) return { configs: fromExcel, source: excelPath };

  const fromEnv = loadBotsFromEnv();
  if (fromEnv.length > 0) return { configs: fromEnv, source: ".env" };

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  const { loadChatIds, registerUser } = store;
  const adminIds = cfg.adminIds;

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

    const photo = cfg.welcomeImage && resolveWelcomePhotoInput(cfg.welcomeImage);
    if (photo) {
      try {
        await bot.sendPhoto(chatId, photo, { caption: welcome });
      } catch (err) {
        console.error(`${logPrefix} welcome image failed:`, err.message);
        await bot.sendMessage(chatId, welcome);
      }
    } else {
      await bot.sendMessage(chatId, welcome);
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
