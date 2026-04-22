import "dotenv/config";
import path from "path";
import Database from "better-sqlite3";
import { Pool } from "pg";

const ROOT = process.cwd();
const SQLITE_FILE = path.join(ROOT, "data", "config.sqlite");

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.PGHOST ?? "127.0.0.1",
        port: Number(process.env.PGPORT ?? "5432"),
        user: process.env.PGUSER ?? process.env.USER,
        password: process.env.PGPASSWORD ?? "",
        database: process.env.PGDATABASE ?? "postgres",
      }
);

async function ensureSchema() {
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
}

async function migrate() {
  const sqlite = new Database(SQLITE_FILE, { readonly: true });
  await ensureSchema();

  const bots = sqlite.prepare("SELECT * FROM bots ORDER BY id ASC").all();
  const templates = sqlite
    .prepare("SELECT * FROM message_templates ORDER BY id ASC")
    .all();

  await pool.query("BEGIN");
  try {
    await pool.query("TRUNCATE TABLE message_templates RESTART IDENTITY CASCADE");
    await pool.query("TRUNCATE TABLE bots RESTART IDENTITY CASCADE");

    for (const bot of bots) {
      await pool.query(
        `INSERT INTO bots (
          name, token, admin_ids, enabled, welcome_message, welcome_image, group_chat_id,
          channel_url, random_channel_urls, welcome_buttons, buttons_per_row, button_layout, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14
        )`,
        [
          String(bot.name ?? ""),
          String(bot.token ?? ""),
          String(bot.admin_ids ?? ""),
          Number(bot.enabled ?? 1),
          String(bot.welcome_message ?? ""),
          String(bot.welcome_image ?? ""),
          String(bot.group_chat_id ?? ""),
          String(bot.channel_url ?? ""),
          String(bot.random_channel_urls ?? ""),
          String(bot.welcome_buttons ?? "[]"),
          Number(bot.buttons_per_row ?? 2),
          String(bot.button_layout ?? ""),
          String(bot.created_at ?? new Date().toISOString()),
          String(bot.updated_at ?? new Date().toISOString()),
        ]
      );
    }

    for (const t of templates) {
      await pool.query(
        `INSERT INTO message_templates (
          title, body, image_url, buttons, buttons_per_row, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          String(t.title ?? ""),
          String(t.body ?? ""),
          String(t.image_url ?? ""),
          String(t.buttons ?? "[]"),
          Number(t.buttons_per_row ?? 2),
          String(t.created_at ?? new Date().toISOString()),
          String(t.updated_at ?? new Date().toISOString()),
        ]
      );
    }

    await pool.query("COMMIT");
    console.log(
      `Migration completed. Bots: ${bots.length}, message templates: ${templates.length}.`
    );
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  } finally {
    sqlite.close();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exit(1);
});
