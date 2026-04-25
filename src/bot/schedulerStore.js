import fs from "fs";
import path from "path";
import { getDateStamp } from "../utils/helpers.js";
import { DEFAULT_DAILY_SEND_TIMES } from "../config/constants.js";

// ─── Store ────────────────────────────────────────────────────────────────────

export function createSchedulerStore(storeFile) {
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

// ─── Scheduling helpers ───────────────────────────────────────────────────────

export function pickMessageForDate(library, sentIdsToday) {
  if (library.length === 0) return null;
  const remaining = library.filter((m) => !sentIdsToday.includes(m.id));
  const pool = remaining.length > 0 ? remaining : library;
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

export async function runDailyScheduleTick(bot, cfg, schedulerStore, logPrefix, now = new Date()) {
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

    const chosen = pickMessageForDate(state.library, state.sentMessageIdsByDate[stamp]);
    if (!chosen) continue;

    try {
      await bot.copyMessage(groupChatId, chosen.sourceChatId, chosen.sourceMessageId);
      state.lastSentDateBySlot[slot.key] = stamp;
      state.sentMessageIdsByDate[stamp].push(chosen.id);
    } catch (err) {
      console.error(`${logPrefix} scheduled send failed:`, err.message);
    }
  }

  // Keep only today's sent IDs to avoid unbounded growth
  const keepDate = stamp;
  for (const k of Object.keys(state.sentMessageIdsByDate)) {
    if (k !== keepDate) delete state.sentMessageIdsByDate[k];
  }
  schedulerStore.saveState(state);
}
