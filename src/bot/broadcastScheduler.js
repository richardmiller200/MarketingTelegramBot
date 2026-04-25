import { DELAY_MS } from "../config/constants.js";
import { parseButtonsPerRow } from "../utils/parsers.js";
import { sleep, isBlockedByUserError, buildUrlButtonReplyMarkup } from "../utils/helpers.js";
import { loadScheduledBroadcasts, markScheduleSent } from "../db/database.js";

// ─── Entry point ──────────────────────────────────────────────────────────────

export function startBroadcastScheduler(db, instances) {
  const tick = async () => {
    try {
      await runSchedulerTick(db, instances);
    } catch (err) {
      console.error("[Scheduler] tick error:", err.message);
    }
  };

  tick();
  setInterval(tick, 60 * 1000);
  console.log("[Scheduler] Broadcast scheduler started.");
}

// ─── Tick logic ───────────────────────────────────────────────────────────────

async function runSchedulerTick(db, instances) {
  const now = new Date();
  const schedules = await loadScheduledBroadcasts(db);

  for (const schedule of schedules) {
    if (!Number(schedule.active)) continue;
    if (!isDue(schedule, now)) continue;

    // Resolve which bot instances to send through
    const botIds = String(schedule.bot_ids ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => n > 0);

    if (botIds.length === 0) {
      console.warn(`[Scheduler] Schedule #${schedule.id}: no bot IDs — skipping.`);
      continue;
    }

    const targetInstances = botIds
      .map((id) => instances.find((i) => Number(i?.cfg?.id || 0) === id))
      .filter(Boolean);

    if (targetInstances.length === 0) {
      console.warn(`[Scheduler] Schedule #${schedule.id}: none of the bots are running — skipping.`);
      continue;
    }

    console.log(
      `[Scheduler] Schedule #${schedule.id} firing — bots: ${targetInstances.map((i) => i.cfg.name).join(", ")}`
    );

    for (const instance of targetInstances) {
      await sendScheduledBroadcast(instance, schedule);
    }

    await markScheduleSent(db, schedule.id);
  }
}

// ─── Due check ────────────────────────────────────────────────────────────────

function isDue(schedule, now) {
  if (now.getHours() !== Number(schedule.send_hour)) return false;
  if (now.getMinutes() !== Number(schedule.send_minute)) return false;
  if (!schedule.last_sent_at) return true;

  const lastSent = new Date(schedule.last_sent_at);
  const daysSinceLast = (now - lastSent) / (1000 * 60 * 60 * 24);
  return daysSinceLast >= Number(schedule.interval_days);
}

// ─── Send ─────────────────────────────────────────────────────────────────────

async function sendScheduledBroadcast(instance, schedule) {
  const recipients = instance.store.loadChatIds();
  if (recipients.length === 0) {
    console.log(`[Scheduler] Schedule #${schedule.id} / bot ${instance.cfg.name}: no recipients.`);
    return;
  }

  const text = String(schedule.message ?? "").trim();
  const photoUrl = String(schedule.image_url ?? "").trim();

  let buttons = [];
  try {
    const parsed = JSON.parse(schedule.buttons ?? "[]");
    if (Array.isArray(parsed)) buttons = parsed;
  } catch {}

  const fb = parseButtonsPerRow(schedule.buttons_per_row ?? 2);
  const replyMarkup = buildUrlButtonReplyMarkup(buttons, fb);

  let sent = 0;
  let failed = 0;
  let removed = 0;

  for (const uid of recipients) {
    try {
      if (photoUrl && /^https?:\/\//i.test(photoUrl)) {
        await instance.bot.sendPhoto(uid, photoUrl, {
          caption: text,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
      } else {
        await instance.bot.sendMessage(uid, text, {
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
      }
      sent++;
    } catch (err) {
      failed++;
      if (isBlockedByUserError(err)) {
        await instance.store.removeChatId(uid);
        removed++;
      }
    }
    await sleep(DELAY_MS);
  }

  console.log(
    `[Scheduler] Schedule #${schedule.id} / bot ${instance.cfg.name}: sent ${sent}, failed ${failed}${removed ? `, removed ${removed}` : ""}`
  );
}

// ─── Next run helper (used by renderer) ──────────────────────────────────────

export function computeNextRun(schedule) {
  const sendHour = Number(schedule.send_hour);
  const sendMinute = Number(schedule.send_minute);
  const intervalDays = Number(schedule.interval_days);

  if (!schedule.last_sent_at) {
    const candidate = new Date();
    candidate.setHours(sendHour, sendMinute, 0, 0);
    if (candidate <= new Date()) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  const lastSent = new Date(schedule.last_sent_at);
  const next = new Date(lastSent);
  next.setDate(next.getDate() + intervalDays);
  next.setHours(sendHour, sendMinute, 0, 0);
  return next;
}
