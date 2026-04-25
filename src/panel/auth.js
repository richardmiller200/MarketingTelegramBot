import fs from "fs";
import path from "path";
import { ADMIN_LOGIN_STATE_FILE } from "../config/constants.js";

// ─── Persistent login state ───────────────────────────────────────────────────

export function readAdminLoginState() {
  try {
    const raw = fs.readFileSync(ADMIN_LOGIN_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      failedAttempts: Number(parsed.failedAttempts || 0),
      locked: Boolean(parsed.locked),
      lockedAt: String(parsed.lockedAt ?? ""),
    };
  } catch {
    return { failedAttempts: 0, locked: false, lockedAt: "" };
  }
}

export function writeAdminLoginState(state) {
  fs.mkdirSync(path.dirname(ADMIN_LOGIN_STATE_FILE), { recursive: true });
  fs.writeFileSync(ADMIN_LOGIN_STATE_FILE, JSON.stringify(state, null, 2));
}
