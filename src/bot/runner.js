import fs from "fs";
import path from "path";
import TelegramBot from "node-telegram-bot-api";
import { ROOT } from "../config/constants.js";
import { createUserStore } from "./userStore.js";
import { attachHandlers } from "./handlers.js";

// ─── Bot lifecycle ────────────────────────────────────────────────────────────

export function startBot(cfg) {
  const usersFile = path.join(ROOT, "data", cfg.slug, "users.json");
  const store = createUserStore(usersFile);
  const logPrefix = `[${cfg.name}]`;

  const runtime = {
    id: Number(cfg.id) || 0,
    name: cfg.name,
    slug: cfg.slug,
    usersFile,
    startedAt: new Date().toISOString(),
    lastPollingError: null,
    pollingErrorCount: 0,
  };

  const bot = new TelegramBot(cfg.token, { polling: true });

  attachHandlers(bot, cfg, store, logPrefix, {
    onPollingError(err) {
      runtime.lastPollingError = String(err?.message ?? "Unknown error");
      runtime.pollingErrorCount += 1;
    },
  });

  console.log(`${logPrefix} running — users file: data/${cfg.slug}/users.json`);
  return { cfg, store, runtime, bot };
}

// ─── Status helpers ───────────────────────────────────────────────────────────

export function countMembers(usersFile) {
  try {
    if (!fs.existsSync(usersFile)) return 0;
    const data = JSON.parse(fs.readFileSync(usersFile, "utf8"));
    const ids = Array.isArray(data.users)
      ? data.users.map((u) => u.chatId)
      : Array.isArray(data.chatIds)
        ? data.chatIds
        : [];
    return [...new Set(ids.map(Number).filter((n) => !Number.isNaN(n)))].length;
  } catch {
    return 0;
  }
}

export function loadInteractedUserIdsForSlug(slug) {
  try {
    const usersFile = path.join(ROOT, "data", slug, "users.json");
    if (!fs.existsSync(usersFile)) return [];
    const data = JSON.parse(fs.readFileSync(usersFile, "utf8"));
    const users = Array.isArray(data.users)
      ? data.users
          .map((u) => ({
            chatId: String(u.chatId ?? "").trim(),
            username: String(u.username ?? "").trim(),
            firstName: String(u.firstName ?? "").trim(),
            lastName: String(u.lastName ?? "").trim(),
          }))
          .filter((u) => u.chatId)
      : [];

    if (users.length > 0) {
      const seen = new Set();
      return users.filter((u) => {
        if (seen.has(u.chatId)) return false;
        seen.add(u.chatId);
        return true;
      });
    }

    const ids = Array.isArray(data.chatIds) ? data.chatIds : [];
    return [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))].map((id) => ({
      chatId: id,
      username: "",
      firstName: "",
      lastName: "",
    }));
  } catch {
    return [];
  }
}

export function getStatusRows(instances) {
  return instances.map(({ runtime }) => {
    const members = countMembers(runtime.usersFile);
    return {
      id: Number(runtime.id || 0),
      name: runtime.name,
      slug: runtime.slug,
      members,
      pollingErrorCount: runtime.pollingErrorCount,
      lastPollingError: runtime.lastPollingError,
      startedAt: runtime.startedAt,
      healthy: runtime.pollingErrorCount === 0,
    };
  });
}
