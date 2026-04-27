import fs from "fs";
import path from "path";
import { TEMPLATES_DIR, MESSAGE_TEMPLATE_TITLE_MAX, MESSAGE_TEMPLATE_BODY_MAX, MESSAGE_TEMPLATE_IMAGE_MAX } from "../config/constants.js";
import { parseButtonsPerRow, slugify } from "../utils/parsers.js";
import { escapeHtml, truncateSingleLine } from "../utils/helpers.js";
import { loadBroadcastLogs } from "./broadcastLog.js";
import { loadInteractedUserIdsForSlug } from "../bot/runner.js";
import { loadScheduledBroadcasts } from "../db/database.js";
import { computeNextRun } from "../bot/broadcastScheduler.js";
import {
  loadMessageTemplates,
  parseMessageTemplateReferenceId,
  parseMessageTemplateButtons,
  renderMessageLibraryListPreview,
} from "../templates/messageTemplates.js";

// ─── File helpers ─────────────────────────────────────────────────────────────

export function readTemplateFile(name) {
  return fs.readFileSync(path.join(TEMPLATES_DIR, name), "utf8");
}

// ─── Form parsers ─────────────────────────────────────────────────────────────

export function parseButtonsFromForm(form) {
  const buttons = [];
  const fallbackPerRow = parseButtonsPerRow(form.get("buttons_per_row") ?? 2);
  for (let i = 1; i <= 5; i += 1) {
    const text = String(form.get(`button_${i}_text`) ?? "").trim();
    const url = String(form.get(`button_${i}_url`) ?? "").trim();
    const perRow = parseButtonsPerRow(form.get(`button_${i}_row`) ?? "", fallbackPerRow);
    if (text && /^https?:\/\//i.test(url)) {
      buttons.push({ text, url, perRow });
    }
  }
  return buttons;
}

export function parseBroadcastButtonsFromForm(form) {
  const buttons = [];
  const fallbackPerRow = parseButtonsPerRow(form.get("broadcast_buttons_per_row") ?? 2);
  for (let i = 1; i <= 5; i += 1) {
    const text = String(form.get(`broadcast_button_${i}_text`) ?? "").trim();
    const url = String(form.get(`broadcast_button_${i}_url`) ?? "").trim();
    const perRow = parseButtonsPerRow(form.get(`broadcast_button_${i}_row`) ?? "", fallbackPerRow);
    if (text && /^https?:\/\//i.test(url)) {
      buttons.push({ text, url, perRow });
    }
  }
  return buttons;
}

// ─── Login page ───────────────────────────────────────────────────────────────

export function renderLoginPage(error = "") {
  const tpl = readTemplateFile("login.html");
  return tpl.replace(
    "{{error_block}}",
    error ? `<div class="err">${escapeHtml(error)}</div>` : ""
  );
}

// ─── Panel page ───────────────────────────────────────────────────────────────

export async function renderPanelPage({
  botRows,
  statusRows,
  editingId = 0,
  templateEditId = 0,
  templateNew = false,
  broadcastRef = "",
  notice = "",
  view = "dashboard",
  db,
}) {
  const templates =
    view === "messages" || view === "broadcast"
      ? await loadMessageTemplates(db)
      : [];

  const scheduledBroadcasts =
    view === "broadcast" ? await loadScheduledBroadcasts(db) : [];

  const rowsBySlug = new Map(statusRows.map((r) => [r.slug, r]));
  const totalBots = botRows.length;
  const enabledBots = botRows.filter((b) => Number(b.enabled) !== 0).length;
  const totalMembers = statusRows.reduce((sum, r) => sum + Number(r.members || 0), 0);
  const healthyBots = statusRows.filter((r) => r.healthy).length;
  const totalErrors = statusRows.reduce((sum, r) => sum + Number(r.pollingErrorCount || 0), 0);
  const topBots = [...statusRows].sort((a, b) => Number(b.members) - Number(a.members)).slice(0, 5);

  // ── Bots table ──────────────────────────────────────────────────────────────
  const tableRows = botRows
    .map((b, idx) => {
      const slug = slugify(String(b.name ?? ""), idx);
      const live = rowsBySlug.get(slug);
      const members = live ? live.members : 0;
      const health = live && live.healthy ? "Healthy" : "Not Running";
      const healthClass = live && live.healthy ? "ok" : "warn";
      const enabledLabel = Number(b.enabled) ? "Yes" : "No";
      return `<tr data-searchable="${escapeHtml(`${b.name} ${members} ${health} ${enabledLabel}`)}">
        <td>${escapeHtml(b.name)}</td>
        <td>${members}</td>
        <td><span class="pill ${healthClass}">${health}</span></td>
        <td>${enabledLabel}</td>
        <td class="actions">
          <a href="/panel?view=add&edit=${b.id}">Edit</a>
          <form method="POST" action="/panel/delete" onsubmit="return confirm('Delete this bot?');">
            <input type="hidden" name="id" value="${b.id}"/>
            <button type="submit">Delete</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  // ── Current bot editing state ───────────────────────────────────────────────
  const current = botRows.find((b) => Number(b.id) === Number(editingId));
  const buttons = (() => {
    try {
      const parsed = JSON.parse(String(current?.welcome_buttons ?? "[]"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  const buttonAt = (i, key) => escapeHtml(buttons[i - 1]?.[key] ?? "");
  const buttonRowAt = (i) =>
    parseButtonsPerRow(buttons[i - 1]?.perRow ?? current?.buttons_per_row ?? 2);
  const hasButtonAt = (i) => {
    const text = String(buttons[i - 1]?.text ?? "").trim();
    const url = String(buttons[i - 1]?.url ?? "").trim();
    return Boolean(text && /^https?:\/\//i.test(url));
  };

  // ── Running bot options (for broadcast select) ──────────────────────────────
  const runningBotOptions = botRows
    .map((b) => {
      const live = statusRows.find((r) => Number(r.id || 0) === Number(b.id || 0));
      if (!live) return null;
      const members = Number(live.members || 0);
      return `<option value="${Number(b.id)}">${escapeHtml(String(b.name ?? ""))} (${members} users)</option>`;
    })
    .filter(Boolean)
    .join("");

  // ── Broadcast history ───────────────────────────────────────────────────────
  const broadcastHistoryRows = loadBroadcastLogs(25)
    .map(
      (r) =>
        `<tr data-searchable="${escapeHtml(`${r.botName} ${r.mode} ${r.sent} ${r.failed} ${r.note}`)}">
          <td>${escapeHtml(String(r.at ?? ""))}</td>
          <td>${escapeHtml(r.botName)}</td>
          <td>${escapeHtml(r.mode)}</td>
          <td>${Number(r.recipients || 0)}</td>
          <td>${Number(r.sent || 0)}</td>
          <td>${Number(r.failed || 0)}</td>
          <td>${escapeHtml(r.note || (r.ok ? "OK" : "Failed"))}</td>
        </tr>`
    )
    .join("");

  // ── Dashboard top bots ──────────────────────────────────────────────────────
  const dashboardTopBots = topBots
    .map(
      (r) =>
        `<tr data-searchable="${escapeHtml(`${r.name} ${Number(r.members || 0)} ${r.healthy ? "Healthy" : "Issue"}`)}">
          <td>${escapeHtml(r.name)}</td>
          <td>${Number(r.members || 0)}</td>
          <td><span class="pill ${r.healthy ? "ok" : "warn"}">${r.healthy ? "Healthy" : "Issue"}</span></td>
        </tr>`
    )
    .join("");

  // ── Interacted users ────────────────────────────────────────────────────────
  const interactedRows = botRows.map((b, idx) => {
    const slug = slugify(String(b.name ?? ""), idx);
    const users = loadInteractedUserIdsForSlug(slug);
    return { name: String(b.name ?? ""), slug, count: users.length, users };
  });
  const totalInteractedUsers = interactedRows.reduce((sum, r) => sum + r.count, 0);
  const uniqueInteractedUsers = new Set(
    interactedRows.flatMap((r) => r.users.map((u) => u.chatId))
  ).size;
  const usersTableRows = interactedRows
    .map((r) => {
      const preview =
        r.users.length > 0
          ? r.users
              .slice(0, 6)
              .map((u) => {
                const handle = u.username ? `@${u.username}` : "";
                const fullName = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
                return (
                  handle ||
                  (fullName
                    ? `${escapeHtml(fullName)} (${escapeHtml(u.chatId)})`
                    : escapeHtml(u.chatId))
                );
              })
              .join(", ")
          : "No users yet";
      return `<tr data-searchable="${escapeHtml(`${r.name} ${preview} ${r.count}`)}">
        <td>${escapeHtml(r.name)}</td>
        <td>${r.count}</td>
        <td><code>${preview}</code></td>
      </tr>`;
    })
    .join("");

  // ── View content ────────────────────────────────────────────────────────────
  const content = buildViewContent({
    view,
    tableRows,
    statusRows,
    totalBots,
    enabledBots,
    totalMembers,
    healthyBots,
    totalErrors,
    dashboardTopBots,
    totalInteractedUsers,
    uniqueInteractedUsers,
    usersTableRows,
    runningBotOptions,
    broadcastHistoryRows,
    broadcastRef,
    templates,
    scheduledBroadcasts,
    templateEditId,
    templateNew,
    current,
    buttonAt,
    buttonRowAt,
    hasButtonAt,
  });

  const tpl = readTemplateFile("panel.html");
  return tpl
    .replace("{{dashboard_active}}", view === "dashboard" ? "active" : "")
    .replace("{{bots_active}}", view === "bots" ? "active" : "")
    .replace("{{logs_active}}", view === "logs" ? "active" : "")
    .replace("{{analytics_active}}", view === "analytics" ? "active" : "")
    .replace("{{users_active}}", view === "users" ? "active" : "")
    .replace("{{broadcast_active}}", view === "broadcast" ? "active" : "")
    .replace("{{messages_active}}", view === "messages" ? "active" : "")
    .replace("{{add_active}}", view === "add" ? "active" : "")
    .replace("{{content}}", content)
    .replace(
      "{{notice_block}}",
      notice
        ? `<div class="panel"><div class="note">${escapeHtml(notice)}</div></div>`
        : ""
    );
}

// ─── View builders ────────────────────────────────────────────────────────────

function buildViewContent(ctx) {
  const {
    view,
    tableRows,
    statusRows,
    totalBots,
    enabledBots,
    totalMembers,
    healthyBots,
    totalErrors,
    dashboardTopBots,
    totalInteractedUsers,
    uniqueInteractedUsers,
    usersTableRows,
    runningBotOptions,
    broadcastHistoryRows,
    broadcastRef,
    templates,
    scheduledBroadcasts,
    templateEditId,
    templateNew,
    current,
    buttonAt,
    buttonRowAt,
    hasButtonAt,
  } = ctx;

  if (view === "bots") return buildBotsView(tableRows);
  if (view === "logs") return buildLogsView(statusRows);
  if (view === "analytics") return buildAnalyticsView({ totalBots, enabledBots, totalMembers, totalErrors });
  if (view === "users") return buildUsersView({ totalInteractedUsers, uniqueInteractedUsers, usersTableRows });
  if (view === "messages") return buildMessagesView({ templates, templateEditId, templateNew });
  if (view === "broadcast") return buildBroadcastView({ runningBotOptions, broadcastHistoryRows, broadcastRef, templates, scheduledBroadcasts });
  if (view === "add") return buildAddBotView({ current, buttonAt, buttonRowAt, hasButtonAt });
  return buildDashboardView({ healthyBots, totalMembers, enabledBots, totalBots, totalErrors, dashboardTopBots });
}

function buildBotsView(tableRows) {
  return `<div class="panel">
    <h2>All Bots</h2>
    <table>
      <thead><tr><th>Bot</th><th>Members</th><th>Status</th><th>Enabled</th><th>Actions</th></tr></thead>
      <tbody>${tableRows || "<tr><td colspan='5'>No bots found.</td></tr>"}</tbody>
    </table>
  </div>`;
}

function buildLogsView(statusRows) {
  const logRows = statusRows
    .map((r) => {
      const level = r.lastPollingError ? "ERROR" : "INFO";
      const msg = r.lastPollingError
        ? r.lastPollingError
        : `${r.name} operational with ${r.members} members tracked.`;
      return `<div class="log-line" data-searchable="${escapeHtml(`${r.name} ${level} ${msg}`)}">
        <span class="log-time">[${new Date().toISOString().slice(11, 19)}]</span>
        <strong>${level}</strong> ${escapeHtml(msg)}
      </div>`;
    })
    .join("");
  return `<div class="panel">
    <h2>Global Logs</h2>
    <div class="logs-box">${logRows || "<div class='log-line'>No logs yet.</div>"}</div>
  </div>`;
}

function buildAnalyticsView({ totalBots, enabledBots, totalMembers, totalErrors }) {
  const avg = totalBots > 0 ? (totalMembers / totalBots).toFixed(1) : "0";
  return `<div class="panel">
    <h2>User Analytics</h2>
    <div class="text-screen">
      <p>Total tracked members: <strong>${totalMembers}</strong></p>
      <p>Average members per bot: <strong>${avg}</strong></p>
      <p>Enabled bot share: <strong>${enabledBots}/${totalBots}</strong></p>
      <p>Polling error count (live session): <strong>${totalErrors}</strong></p>
    </div>
  </div>`;
}

function buildUsersView({ totalInteractedUsers, uniqueInteractedUsers, usersTableRows }) {
  return `<div class="panel">
    <h2>Interacted Users</h2>
    <div class="text-screen">
      <p>Total interactions recorded: <strong>${totalInteractedUsers}</strong></p>
      <p>Unique user IDs across all bots: <strong>${uniqueInteractedUsers}</strong></p>
    </div>
    <table>
      <thead><tr><th>Bot</th><th>User Count</th><th>Sample User IDs</th></tr></thead>
      <tbody>${usersTableRows || "<tr><td colspan='3'>No user interactions found yet.</td></tr>"}</tbody>
    </table>
  </div>`;
}

function buildMessagesView({ templates, templateEditId, templateNew }) {
  const editId = Number(templateEditId || 0);
  const editingTpl = editId > 0 ? templates.find((t) => Number(t.id) === editId) || null : null;
  const unknownEdit = editId > 0 && !editingTpl && !templateNew;
  const showCompose = Boolean(templateNew || (editId > 0 && editingTpl));

  if (showCompose) {
    return buildMessageComposeView({ editingTpl });
  }
  return buildMessageListView({ templates, unknownEdit });
}

function buildMessageComposeView({ editingTpl }) {
  const formTitle = escapeHtml(editingTpl?.title ?? "");
  const formBody = escapeHtml(editingTpl?.body ?? "");
  const formImage = escapeHtml(editingTpl?.image_url ?? "");
  const formId = editingTpl ? Number(editingTpl.id) : 0;
  const composePublicId = editingTpl != null ? `MSG-${Number(editingTpl.id)}` : "";
  const composeHeading = editingTpl ? `Edit ${escapeHtml(composePublicId)}` : "New Saved Message";
  const currentBtns = editingTpl ? parseMessageTemplateButtons(editingTpl.buttons) : [];
  const currentBpr = parseButtonsPerRow(editingTpl?.buttons_per_row ?? 2);
  const mtButtonAt = (i, key) => escapeHtml(currentBtns[i - 1]?.[key] ?? "");
  const mtButtonRowAt = (i) =>
    parseButtonsPerRow(currentBtns[i - 1]?.row ?? currentBpr, currentBpr);
  const mtHasButtonAt = (i) =>
    Boolean(currentBtns[i - 1]?.text || currentBtns[i - 1]?.url);
  const previewImageAttrs =
    editingTpl?.image_url && /^https?:\/\//i.test(String(editingTpl.image_url))
      ? `src="${escapeHtml(String(editingTpl.image_url))}"`
      : "hidden";

  const mtButtonRowsHtml = [1, 2, 3, 4, 5]
    .map(
      (i) =>
        `<div class="row button-row msg-button-row" data-msg-button-row="${i}" ${
          i === 1 || mtHasButtonAt(i) ? "" : "style='display:none'"
        }>
          <label>Button ${i} Text<input name="msg_button_${i}_text" placeholder="Optional" value="${mtButtonAt(i, "text")}"/></label>
          <label>Button ${i} URL<input name="msg_button_${i}_url" placeholder="https://..." value="${mtButtonAt(i, "url")}"/></label>
          <label>Row Size
            <select name="msg_button_${i}_row">
              <option value="1" ${mtButtonRowAt(i) === 1 ? "selected" : ""}>1/1</option>
              <option value="2" ${mtButtonRowAt(i) === 2 ? "selected" : ""}>1/2</option>
              <option value="3" ${mtButtonRowAt(i) === 3 ? "selected" : ""}>1/3</option>
            </select>
          </label>
          ${i === 1 ? "<div></div>" : `<button type="button" class="muted msg-remove-btn" data-remove-msg-button="${i}">Remove</button>`}
        </div>`
    )
    .join("");

  return `<div class="panel">
  <div class="panel-heading-row">
    <h2>${composeHeading}</h2>
    <a class="muted panel-heading-action" href="/panel?view=messages">Back to list</a>
  </div>
  <form class="main message-template-form" method="POST" action="/panel/message-save">
    <input type="hidden" name="id" value="${formId}"/>
    ${editingTpl ? `<div class="msg-template-id-banner">Reference ID: <code>${escapeHtml(composePublicId)}</code></div>` : ""}
    <label>Title<input name="title" required maxlength="${MESSAGE_TEMPLATE_TITLE_MAX}" placeholder="e.g. Weekly promo" value="${formTitle}"/></label>
    <label>Message<textarea name="body" required maxlength="${MESSAGE_TEMPLATE_BODY_MAX}" placeholder="Full message text…">${formBody}</textarea></label>
    <div class="row">
      <label>Image URL (optional)<input name="image_url" maxlength="${MESSAGE_TEMPLATE_IMAGE_MAX}" placeholder="https://…" value="${formImage}"/></label>
      <label>Buttons Per Row
        <select name="buttons_per_row">
          <option value="1" ${parseButtonsPerRow(editingTpl?.buttons_per_row ?? 2) === 1 ? "selected" : ""}>1</option>
          <option value="2" ${parseButtonsPerRow(editingTpl?.buttons_per_row ?? 2) === 2 ? "selected" : ""}>2</option>
          <option value="3" ${parseButtonsPerRow(editingTpl?.buttons_per_row ?? 2) === 3 ? "selected" : ""}>3</option>
        </select>
      </label>
    </div>
    ${mtButtonRowsHtml}
    <div class="submit"><button type="button" class="muted" data-add-msg-button>Add Button</button></div>
    <div class="telegram-preview" data-preview-box>
      <h2>Message Preview</h2>
      <div class="tg-screen">
        <div class="tg-bubble">
          <img class="tg-image" data-message-template-preview-image alt="" ${previewImageAttrs}/>
          <div class="tg-text" data-message-template-preview-text>${formBody || "Message will appear here…"}</div>
          <div class="tg-buttons" data-message-template-preview-buttons></div>
        </div>
      </div>
    </div>
    <div class="submit">
      <button class="primary" type="submit">${editingTpl ? "Update Message" : "Save Message"}</button>
      <a class="muted" href="/panel?view=messages">Cancel</a>
    </div>
  </form>
</div>`;
}

function buildMessageListView({ templates, unknownEdit }) {
  const hasCards = templates.length > 0;
  const cards = templates
    .map((t) => {
      const tid = Number(t.id);
      const publicId = `MSG-${tid}`;
      const body = String(t.body ?? "");
      const updatedTxt = String(t.updated_at ?? "").slice(0, 16).replace("T", " ");
      const searchBlob = `${publicId} ${t.title ?? ""} ${truncateSingleLine(body, 200)} ${String(t.image_url ?? "").trim()}`;
      const previewHtml = renderMessageLibraryListPreview(t);
      return `<article class="msg-card" data-searchable="${escapeHtml(searchBlob)}">
        <div class="msg-card-preview">${previewHtml}</div>
        <div class="msg-card-bottom">
          <div class="msg-card-title">${escapeHtml(String(t.title ?? "Untitled"))}</div>
          <div class="msg-card-meta-row">
            <code class="msg-template-id">${escapeHtml(publicId)}</code>
            <span class="msg-card-updated">${escapeHtml(updatedTxt)}</span>
          </div>
          <footer class="msg-card-foot">
            <a class="msg-card-action msg-card-edit" href="/panel?view=messages&edit=${tid}">
              <span class="material-symbols-outlined">edit</span>Edit
            </a>
            <a class="msg-card-action" href="/panel?view=broadcast&ref=${encodeURIComponent(publicId)}">
              <span class="material-symbols-outlined">campaign</span>Broadcast
            </a>
            <form method="POST" action="/panel/message-delete" onsubmit="return confirm('Delete ${escapeHtml(publicId)}?');">
              <input type="hidden" name="id" value="${tid}"/>
              <button type="submit" class="msg-card-action msg-card-delete">
                <span class="material-symbols-outlined">delete</span>Delete
              </button>
            </form>
          </footer>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="panel">
  <div class="panel-heading-row">
    <h2>Message Library</h2>
    <a class="muted panel-heading-action panel-heading-cta" href="/panel?view=messages&new=1">
      <span class="material-symbols-outlined">add</span>Add Message
    </a>
  </div>
  ${unknownEdit ? `<div class="note" style="margin:0 22px 14px;">No saved message with that id.</div>` : ""}
  ${hasCards ? `<div class="msg-gallery">${cards}</div>` : `<div class="msg-empty">No saved messages yet. Click <strong>Add Message</strong> to create one.</div>`}
</div>`;
}

function buildBroadcastView({ runningBotOptions, broadcastHistoryRows, broadcastRef, templates, scheduledBroadcasts }) {
  const normalizedRef = String(broadcastRef ?? "").trim();
  const selectedTemplateId = parseMessageTemplateReferenceId(normalizedRef);
  const selectedTemplate =
    selectedTemplateId > 0
      ? templates.find((t) => Number(t.id) === selectedTemplateId) || null
      : null;
  const prefilledButtons = selectedTemplate
    ? parseMessageTemplateButtons(selectedTemplate.buttons).slice(0, 5)
    : [];
  const prefilledButtonsPerRow = selectedTemplate
    ? parseButtonsPerRow(selectedTemplate.buttons_per_row ?? 2)
    : 2;
  const buttonAt = (i, key) => escapeHtml(String(prefilledButtons[i - 1]?.[key] ?? ""));
  const buttonRowAt = (i) =>
    parseButtonsPerRow(prefilledButtons[i - 1]?.row ?? prefilledButtonsPerRow, prefilledButtonsPerRow);
  const hasButtonAt = (i) =>
    Boolean(prefilledButtons[i - 1]?.text || prefilledButtons[i - 1]?.url);
  const prefillMessage = escapeHtml(String(selectedTemplate?.body ?? ""));
  const prefillImage = escapeHtml(String(selectedTemplate?.image_url ?? ""));
  const selectedRefLabel = selectedTemplate ? `MSG-${Number(selectedTemplate.id)}` : "";
  const refNotFound = normalizedRef && selectedTemplateId > 0 && !selectedTemplate;

  const broadcastButtonRowsHtml = [1, 2, 3, 4, 5]
    .map((i) =>
      `<div class="row button-row broadcast-button-row" data-broadcast-button-row="${i}" ${
        i === 1 || hasButtonAt(i) ? "" : "style='display:none'"
      }>
        <label>Button ${i} Text<input name="broadcast_button_${i}_text" placeholder="Optional" value="${buttonAt(i, "text")}"/></label>
        <label>Button ${i} URL<input name="broadcast_button_${i}_url" placeholder="https://..." value="${buttonAt(i, "url")}"/></label>
        <label>Row Size
          <select name="broadcast_button_${i}_row">
            <option value="1" ${buttonRowAt(i) === 1 ? "selected" : ""}>1/1</option>
            <option value="2" ${buttonRowAt(i) === 2 ? "selected" : ""}>1/2</option>
            <option value="3" ${buttonRowAt(i) === 3 ? "selected" : ""}>1/3</option>
          </select>
        </label>
        ${i === 1 ? "<div></div>" : `<button type="button" class="muted broadcast-remove-btn" data-remove-broadcast-button="${i}">Remove</button>`}
      </div>`
    )
    .join("");

  // ── Schedules table ─────────────────────────────────────────────────────────
  const scheduleRows = scheduledBroadcasts.length > 0
    ? scheduledBroadcasts.map((s) => {
        const nextRun = computeNextRun(s);
        const nextRunStr = nextRun.toISOString().slice(0, 16).replace("T", " ");
        const lastSentStr = s.last_sent_at
          ? String(s.last_sent_at).slice(0, 16).replace("T", " ")
          : "Never";
        const isActive = Number(s.active) === 1;
        const sendTime = `${String(s.send_hour).padStart(2, "0")}:${String(s.send_minute).padStart(2, "0")}`;
        const preview = truncateSingleLine(String(s.message ?? ""), 40) || "—";
        return `<tr>
          <td>${escapeHtml(preview)}</td>
          <td>Every ${Number(s.interval_days)} day${Number(s.interval_days) !== 1 ? "s" : ""} at ${sendTime}</td>
          <td>${escapeHtml(lastSentStr)}</td>
          <td>${escapeHtml(nextRunStr)}</td>
          <td><span class="pill ${isActive ? "ok" : "warn"}">${isActive ? "Active" : "Paused"}</span></td>
          <td class="actions">
            <form method="POST" action="/panel/schedule-toggle" style="display:inline">
              <input type="hidden" name="id" value="${s.id}"/>
              <button type="submit">${isActive ? "Pause" : "Resume"}</button>
            </form>
            <form method="POST" action="/panel/schedule-delete" style="display:inline" onsubmit="return confirm('Delete this schedule?');">
              <input type="hidden" name="id" value="${s.id}"/>
              <button type="submit">Delete</button>
            </form>
          </td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6">No scheduled broadcasts yet.</td></tr>`;

  return `<div class="panel"><h2>Broadcast</h2>

${selectedTemplate ? `<div class="note">Loaded template <strong>${escapeHtml(selectedRefLabel)}</strong>.</div>` : ""}
${refNotFound ? `<div class="note">No message template found for <strong>${escapeHtml(normalizedRef)}</strong>.</div>` : ""}

<form class="main" method="GET" action="/panel" style="margin-bottom:8px;">
  <input type="hidden" name="view" value="broadcast"/>
  <div class="row">
    <label>Load from Message Library (optional)
      <input name="ref" placeholder="MSG-1 or 1" value="${escapeHtml(normalizedRef)}"/>
    </label>
    <div class="submit" style="align-items:flex-end;">
      <button class="muted" type="submit">Load</button>
    </div>
  </div>
</form>

<form class="main" id="broadcast-form" method="POST" action="/panel/broadcast">
  <div class="row">
    <label>Select Bot(s)
      <select name="bot_ids" multiple required>${runningBotOptions}</select>
    </label>
    <label>Test Chat ID (optional)<input name="test_chat_id" placeholder="123456789"/></label>
  </div>
  <div class="hint">Hold Cmd/Ctrl to select multiple bots.</div>
  <label>Message<textarea name="broadcast_message" required placeholder="Type your message...">${prefillMessage}</textarea></label>
  <div class="row">
    <label>Image URL (optional)<input name="broadcast_image" placeholder="https://..." value="${prefillImage}"/></label>
    <label>Buttons Per Row
      <select name="broadcast_buttons_per_row">
        <option value="1" ${prefilledButtonsPerRow === 1 ? "selected" : ""}>1</option>
        <option value="2" ${prefilledButtonsPerRow === 2 ? "selected" : ""}>2</option>
        <option value="3" ${prefilledButtonsPerRow === 3 ? "selected" : ""}>3</option>
      </select>
    </label>
  </div>
  ${broadcastButtonRowsHtml}
  <div class="submit"><button type="button" class="muted" data-add-broadcast-button>Add Button</button></div>

  <div class="telegram-preview" data-preview-box>
    <h2>Preview</h2>
    <div class="tg-screen">
      <div class="tg-bubble">
        <img class="tg-image" data-broadcast-preview-image alt="" hidden/>
        <div class="tg-text" data-broadcast-preview-text>Message will appear here...</div>
        <div class="tg-buttons" data-broadcast-preview-buttons></div>
      </div>
    </div>
  </div>

  <!-- ── Schedule options (revealed when Schedule Later is clicked) ── -->
  <div id="schedule-options" style="display:none;">
    <div class="row">
      <label>Repeat Every (days)
        <input type="number" name="interval_days" min="1" max="365" value="2"/>
      </label>
      <label>Send Time (server local time)
        <input type="time" name="send_time" value="09:00"/>
      </label>
    </div>
    <div class="hint">The scheduler checks every minute. Make sure your server timezone matches your expectation.</div>
  </div>

  <div class="submit">
    <button class="primary" type="submit" id="btn-send-now"
      onclick="document.getElementById('broadcast-form').action='/panel/broadcast';">
      Send Now
    </button>
    <button class="muted" type="submit" id="btn-schedule-later"
      onclick="document.getElementById('broadcast-form').action='/panel/schedule-save';">
      Schedule Later
    </button>
  </div>
</form>

<script>
  document.getElementById('btn-schedule-later').addEventListener('click', function() {
    document.getElementById('schedule-options').style.display = '';
  });
</script>

</div>

<div class="panel">
  <h2>Scheduled Broadcasts</h2>
  <table>
    <thead>
      <tr><th>Message</th><th>Schedule</th><th>Last Sent</th><th>Next Run</th><th>Status</th><th>Actions</th></tr>
    </thead>
    <tbody>${scheduleRows}</tbody>
  </table>
</div>

<div class="panel">
  <h2>Broadcast History</h2>
  <table>
    <thead><tr><th>Time</th><th>Bot</th><th>Mode</th><th>Recipients</th><th>Sent</th><th>Failed</th><th>Note</th></tr></thead>
    <tbody>${broadcastHistoryRows || "<tr><td colspan='7'>No broadcast history yet.</td></tr>"}</tbody>
  </table>
</div>`;
}

function buildAddBotView({ current, buttonAt, buttonRowAt, hasButtonAt }) {
  const bprVal = parseButtonsPerRow(current?.buttons_per_row ?? 2);
  return `<div class="panel"><h2>${current ? "Edit Bot" : "Add Bot"}</h2>
<form class="main" method="POST" action="/panel/save">
  <input type="hidden" name="id" value="${current ? current.id : ""}"/>
  <div class="row">
    <label>Name<input name="name" required value="${escapeHtml(current?.name ?? "")}"/></label>
    <label>Token<input name="token" required value="${escapeHtml(current?.token ?? "")}"/></label>
  </div>
  <div class="row">
    <label>Admin IDs (comma)<input name="admin_ids" value="${escapeHtml(current?.admin_ids ?? "")}"/></label>
    <label>Group Chat ID<input name="group_chat_id" value="${escapeHtml(current?.group_chat_id ?? "")}"/></label>
  </div>
  <div class="row">
    <label>Buttons Per Row
      <select name="buttons_per_row">
        <option value="1" ${bprVal === 1 ? "selected" : ""}>1</option>
        <option value="2" ${bprVal === 2 ? "selected" : ""}>2</option>
        <option value="3" ${bprVal === 3 ? "selected" : ""}>3</option>
      </select>
    </label>
    <div></div>
  </div>
  <label>Welcome Message<textarea name="welcome_message">${escapeHtml(current?.welcome_message ?? "")}</textarea></label>
  <div class="row">
    <label>Welcome Image URL<input name="welcome_image" value="${escapeHtml(current?.welcome_image ?? "")}"/></label>
    <label>Channel URL<input name="channel_url" value="${escapeHtml(current?.channel_url ?? "")}"/></label>
  </div>
  ${[1, 2, 3, 4, 5]
    .map(
      (i) =>
        `<div class="row button-row save-button-row" data-save-button-row="${i}" ${
          i === 1 || hasButtonAt(i) ? "" : "style='display:none'"
        }>
          <label>Button ${i} Text<input name="button_${i}_text" value="${buttonAt(i, "text")}"/></label>
          <label>Button ${i} URL<input name="button_${i}_url" value="${buttonAt(i, "url")}"/></label>
          <label>Row Size
            <select name="button_${i}_row">
              <option value="1" ${buttonRowAt(i) === 1 ? "selected" : ""}>1/1</option>
              <option value="2" ${buttonRowAt(i) === 2 ? "selected" : ""}>1/2</option>
              <option value="3" ${buttonRowAt(i) === 3 ? "selected" : ""}>1/3</option>
            </select>
          </label>
          ${i === 1 ? "<div></div>" : `<button type="button" class="muted save-remove-btn" data-remove-save-button="${i}">Remove</button>`}
        </div>`
    )
    .join("")}
  <div class="submit"><button type="button" class="muted" data-add-save-button>Add Button</button></div>
  <div class="telegram-preview" data-preview-box>
    <h2>Message Preview</h2>
    <div class="tg-screen">
      <div class="tg-bubble">
        <img class="tg-image" data-preview-image alt="" ${
          current?.welcome_image ? `src="${escapeHtml(current.welcome_image)}"` : "hidden"
        }/>
        <div class="tg-text" data-preview-text>${
          escapeHtml(current?.welcome_message ?? "") || "Welcome message will appear here..."
        }</div>
        <div class="tg-buttons" data-preview-buttons></div>
      </div>
    </div>
  </div>
  <label class="check">
    <input type="checkbox" name="enabled" ${Number(current?.enabled ?? 1) ? "checked" : ""}/>
    Enabled
  </label>
  <div class="submit">
    <button class="primary" type="submit">Save Bot</button>
    <a class="muted" href="/panel?view=add">Reset</a>
  </div>
</form>
</div>`;
}

function buildDashboardView({ healthyBots, totalMembers, enabledBots, totalBots, totalErrors, dashboardTopBots }) {
  return `<section class="dashboard-hero">
    <h2 class="hero-title">Fleet Command</h2>
    <p class="hero-sub">Real-time oversight and resource allocation for your Telegram bot ecosystem.</p>
    <div class="stats-grid">
      <div class="stat"><div class="k">Active Fleet</div><div class="v">${healthyBots}</div></div>
      <div class="stat"><div class="k">Total Users</div><div class="v">${totalMembers}</div></div>
      <div class="stat"><div class="k">Total Members</div><div class="v">${totalMembers}</div></div>
      <div class="stat"><div class="k">Enabled Bots</div><div class="v">${enabledBots}</div></div>
      <div class="stat"><div class="k">API Reliability Alerts</div><div class="v">${totalErrors}</div></div>
    </div>
  </section>
  <section class="dashboard-grid">
    <div class="panel">
      <h2>Top Bots by Members</h2>
      <table>
        <thead><tr><th>Bot</th><th>Members</th><th>Status</th></tr></thead>
        <tbody>${dashboardTopBots || "<tr><td colspan='3'>No member data yet.</td></tr>"}</tbody>
      </table>
    </div>
    <div class="panel">
      <h2>Quick Insights</h2>
      <ul class="mini-list">
        <li class="mini-item" data-searchable="live coverage healthy bots">
          <div><div class="name">Live Coverage</div><div class="sub">Bots currently healthy</div></div>
          <div class="num">${healthyBots}/${totalBots}</div>
        </li>
        <li class="mini-item" data-searchable="member base tracked users">
          <div><div class="name">Member Base</div><div class="sub">Total tracked private users</div></div>
          <div class="num">${totalMembers}</div>
        </li>
        <li class="mini-item" data-searchable="risk alerts polling errors">
          <div><div class="name">Risk Alerts</div><div class="sub">Polling conflicts and other errors</div></div>
          <div class="num">${totalErrors}</div>
        </li>
      </ul>
    </div>
  </section>`;
}
