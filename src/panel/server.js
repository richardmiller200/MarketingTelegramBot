import http from "http";
import crypto from "crypto";
import {
  PANEL_PORT,
  PANEL_HOST,
  PANEL_USERNAME,
  PANEL_PASSWORD,
  PANEL_MAX_FAILED_ATTEMPTS,
} from "../config/constants.js";
import { parseCookies, parseBody } from "../utils/helpers.js";
import { parseButtonsPerRow } from "../utils/parsers.js";
import {
  loadBotRows,
  loadEnabledConfigsFromDb,
  createScheduledBroadcast,
  toggleScheduledBroadcast,
  deleteScheduledBroadcast,
} from "../db/database.js";
import { getStatusRows, startBot } from "../bot/runner.js";
import { readAdminLoginState, writeAdminLoginState } from "./auth.js";
import { runPanelBroadcast } from "./broadcast.js";
import {
  readTemplateFile,
  renderLoginPage,
  renderPanelPage,
  parseButtonsFromForm,
  parseBroadcastButtonsFromForm,
} from "./renderer.js";
import {
  parseMessageTemplateButtonsFromForm,
  sanitizeMessageTemplateFields,
} from "../templates/messageTemplates.js";

// ─── Admin panel HTTP server ──────────────────────────────────────────────────

export function startAdminPanel(db, instances) {
  const sessions = new Set();
  const isAuthed = (req) => sessions.has(parseCookies(req).session || "");
  const redirect = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };
  const readForm = async (req) => new URLSearchParams(await parseBody(req));

  // ── Runtime op queue (serializes per-bot restart operations) ─────────────────
  const runtimeOpsByBotId = new Map();
  const queueRuntimeOp = (id, task) => {
    const botId = Number(id || 0);
    if (!botId) return Promise.resolve();
    const prev = runtimeOpsByBotId.get(botId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (runtimeOpsByBotId.get(botId) === next) runtimeOpsByBotId.delete(botId);
      });
    runtimeOpsByBotId.set(botId, next);
    return next;
  };

  const findInstanceIndexByBotId = (id) =>
    instances.findIndex((item) => Number(item?.cfg?.id || 0) === Number(id || 0));

  const stopInstanceAt = async (idx) => {
    if (idx < 0 || idx >= instances.length) return;
    const inst = instances[idx];
    try { await inst.bot.stopPolling({ cancel: true }); } catch {}
    try { inst.bot.removeAllListeners(); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
    instances.splice(idx, 1);
  };

  const applyRuntimeForBotId = async (id) => {
    const botId = Number(id || 0);
    if (!botId) return;
    await queueRuntimeOp(botId, async () => {
      const enabledConfigs = await loadEnabledConfigsFromDb(db);
      const nextCfg = enabledConfigs.find((c) => Number(c.id || 0) === botId);
      const idx = findInstanceIndexByBotId(botId);
      const current = idx >= 0 ? instances[idx] : null;

      // If token/slug unchanged, update config in-place (no poller restart needed)
      if (
        current &&
        nextCfg &&
        String(current.cfg.token) === String(nextCfg.token) &&
        String(current.cfg.slug) === String(nextCfg.slug)
      ) {
        current.cfg.name = nextCfg.name;
        current.cfg.adminIds = nextCfg.adminIds;
        current.cfg.enabled = nextCfg.enabled;
        current.cfg.welcomeExtra = nextCfg.welcomeExtra;
        current.cfg.welcomeImage = nextCfg.welcomeImage;
        current.cfg.groupChatId = nextCfg.groupChatId;
        current.cfg.channelUrl = nextCfg.channelUrl;
        current.cfg.welcomeButtons = nextCfg.welcomeButtons;
        current.cfg.welcomeButtonsPerRow = nextCfg.welcomeButtonsPerRow;
        current.cfg.isFirstAndheriBot = nextCfg.isFirstAndheriBot;
        current.runtime.name = nextCfg.name;
        return;
      }

      await stopInstanceAt(idx);
      if (!nextCfg) return;
      instances.push(startBot(nextCfg));
    });
  };

  // ── HTTP server ───────────────────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? "/", "http://localhost");

      // ── Static assets ─────────────────────────────────────────────────────────
      if (req.method === "GET" && reqUrl.pathname === "/assets/login.css") {
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
        res.end(readTemplateFile("assets/login.css"));
        return;
      }
      if (req.method === "GET" && reqUrl.pathname === "/assets/panel.css") {
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
        res.end(readTemplateFile("assets/panel.css"));
        return;
      }

      // ── GET /login ────────────────────────────────────────────────────────────
      if (req.method === "GET" && reqUrl.pathname === "/login") {
        const loginState = readAdminLoginState();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderLoginPage(loginState.locked
          ? "Login is locked after 3 failed attempts. Reset from server SSH."
          : ""));
        return;
      }

      // ── POST /login ───────────────────────────────────────────────────────────
      if (req.method === "POST" && reqUrl.pathname === "/login") {
        const loginState = readAdminLoginState();
        if (loginState.locked) {
          res.writeHead(423, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderLoginPage("Login is locked. Reset from server SSH."));
          return;
        }
        const form = await readForm(req);
        const user = String(form.get("username") ?? "").trim();
        const pass = String(form.get("password") ?? "");
        if (user === PANEL_USERNAME && pass === PANEL_PASSWORD && PANEL_PASSWORD) {
          writeAdminLoginState({ failedAttempts: 0, locked: false, lockedAt: "" });
          const sid = crypto.randomBytes(24).toString("hex");
          sessions.add(sid);
          res.writeHead(302, {
            Location: "/panel",
            "Set-Cookie": `session=${sid}; HttpOnly; SameSite=Lax; Path=/`,
          });
          res.end();
          return;
        }
        const nextFailed = Number(loginState.failedAttempts || 0) + 1;
        const shouldLock = nextFailed >= PANEL_MAX_FAILED_ATTEMPTS;
        writeAdminLoginState({
          failedAttempts: nextFailed,
          locked: shouldLock,
          lockedAt: shouldLock ? new Date().toISOString() : "",
        });
        res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderLoginPage(
          shouldLock
            ? "Login locked after 3 failed attempts. Reset from server SSH."
            : `Invalid credentials. Attempt ${nextFailed}/${PANEL_MAX_FAILED_ATTEMPTS}.`
        ));
        return;
      }

      // ── GET /logout ───────────────────────────────────────────────────────────
      if (req.method === "GET" && reqUrl.pathname === "/logout") {
        sessions.delete(parseCookies(req).session || "");
        res.writeHead(302, { Location: "/login", "Set-Cookie": "session=; Max-Age=0; Path=/" });
        res.end();
        return;
      }

      // ── Auth guard ────────────────────────────────────────────────────────────
      if (!isAuthed(req)) { redirect(res, "/login"); return; }

      // ── GET /panel ─────────────────────────────────────────────────────────────
      if (req.method === "GET" && (reqUrl.pathname === "/" || reqUrl.pathname === "/panel")) {
        const rows = await loadBotRows(db);
        const live = getStatusRows(instances);
        const edit = Number(reqUrl.searchParams.get("edit") || 0);
        const notice = reqUrl.searchParams.get("notice") || "";
        const view = String(reqUrl.searchParams.get("view") || "dashboard");
        const broadcastRef = view === "broadcast" ? String(reqUrl.searchParams.get("ref") || "") : "";
        const editingBotId = view === "add" ? edit : 0;
        const templateNew = view === "messages" && String(reqUrl.searchParams.get("new") || "") === "1";
        const templateEditId = view === "messages" && !templateNew ? edit : 0;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(await renderPanelPage({
          botRows: rows,
          statusRows: live,
          editingId: editingBotId,
          templateEditId,
          templateNew,
          broadcastRef,
          notice,
          view,
          db,
        }));
        return;
      }

      // ── POST /panel/save ───────────────────────────────────────────────────────
      if (req.method === "POST" && reqUrl.pathname === "/panel/save") {
        const form = await readForm(req);
        const buttons = parseButtonsFromForm(form);
        const payload = {
          id: Number(form.get("id") || 0),
          name: String(form.get("name") ?? "").trim(),
          token: String(form.get("token") ?? "").trim(),
          admin_ids: String(form.get("admin_ids") ?? "").trim(),
          enabled: form.get("enabled") ? 1 : 0,
          welcome_message: String(form.get("welcome_message") ?? "").trim(),
          welcome_image: String(form.get("welcome_image") ?? "").trim(),
          group_chat_id: String(form.get("group_chat_id") ?? "").trim(),
          channel_url: String(form.get("channel_url") ?? "").trim(),
          random_channel_urls: "",
          welcome_buttons: JSON.stringify(buttons),
          buttons_per_row: parseButtonsPerRow(form.get("buttons_per_row") ?? 2),
          button_layout: "",
          updated_at: new Date().toISOString(),
        };

        if (!payload.name || !payload.token) {
          redirect(res, "/panel?view=add&notice=Name%20and%20token%20are%20required");
          return;
        }

        if (payload.id > 0) {
          await db.run(
            `UPDATE bots SET
              name=$1, token=$2, admin_ids=$3, enabled=$4, welcome_message=$5,
              welcome_image=$6, group_chat_id=$7, channel_url=$8,
              random_channel_urls=$9, welcome_buttons=$10,
              buttons_per_row=$11, button_layout=$12, updated_at=$13
            WHERE id=$14`,
            [
              payload.name, payload.token, payload.admin_ids, payload.enabled,
              payload.welcome_message, payload.welcome_image, payload.group_chat_id,
              payload.channel_url, payload.random_channel_urls, payload.welcome_buttons,
              payload.buttons_per_row, payload.button_layout, payload.updated_at, payload.id,
            ]
          );
          await applyRuntimeForBotId(payload.id);
          redirect(res, "/panel?view=bots&notice=Bot%20updated%20and%20applied%20live.");
          return;
        }

        const result = await db.run(
          `INSERT INTO bots (
            name, token, admin_ids, enabled, welcome_message, welcome_image,
            group_chat_id, channel_url, random_channel_urls, welcome_buttons,
            buttons_per_row, button_layout, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [
            payload.name, payload.token, payload.admin_ids, payload.enabled,
            payload.welcome_message, payload.welcome_image, payload.group_chat_id,
            payload.channel_url, payload.random_channel_urls, payload.welcome_buttons,
            payload.buttons_per_row, payload.button_layout, payload.updated_at, payload.updated_at,
          ]
        );
        await applyRuntimeForBotId(result.lastInsertRowid);
        redirect(res, "/panel?view=bots&notice=Bot%20created%20and%20applied%20live.");
        return;
      }

      // ── POST /panel/broadcast ──────────────────────────────────────────────────
      if (req.method === "POST" && reqUrl.pathname === "/panel/broadcast") {
        const form = await readForm(req);
        const botIds = String(form.getAll("bot_ids").join(","))
          .split(",")
          .map((s) => Number(String(s).trim()))
          .filter((n) => !Number.isNaN(n) && n > 0);
        const result = await runPanelBroadcast({
          botIds,
          message: String(form.get("broadcast_message") ?? "").trim(),
          image: String(form.get("broadcast_image") ?? "").trim(),
          testMode: Boolean(form.get("test_mode")),
          testChatId: Number(form.get("test_chat_id") || 0),
          broadcastButtons: parseBroadcastButtonsFromForm(form),
          broadcastButtonsPerRow: parseButtonsPerRow(form.get("broadcast_buttons_per_row") ?? 2),
          instances,
        });
        redirect(res, `/panel?view=broadcast&notice=${encodeURIComponent(result.notice)}`);
        return;
      }

      // ── POST /panel/delete ─────────────────────────────────────────────────────
      if (req.method === "POST" && reqUrl.pathname === "/panel/delete") {
        const form = await readForm(req);
        const id = Number(form.get("id") || 0);
        if (id > 0) {
          await stopInstanceAt(findInstanceIndexByBotId(id));
          await db.run("DELETE FROM bots WHERE id = $1", [id]);
        }
        redirect(res, "/panel?view=bots&notice=Bot%20deleted%20and%20stopped%20live.");
        return;
      }

      // ── POST /panel/message-save ───────────────────────────────────────────────
      if (req.method === "POST" && reqUrl.pathname === "/panel/message-save") {
        const form = await readForm(req);
        const id = Number(form.get("id") || 0);
        const rawButtons = parseMessageTemplateButtonsFromForm(form);
        const { title, body, imageUrl, buttons, buttonsPerRow } = sanitizeMessageTemplateFields({
          title: form.get("title"),
          body: form.get("body"),
          image_url: form.get("image_url"),
          buttons: rawButtons,
          buttons_per_row: form.get("buttons_per_row") ?? 2,
        });
        if (!title || !body) {
          redirect(res, `/panel?view=messages&notice=${encodeURIComponent("Title and message are required.")}`);
          return;
        }
        const buttonsJson = JSON.stringify(buttons);
        const now = new Date().toISOString();
        if (id > 0) {
          const row = await db.get("SELECT id FROM message_templates WHERE id = $1", [id]);
          if (!row) {
            redirect(res, `/panel?view=messages&notice=${encodeURIComponent("Saved message not found.")}`);
            return;
          }
          await db.run(
            `UPDATE message_templates
            SET title=$1, body=$2, image_url=$3, buttons=$4, buttons_per_row=$5, updated_at=$6
            WHERE id=$7`,
            [title, body, imageUrl, buttonsJson, buttonsPerRow, now, id]
          );
          redirect(res, `/panel?view=messages&edit=${id}&notice=${encodeURIComponent("Message updated.")}`);
          return;
        }
        const ins = await db.run(
          `INSERT INTO message_templates (title, body, image_url, buttons, buttons_per_row, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [title, body, imageUrl, buttonsJson, buttonsPerRow, now, now]
        );
        const newId = Number(ins.lastInsertRowid || 0);
        redirect(
          res,
          newId > 0
            ? `/panel?view=messages&edit=${newId}&notice=${encodeURIComponent("Message saved.")}`
            : `/panel?view=messages&notice=${encodeURIComponent("Message saved.")}`
        );
        return;
      }

      // ── POST /panel/message-delete ─────────────────────────────────────────────
      if (req.method === "POST" && reqUrl.pathname === "/panel/message-delete") {
        const form = await readForm(req);
        const id = Number(form.get("id") || 0);
        if (id > 0) await db.run("DELETE FROM message_templates WHERE id = $1", [id]);
        redirect(res, `/panel?view=messages&notice=${encodeURIComponent("Message deleted.")}`);
        return;
      }

      // ── POST /panel/schedule-save ──────────────────────────────────────────────
      if (req.method === "POST" && reqUrl.pathname === "/panel/schedule-save") {
        const form = await readForm(req);

        // Bot IDs — same multi-select as the broadcast form
        const botIds = String(form.getAll("bot_ids").join(","))
          .split(",")
          .map((s) => Number(String(s).trim()))
          .filter((n) => !Number.isNaN(n) && n > 0);

        const message = String(form.get("broadcast_message") ?? "").trim();
        const imageUrl = String(form.get("broadcast_image") ?? "").trim();
        const buttons = parseBroadcastButtonsFromForm(form);
        const buttonsPerRow = parseButtonsPerRow(form.get("broadcast_buttons_per_row") ?? 2);
        const intervalDays = Math.max(1, Number(form.get("interval_days") || 1));
        const sendTime = String(form.get("send_time") ?? "09:00");
        const [rawHour, rawMinute] = sendTime.split(":").map(Number);
        const sendHour = Number.isNaN(rawHour) ? 9 : rawHour;
        const sendMinute = Number.isNaN(rawMinute) ? 0 : rawMinute;

        if (botIds.length === 0 || !message) {
          redirect(res, `/panel?view=broadcast&notice=${encodeURIComponent("Select at least one bot and enter a message.")}`);
          return;
        }

        await createScheduledBroadcast(db, {
          botIds,
          message,
          imageUrl,
          buttons,
          buttonsPerRow,
          intervalDays,
          sendHour,
          sendMinute,
        });
        redirect(res, `/panel?view=broadcast&notice=${encodeURIComponent("Schedule created successfully.")}`);
        return;
      }

      // ── POST /panel/schedule-toggle ────────────────────────────────────────────
      if (req.method === "POST" && reqUrl.pathname === "/panel/schedule-toggle") {
        const form = await readForm(req);
        const id = Number(form.get("id") || 0);
        if (id > 0) await toggleScheduledBroadcast(db, id);
        redirect(res, `/panel?view=broadcast&notice=${encodeURIComponent("Schedule updated.")}`);
        return;
      }

      // ── POST /panel/schedule-delete ────────────────────────────────────────────
      if (req.method === "POST" && reqUrl.pathname === "/panel/schedule-delete") {
        const form = await readForm(req);
        const id = Number(form.get("id") || 0);
        if (id > 0) await deleteScheduledBroadcast(db, id);
        redirect(res, `/panel?view=broadcast&notice=${encodeURIComponent("Schedule deleted.")}`);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Server error");
      console.error("Panel error:", err.message);
    }
  });

  server.listen(PANEL_PORT, PANEL_HOST, () => {
    console.log(`Admin panel: http://${PANEL_HOST}:${PANEL_PORT}/login`);
  });
}
