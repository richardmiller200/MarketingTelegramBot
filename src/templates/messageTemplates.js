import {
  MESSAGE_TEMPLATE_TITLE_MAX,
  MESSAGE_TEMPLATE_BODY_MAX,
  MESSAGE_TEMPLATE_IMAGE_MAX,
} from "../config/constants.js";
import { parseButtonsPerRow } from "../utils/parsers.js";
import { escapeHtml } from "../utils/helpers.js";

// ─── DB helpers ───────────────────────────────────────────────────────────────

export async function loadMessageTemplates(db) {
  try {
    return await db.all(
      "SELECT * FROM message_templates ORDER BY updated_at DESC, id DESC"
    );
  } catch {
    return [];
  }
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

export function parseMessageTemplateReferenceId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const normalized = raw.toUpperCase().replace(/\s+/g, "");
  const match = normalized.match(/^MSG-(\d+)$/);
  if (match) return Number(match[1] || 0);
  const numeric = Number(raw);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

export function parseMessageTemplateButtons(raw) {
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

export function parseMessageTemplateButtonsFromForm(form) {
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

// ─── Sanitization ─────────────────────────────────────────────────────────────

export function sanitizeMessageTemplateFields(raw) {
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
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) imageUrl = "";

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

// ─── HTML rendering ───────────────────────────────────────────────────────────

export function renderMessageLibraryButtonsBlock(buttons, fallbackPerRow) {
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

/** Compact Telegram-style bubble for Message Library list rows. */
export function renderMessageLibraryListPreview(templateRow) {
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
