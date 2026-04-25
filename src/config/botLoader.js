import {
  parseAdminIds,
  normalizeHeaderKey,
  parseWelcomeButtons,
  parseButtonsPerRow,
  slugify,
} from "../utils/parsers.js";

// ─── Row → Config ─────────────────────────────────────────────────────────────

/** Maps a plain object row to a bot config (used when seeding from env JSON). */
export function rowToConfig(row, index) {
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
    norm.admins ??
    norm.admin ??
    "";

  const welcomeMessage = String(norm.welcome_message ?? norm.welcome ?? "").trim();

  const welcomeImage = String(
    norm.welcome_image ??
      norm.welcome_photo ??
      norm.welcome_photo_url ??
      norm.image ??
      ""
  ).trim();

  const groupChatIdRaw =
    norm.group_chat_id ?? norm.group_id ?? norm.channel_id ?? "";

  const channelUrl = String(
    norm.channel_url ?? norm.channel_link ?? norm.reach_url ?? ""
  ).trim();

  const welcomeButtons = parseWelcomeButtons(norm);
  const welcomeButtonsPerRow = parseButtonsPerRow(
    norm.buttons_per_row ?? norm.button_per_row ?? 2
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

// ─── Global admin fallback ────────────────────────────────────────────────────

/** If a bot row has no admin_ids, fall back to ADMIN_TELEGRAM_IDS from .env. */
export function applyGlobalAdminFallback(configs) {
  const globalAdmins = parseAdminIds(process.env.ADMIN_TELEGRAM_IDS ?? "");
  if (globalAdmins.length === 0) return configs;
  return configs.map((c) =>
    c.adminIds.length > 0 ? c : { ...c, adminIds: globalAdmins }
  );
}

// ─── Env loader ───────────────────────────────────────────────────────────────

/** Loads bots from BOTS_JSON or BOT_TOKEN env vars (used for initial DB seeding only). */
export function loadBotsFromEnv() {
  const multiRaw = String(
    process.env.BOTS_JSON ?? process.env.BOTS_CONFIG_JSON ?? ""
  ).trim();

  if (multiRaw) {
    try {
      const parsed = JSON.parse(multiRaw);
      if (!Array.isArray(parsed)) return [];
      const configs = parsed
        .map((row, i) => rowToConfig(row, i))
        .filter((c) => c.enabled && c.token && c.token !== "PASTE_TOKEN_FROM_BOTFATHER");
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
    if (text && /^https?:\/\//i.test(url)) welcomeButtons.push({ text, url });
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

// ─── Post-processing ──────────────────────────────────────────────────────────

export function markFirstAndheriBot(configs) {
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
