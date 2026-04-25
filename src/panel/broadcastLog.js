import fs from "fs";
import path from "path";
import { BROADCAST_LOG_FILE } from "../config/constants.js";

export function loadBroadcastLogs(limit = 20) {
  try {
    if (!fs.existsSync(BROADCAST_LOG_FILE)) return [];
    const rows = JSON.parse(fs.readFileSync(BROADCAST_LOG_FILE, "utf8"));
    if (!Array.isArray(rows)) return [];
    return rows.slice(-limit).reverse();
  } catch {
    return [];
  }
}

export function appendBroadcastLog(entry) {
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
