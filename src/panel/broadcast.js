import { DELAY_MS } from "../config/constants.js";
import { parseButtonsPerRow } from "../utils/parsers.js";
import { sleep, isBlockedByUserError, buildUrlButtonReplyMarkup } from "../utils/helpers.js";
import { appendBroadcastLog } from "./broadcastLog.js";

// ─── Single-bot broadcast ─────────────────────────────────────────────────────

export async function runPanelBroadcastOne({
  botId,
  message,
  image,
  testMode,
  testChatId,
  broadcastButtons,
  broadcastButtonsPerRow,
  instances,
}) {
  const instance = instances.find(
    (i) => Number(i?.cfg?.id || 0) === Number(botId || 0)
  );

  if (!instance) {
    appendBroadcastLog({
      botName: `#${Number(botId || 0)}`,
      mode: testMode ? "test" : "full",
      ok: false,
      note: "Selected bot is not running",
    });
    return { ok: false, sent: 0, failed: 0, recipients: 0, notice: "Bot not running." };
  }

  const botName = String(instance.cfg?.name ?? `#${Number(botId || 0)}`);
  const text = String(message ?? "").trim();

  if (!text) {
    appendBroadcastLog({
      botName,
      mode: testMode ? "test" : "full",
      ok: false,
      note: "Empty broadcast message",
    });
    return {
      ok: false,
      sent: 0,
      failed: 0,
      recipients: 0,
      notice: "Broadcast message is required.",
    };
  }

  const recipients = instance.store.loadChatIds();
  const buttons = Array.isArray(broadcastButtons) ? broadcastButtons : [];
  const fb = parseButtonsPerRow(broadcastButtonsPerRow ?? 2);
  const replyMarkup = buildUrlButtonReplyMarkup(buttons, fb);
  const sendOptions = replyMarkup
    ? { disable_web_page_preview: false, reply_markup: replyMarkup }
    : { disable_web_page_preview: false };
  const photoUrl = String(image ?? "").trim();

  const sendBroadcast = (target) => {
    if (photoUrl && /^https?:\/\//i.test(photoUrl)) {
      return instance.bot.sendPhoto(target, photoUrl, {
        caption: text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    }
    return instance.bot.sendMessage(target, text, sendOptions);
  };

  // ── Test mode ──────────────────────────────────────────────────────────────

  if (testMode) {
    const target = Number(testChatId || 0);
    if (!target) {
      appendBroadcastLog({ botName, mode: "test", ok: false, note: "Missing test chat id" });
      return {
        ok: false,
        sent: 0,
        failed: 0,
        recipients: 0,
        notice: "Test mode needs a valid Test Chat ID.",
      };
    }
    try {
      await sendBroadcast(target);
      appendBroadcastLog({
        botName,
        mode: "test",
        recipients: 1,
        sent: 1,
        failed: 0,
        ok: true,
        note: `Test sent to ${target}`,
      });
      return { ok: true, sent: 1, failed: 0, recipients: 1, notice: "Test broadcast sent successfully." };
    } catch (err) {
      const note = `Test send failed: ${String(err?.message ?? "unknown")}`;
      appendBroadcastLog({ botName, mode: "test", recipients: 1, sent: 0, failed: 1, ok: false, note });
      return { ok: false, sent: 0, failed: 1, recipients: 1, notice: note };
    }
  }

  // ── Full broadcast ─────────────────────────────────────────────────────────

  if (recipients.length === 0) {
    appendBroadcastLog({
      botName,
      mode: "full",
      recipients: 0,
      sent: 0,
      failed: 0,
      ok: false,
      note: "No interacted users found",
    });
    return {
      ok: false,
      sent: 0,
      failed: 0,
      recipients: 0,
      notice: "No interacted users found for this bot.",
    };
  }

  let sent = 0;
  let failed = 0;
  let removed = 0;
  for (const uid of recipients) {
    try {
      await sendBroadcast(uid);
      sent += 1;
    } catch (err) {
      failed += 1;
      if (isBlockedByUserError(err)) {
        const didRemove = await instance.store.removeChatId(uid);
        if (didRemove) removed += 1;
      }
    }
    await sleep(DELAY_MS);
  }

  appendBroadcastLog({
    botName,
    mode: "full",
    recipients: recipients.length,
    sent,
    failed,
    ok: true,
    note: "Completed",
  });

  return {
    ok: true,
    sent,
    failed,
    recipients: recipients.length,
    notice: `Broadcast done: ${sent} sent, ${failed} failed.${
      removed > 0 ? ` Removed ${removed} blocked user(s).` : ""
    }`,
  };
}

// ─── Multi-bot broadcast ──────────────────────────────────────────────────────

export async function runPanelBroadcast({
  botIds,
  message,
  image,
  testMode,
  testChatId,
  broadcastButtons,
  broadcastButtonsPerRow,
  instances,
}) {
  const ids = Array.isArray(botIds)
    ? [...new Set(botIds.map((x) => Number(x || 0)).filter((n) => n > 0))]
    : [];

  if (ids.length === 0) return { ok: false, notice: "Select at least one bot." };

  let totalRecipients = 0;
  let totalSent = 0;
  let totalFailed = 0;
  let okCount = 0;

  for (const id of ids) {
    const r = await runPanelBroadcastOne({
      botId: id,
      message,
      image,
      testMode,
      testChatId,
      broadcastButtons,
      broadcastButtonsPerRow,
      instances,
    });
    totalRecipients += Number(r.recipients || 0);
    totalSent += Number(r.sent || 0);
    totalFailed += Number(r.failed || 0);
    if (r.ok) okCount += 1;
  }

  const mode = testMode ? "test" : "full";
  return {
    ok: okCount > 0,
    notice: `Broadcast (${mode}) across ${ids.length} bot(s): recipients ${totalRecipients}, sent ${totalSent}, failed ${totalFailed}.`,
  };
}
