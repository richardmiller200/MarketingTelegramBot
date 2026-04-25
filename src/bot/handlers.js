import path from "path";
import {
  ROOT,
  BROADCAST_CMD,
  DEFAULT_WELCOME,
  DEFAULT_REACH_BUTTON_TEXT,
  DEFAULT_RANDOM_CHANNEL_BUTTON_TEXT,
  DEFAULT_RANDOM_CHANNEL_URLS,
  DELAY_MS,
} from "../config/constants.js";
import { parseButtonsPerRow } from "../utils/parsers.js";
import {
  sleep,
  resolveWelcomePhotoInput,
  isBlockedByUserError,
  messageKind,
  messagePreview,
} from "../utils/helpers.js";
import { createSchedulerStore, runDailyScheduleTick } from "./schedulerStore.js";

// ─── Welcome keyboard builder ─────────────────────────────────────────────────

function buildWelcomeReplyMarkup(cfg) {
  if (Array.isArray(cfg.welcomeButtons) && cfg.welcomeButtons.length > 0) {
    const inlineKeyboard = [];
    const fallbackPerRow = parseButtonsPerRow(cfg.welcomeButtonsPerRow ?? 2);
    let index = 0;
    while (index < cfg.welcomeButtons.length) {
      const current = cfg.welcomeButtons[index] ?? {};
      const fromButton = parseButtonsPerRow(current.perRow, 0);
      const rowSize = fromButton >= 1 && fromButton <= 3 ? fromButton : fallbackPerRow;
      inlineKeyboard.push(cfg.welcomeButtons.slice(index, index + rowSize));
      index += rowSize;
    }
    return { inline_keyboard: inlineKeyboard };
  }

  if (cfg.isFirstAndheriBot) {
    const pool =
      Array.isArray(cfg.randomChannelUrls) && cfg.randomChannelUrls.length > 0
        ? cfg.randomChannelUrls
        : DEFAULT_RANDOM_CHANNEL_URLS;
    const randomUrl = pool[Math.floor(Math.random() * pool.length)];
    return {
      inline_keyboard: [[{ text: DEFAULT_RANDOM_CHANNEL_BUTTON_TEXT, url: randomUrl }]],
    };
  }

  const url = String(cfg.channelUrl ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return undefined;
  return {
    inline_keyboard: [[{ text: DEFAULT_REACH_BUTTON_TEXT, url }]],
  };
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────

async function broadcastLoop(bot, chatId, loadChatIds, removeChatId, sendOne) {
  const recipients = loadChatIds();
  if (recipients.length === 0) {
    await bot.sendMessage(
      chatId,
      "No users yet. Users are saved when they message this bot in private."
    );
    return;
  }

  await bot.sendMessage(chatId, `Sending to ${recipients.length} user(s)…`);

  let sent = 0;
  let failed = 0;
  let removed = 0;
  for (const uid of recipients) {
    try {
      await sendOne(uid);
      sent++;
    } catch (err) {
      failed++;
      if (isBlockedByUserError(err)) {
        const didRemove = await removeChatId(uid);
        if (didRemove) removed++;
      }
    }
    await sleep(DELAY_MS);
  }

  await bot.sendMessage(
    chatId,
    `Done: ${sent} sent, ${failed} failed (blocked bot or invalid).${
      removed > 0 ? ` Removed ${removed} blocked user(s) from this bot list.` : ""
    }`
  );
}

// ─── Main handler registration ────────────────────────────────────────────────

export function attachHandlers(bot, cfg, store, logPrefix, hooks = {}) {
  const { loadChatIds, registerUser, removeChatId } = store;
  const adminIds = cfg.adminIds;
  const scheduleFile = path.join(ROOT, "data", cfg.slug, "schedule.json");
  const schedulerStore = createSchedulerStore(scheduleFile);

  function isAdmin(userId) {
    return !!userId && adminIds.length > 0 && adminIds.includes(userId);
  }

  async function ensureAdmin(chatId, fromId) {
    if (!fromId) return false;
    if (adminIds.length === 0) {
      await bot.sendMessage(
        chatId,
        "Broadcast is not configured. Set admin_ids for this bot in Excel (or ADMIN_TELEGRAM_IDS in .env)."
      );
      return false;
    }
    if (!adminIds.includes(fromId)) {
      await bot.sendMessage(chatId, "You are not allowed to broadcast.");
      return false;
    }
    return true;
  }

  function upsertGroupOnAnyGroupMessage(msg) {
    if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return;
    const state = schedulerStore.loadState();
    if (state.groupChatId === msg.chat.id) return;
    state.groupChatId = msg.chat.id;
    schedulerStore.saveState(state);
  }

  // ── /start ──────────────────────────────────────────────────────────────────

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const name = msg.from?.first_name ?? "there";
    const extra = cfg.welcomeExtra ? `\n\n${cfg.welcomeExtra}` : "";
    const welcome = `Welcome, ${name}! 👋\n\n${DEFAULT_WELCOME}${extra}`;
    const replyMarkup = buildWelcomeReplyMarkup(cfg);
    const photo = cfg.welcomeImage && resolveWelcomePhotoInput(cfg.welcomeImage);

    if (photo) {
      try {
        await bot.sendPhoto(chatId, photo, { caption: welcome, reply_markup: replyMarkup });
      } catch (err) {
        console.error(`${logPrefix} welcome image failed:`, err.message);
        if (isBlockedByUserError(err)) {
          await removeChatId(chatId);
          return;
        }
        try {
          await bot.sendMessage(chatId, welcome, { reply_markup: replyMarkup });
        } catch (fallbackErr) {
          if (isBlockedByUserError(fallbackErr)) {
            await removeChatId(chatId);
            return;
          }
          throw fallbackErr;
        }
      }
    } else {
      try {
        await bot.sendMessage(chatId, welcome, { reply_markup: replyMarkup });
      } catch (err) {
        if (isBlockedByUserError(err)) {
          await removeChatId(chatId);
          return;
        }
        throw err;
      }
    }
  });

  // ── message (media broadcast via caption + group group-id upsert) ────────────

  bot.on("message", async (msg) => {
    upsertGroupOnAnyGroupMessage(msg);
    if (msg.chat.type === "private") registerUser(msg);
    if (msg.chat.type !== "private" || !msg.from) return;

    const cap = msg.caption?.trim();
    const capMatch = cap && cap.match(BROADCAST_CMD);
    if (!capMatch) return;

    const hasMedia = msg.photo?.length || msg.video || msg.document || msg.animation;
    if (!hasMedia) return;
    if (!(await ensureAdmin(msg.chat.id, msg.from.id))) return;

    const captionText = capMatch[1]?.trim() ?? "";

    if (msg.photo?.length) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      await broadcastLoop(bot, msg.chat.id, loadChatIds, removeChatId, (uid) =>
        bot.sendPhoto(uid, fileId, { caption: captionText || undefined })
      );
      return;
    }
    if (msg.video) {
      await broadcastLoop(bot, msg.chat.id, loadChatIds, removeChatId, (uid) =>
        bot.sendVideo(uid, msg.video.file_id, { caption: captionText || undefined })
      );
      return;
    }
    if (msg.document) {
      await broadcastLoop(bot, msg.chat.id, loadChatIds, removeChatId, (uid) =>
        bot.sendDocument(uid, msg.document.file_id, { caption: captionText || undefined })
      );
      return;
    }
    if (msg.animation) {
      await broadcastLoop(bot, msg.chat.id, loadChatIds, removeChatId, (uid) =>
        bot.sendAnimation(uid, msg.animation.file_id, { caption: captionText || undefined })
      );
    }
  });

  // ── /broadcast ───────────────────────────────────────────────────────────────

  bot.onText(/\/broadcast(?:\s+([\s\S]+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const fromId = msg.from?.id;
    if (!(await ensureAdmin(chatId, fromId))) return;

    const reply = msg.reply_to_message;
    const cmdText = match[1]?.trim() ?? "";

    if (reply) {
      if (reply.photo?.length) {
        const fileId = reply.photo[reply.photo.length - 1].file_id;
        const cap = cmdText || reply.caption?.trim() || "";
        await broadcastLoop(bot, chatId, loadChatIds, removeChatId, (uid) =>
          bot.sendPhoto(uid, fileId, { caption: cap || undefined })
        );
        return;
      }
      if (reply.video) {
        const cap = cmdText || reply.caption?.trim() || "";
        await broadcastLoop(bot, chatId, loadChatIds, removeChatId, (uid) =>
          bot.sendVideo(uid, reply.video.file_id, { caption: cap || undefined })
        );
        return;
      }
      if (reply.document) {
        const cap = cmdText || reply.caption?.trim() || "";
        await broadcastLoop(bot, chatId, loadChatIds, removeChatId, (uid) =>
          bot.sendDocument(uid, reply.document.file_id, { caption: cap || undefined })
        );
        return;
      }
      if (reply.animation) {
        const cap = cmdText || reply.caption?.trim() || "";
        await broadcastLoop(bot, chatId, loadChatIds, removeChatId, (uid) =>
          bot.sendAnimation(uid, reply.animation.file_id, { caption: cap || undefined })
        );
        return;
      }
      if (reply.text) {
        const text = cmdText || reply.text;
        await broadcastLoop(bot, chatId, loadChatIds, removeChatId, (uid) =>
          bot.sendMessage(uid, text)
        );
        return;
      }
    }

    if (!cmdText) {
      await bot.sendMessage(
        chatId,
        [
          "Usage:",
          "• Text: /broadcast Your message",
          "• Image (caption): send a photo with caption starting with /broadcast optional caption",
          "• Or: reply to any message with /broadcast optional caption",
        ].join("\n")
      );
      return;
    }

    await broadcastLoop(bot, chatId, loadChatIds, removeChatId, (uid) =>
      bot.sendMessage(uid, cmdText)
    );
  });

  // ── /setgroup ────────────────────────────────────────────────────────────────

  bot.onText(/\/setgroup/, async (msg) => {
    if (!isAdmin(msg.from?.id)) return;
    if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
      await bot.sendMessage(msg.chat.id, "Use /setgroup inside the target group.");
      return;
    }
    const state = schedulerStore.loadState();
    state.groupChatId = msg.chat.id;
    schedulerStore.saveState(state);
    await bot.sendMessage(msg.chat.id, "This group is now set for scheduled daily messages.");
  });

  // ── /addmsg ──────────────────────────────────────────────────────────────────

  bot.onText(/\/addmsg/, async (msg) => {
    if (!isAdmin(msg.from?.id)) return;
    const source = msg.reply_to_message;
    if (!source) {
      await bot.sendMessage(
        msg.chat.id,
        "Reply to a message with /addmsg to store it for daily scheduling."
      );
      return;
    }
    const state = schedulerStore.loadState();
    const newItem = {
      id: state.nextMessageId,
      sourceChatId: source.chat.id,
      sourceMessageId: source.message_id,
      kind: messageKind(source),
      preview: messagePreview(source),
      addedAt: new Date().toISOString(),
    };
    state.library.push(newItem);
    state.nextMessageId += 1;
    schedulerStore.saveState(state);
    await bot.sendMessage(
      msg.chat.id,
      `Saved message #${newItem.id} (${newItem.kind}) for daily queue.`
    );
  });

  // ── /listmsgs ────────────────────────────────────────────────────────────────

  bot.onText(/\/listmsgs/, async (msg) => {
    if (!isAdmin(msg.from?.id)) return;
    const state = schedulerStore.loadState();
    if (state.library.length === 0) {
      await bot.sendMessage(msg.chat.id, "Message library is empty.");
      return;
    }
    const lines = state.library.slice(-30).map((item) => {
      const preview = item.preview ? ` - ${item.preview}` : "";
      return `#${item.id} [${item.kind}]${preview}`;
    });
    await bot.sendMessage(
      msg.chat.id,
      `Stored messages: ${state.library.length}\n` + lines.join("\n")
    );
  });

  // ── /delmsg ──────────────────────────────────────────────────────────────────

  bot.onText(/\/delmsg\s+(\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from?.id)) return;
    const id = Number(match[1]);
    const state = schedulerStore.loadState();
    const before = state.library.length;
    state.library = state.library.filter((m) => m.id !== id);
    if (state.library.length === before) {
      await bot.sendMessage(msg.chat.id, `Message #${id} not found.`);
      return;
    }
    schedulerStore.saveState(state);
    await bot.sendMessage(msg.chat.id, `Deleted message #${id}.`);
  });

  // ── Daily schedule ticker ─────────────────────────────────────────────────────

  setInterval(() => {
    runDailyScheduleTick(bot, cfg, schedulerStore, logPrefix).catch((err) =>
      console.error(`${logPrefix} schedule tick failed:`, err.message)
    );
  }, 60 * 1000);
  runDailyScheduleTick(bot, cfg, schedulerStore, logPrefix).catch((err) =>
    console.error(`${logPrefix} initial schedule tick failed:`, err.message)
  );

  // ── Polling error ─────────────────────────────────────────────────────────────

  bot.on("polling_error", (err) => {
    if (typeof hooks.onPollingError === "function") {
      hooks.onPollingError(err);
    }
    console.error(`${logPrefix} polling error:`, err.message);
  });
}
