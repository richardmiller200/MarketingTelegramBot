import fs from "fs";
import path from "path";
import { ROOT } from "../config/constants.js";
import { parseButtonsPerRow } from "./parsers.js";

// ─── Async / timing ──────────────────────────────────────────────────────────

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function getDateStamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function truncateSingleLine(s, maxLen) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(0, maxLen - 1))}…`;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

export function parseCookies(req) {
  const raw = String(req.headers.cookie ?? "");
  const cookies = {};
  for (const item of raw.split(";")) {
    const [k, ...rest] = item.trim().split("=");
    if (!k) continue;
    cookies[k] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

export function parseBody(req) {
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

// ─── Telegram message helpers ─────────────────────────────────────────────────

export function messageKind(msg) {
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

export function messagePreview(msg) {
  if (msg.text) return msg.text.slice(0, 80);
  if (msg.caption) return msg.caption.slice(0, 80);
  return messageKind(msg);
}

/** Resolves welcome photo: HTTPS URL, Telegram file_id, or local path under project root. */
export function resolveWelcomePhotoInput(raw) {
  const s = String(raw).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const local = path.isAbsolute(s) ? s : path.join(ROOT, s);
  if (fs.existsSync(local)) return fs.createReadStream(local);
  return s;
}

// ─── Telegram error helpers ───────────────────────────────────────────────────

export function telegramErrorCode(err) {
  return String(err?.code ?? err?.response?.body?.error_code ?? "").trim();
}

export function isBlockedByUserError(err) {
  const code = telegramErrorCode(err);
  const message = String(err?.message ?? "").toLowerCase();
  return (
    code === "403" ||
    code === "ETELEGRAM" ||
    message.includes("forbidden: bot was blocked by the user")
  );
}

// ─── Inline keyboard builder ──────────────────────────────────────────────────

/** Builds inline_keyboard reply_markup from a buttons array + fallback row size. */
export function buildUrlButtonReplyMarkup(buttons, fallbackPerRow = 2) {
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
