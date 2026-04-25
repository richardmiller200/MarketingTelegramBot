import { Pool } from "pg";
import { PG_CONNECTION_STRING } from "../config/constants.js";
import { slugify, parseAdminIds, parseButtonsPerRow } from "../utils/parsers.js";
import {
  loadBotsFromEnv,
  markFirstAndheriBot,
} from "../config/botLoader.js";

// ─── Connection ───────────────────────────────────────────────────────────────

export async function openConfigDb() {
  const pool = new Pool(
    PG_CONNECTION_STRING
      ? { connectionString: PG_CONNECTION_STRING }
      : {
          host: process.env.PGHOST ?? "127.0.0.1",
          port: Number(process.env.PGPORT ?? "5432"),
          user: process.env.PGUSER ?? process.env.USER,
          password: process.env.PGPASSWORD ?? "",
          database: process.env.PGDATABASE ?? "postgres",
        }
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bots (
      id BIGSERIAL PRIMARY KEY,
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_templates (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      buttons TEXT NOT NULL DEFAULT '[]',
      buttons_per_row INTEGER NOT NULL DEFAULT 2,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_broadcasts (
      id BIGSERIAL PRIMARY KEY,
      bot_ids TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      buttons TEXT NOT NULL DEFAULT '[]',
      buttons_per_row INTEGER NOT NULL DEFAULT 2,
      interval_days INTEGER NOT NULL DEFAULT 1,
      send_hour INTEGER NOT NULL DEFAULT 9,
      send_minute INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      last_sent_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  return {
    pool,
    async all(query, params = []) {
      const result = await pool.query(query, params);
      return result.rows;
    },
    async get(query, params = []) {
      const result = await pool.query(query, params);
      return result.rows[0] ?? null;
    },
    async run(query, params = []) {
      const result = await pool.query(query, params);
      return {
        rowCount: result.rowCount,
        lastInsertRowid: result.rows?.[0]?.id ?? 0,
      };
    },
  };
}

// ─── Row ↔ Config converters ──────────────────────────────────────────────────

export function configToDbRow(cfg) {
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

export function dbRowToConfig(row, index) {
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

// ─── Seeding & loading ────────────────────────────────────────────────────────

export async function seedDbIfEmpty(db, seedConfigs) {
  const countRow = await db.get("SELECT COUNT(*)::int AS c FROM bots");
  const count = Number(countRow?.c || 0);
  if (count > 0 || seedConfigs.length === 0) return false;

  const insertSql = `
    INSERT INTO bots (
      name, token, admin_ids, enabled, welcome_message, welcome_image,
      group_chat_id, channel_url, random_channel_urls, welcome_buttons,
      buttons_per_row, button_layout, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11, $12, $13, $14
    )
  `;
  const now = new Date().toISOString();
  for (const cfg of seedConfigs) {
    const row = configToDbRow(cfg);
    await db.run(insertSql, [
      row.name,
      row.token,
      row.admin_ids,
      row.enabled,
      row.welcome_message,
      row.welcome_image,
      row.group_chat_id,
      row.channel_url,
      row.random_channel_urls,
      row.welcome_buttons,
      row.buttons_per_row,
      row.button_layout,
      now,
      now,
    ]);
  }
  return true;
}

export async function loadBotsFromDb(db) {
  const rows = await db.all("SELECT * FROM bots WHERE enabled = 1 ORDER BY id ASC");
  return rows
    .map((row, i) => dbRowToConfig(row, i))
    .filter((c) => c.enabled && c.token && c.token !== "PASTE_TOKEN_FROM_BOTFATHER");
}

export async function loadEnabledConfigsFromDb(db) {
  const rows = await db.all("SELECT * FROM bots WHERE enabled = 1 ORDER BY id ASC");
  return rows
    .map((row, i) => dbRowToConfig(row, i))
    .filter((c) => c.enabled && c.token && c.token !== "PASTE_TOKEN_FROM_BOTFATHER");
}

export async function loadBotRows(db) {
  return await db.all("SELECT * FROM bots ORDER BY id ASC");
}

// ─── Main resolver ────────────────────────────────────────────────────────────

export async function resolveConfigs() {
  const db = await openConfigDb();

  // Seed DB on first run if env vars are provided
  const fromEnv = loadBotsFromEnv();
  await seedDbIfEmpty(db, fromEnv);

  const fromDb = await loadBotsFromDb(db);
  if (fromDb.length > 0) {
    return { configs: markFirstAndheriBot(fromDb), source: "postgres", db };
  }

  console.error(
    "No bots found. Add bots via the admin panel or set BOTS_JSON/BOT_TOKEN in .env to seed on first run."
  );
  process.exit(1);
}

// ─── Scheduled broadcasts CRUD ────────────────────────────────────────────────

export async function loadScheduledBroadcasts(db) {
  return await db.all(
    "SELECT * FROM scheduled_broadcasts ORDER BY id ASC"
  );
}

export async function createScheduledBroadcast(db, {
  botIds,           // array of bot IDs
  message,
  imageUrl,
  buttons,
  buttonsPerRow,
  intervalDays,
  sendHour,
  sendMinute,
}) {
  const now = new Date().toISOString();
  return await db.run(
    `INSERT INTO scheduled_broadcasts
      (bot_ids, message, image_url, buttons, buttons_per_row,
       interval_days, send_hour, send_minute, active, last_sent_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'',$9,$10) RETURNING id`,
    [
      botIds.join(","),
      message,
      imageUrl,
      JSON.stringify(buttons),
      buttonsPerRow,
      intervalDays,
      sendHour,
      sendMinute,
      now,
      now,
    ]
  );
}

export async function toggleScheduledBroadcast(db, id) {
  await db.run(
    `UPDATE scheduled_broadcasts
     SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END, updated_at = $1
     WHERE id = $2`,
    [new Date().toISOString(), id]
  );
}

export async function deleteScheduledBroadcast(db, id) {
  await db.run("DELETE FROM scheduled_broadcasts WHERE id = $1", [id]);
}

export async function markScheduleSent(db, id) {
  const now = new Date().toISOString();
  await db.run(
    "UPDATE scheduled_broadcasts SET last_sent_at = $1, updated_at = $2 WHERE id = $3",
    [now, now, id]
  );
}
