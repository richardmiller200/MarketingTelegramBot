/**
 * Pure parsing / normalization utilities.
 * No side-effects, no I/O — safe to import anywhere.
 */

export function parseAdminIds(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

export function normalizeHeaderKey(k) {
  return String(k)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function parseUrlList(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((url) => /^https?:\/\//i.test(url));
}

export function parseButtonsPerRow(raw, fallback = 2) {
  const n = Number(raw);
  if (Number.isNaN(n)) return fallback;
  return Math.max(1, Math.min(3, Math.floor(n)));
}

export function parseWelcomeButtons(norm) {
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

export function slugify(name, index) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return (base || "bot") + "-" + index;
}
