import fs from "fs";
import path from "path";

/**
 * Creates a per-bot user store backed by a JSON file.
 * All writes are serialized through a queue to prevent race conditions.
 */
export function createUserStore(usersFile) {
  let registerQueue = Promise.resolve();

  function normalizeStoredUsers(data) {
    if (Array.isArray(data?.users)) {
      return data.users
        .map((u) => ({
          chatId: Number(u.chatId),
          username: String(u.username ?? "").trim(),
          firstName: String(u.firstName ?? "").trim(),
          lastName: String(u.lastName ?? "").trim(),
          firstSeenAt: String(u.firstSeenAt ?? "").trim(),
          lastSeenAt: String(u.lastSeenAt ?? "").trim(),
        }))
        .filter((u) => !Number.isNaN(u.chatId));
    }
    const ids = Array.isArray(data?.chatIds) ? data.chatIds : [];
    return [...new Set(ids.map(Number).filter((n) => !Number.isNaN(n)))].map((chatId) => ({
      chatId,
      username: "",
      firstName: "",
      lastName: "",
      firstSeenAt: "",
      lastSeenAt: "",
    }));
  }

  function loadUsers() {
    try {
      const dir = path.dirname(usersFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(usersFile)) return [];
      const data = JSON.parse(fs.readFileSync(usersFile, "utf8"));
      return normalizeStoredUsers(data);
    } catch {
      return [];
    }
  }

  function loadChatIds() {
    return [
      ...new Set(
        loadUsers()
          .map((u) => Number(u.chatId))
          .filter((n) => !Number.isNaN(n))
      ),
    ];
  }

  function saveUsers(users) {
    const dir = path.dirname(usersFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const uniqueUsers = [];
    const seen = new Set();
    for (const u of users) {
      const chatId = Number(u.chatId);
      if (Number.isNaN(chatId) || seen.has(chatId)) continue;
      seen.add(chatId);
      uniqueUsers.push({
        chatId,
        username: String(u.username ?? "").trim(),
        firstName: String(u.firstName ?? "").trim(),
        lastName: String(u.lastName ?? "").trim(),
        firstSeenAt: String(u.firstSeenAt ?? "").trim(),
        lastSeenAt: String(u.lastSeenAt ?? "").trim(),
      });
    }

    fs.writeFileSync(
      usersFile,
      JSON.stringify({ chatIds: uniqueUsers.map((u) => u.chatId), users: uniqueUsers }, null, 2),
      "utf8"
    );
  }

  function registerUser(msg) {
    registerQueue = registerQueue.then(() => {
      const chatId = Number(msg?.chat?.id);
      if (Number.isNaN(chatId)) return;
      const now = new Date().toISOString();
      const users = loadUsers();
      const idx = users.findIndex((u) => u.chatId === chatId);
      const incoming = {
        chatId,
        username: String(msg?.from?.username ?? "").trim(),
        firstName: String(msg?.from?.first_name ?? "").trim(),
        lastName: String(msg?.from?.last_name ?? "").trim(),
        firstSeenAt: now,
        lastSeenAt: now,
      };
      if (idx >= 0) {
        users[idx] = {
          ...users[idx],
          ...incoming,
          firstSeenAt: users[idx].firstSeenAt || incoming.firstSeenAt,
          lastSeenAt: now,
        };
      } else {
        users.push(incoming);
      }
      saveUsers(users);
    });
  }

  function removeChatId(chatId) {
    registerQueue = registerQueue.then(() => {
      const target = Number(chatId);
      if (Number.isNaN(target)) return false;
      const users = loadUsers();
      const nextUsers = users.filter((u) => Number(u.chatId) !== target);
      if (nextUsers.length === users.length) return false;
      saveUsers(nextUsers);
      return true;
    });
    return registerQueue;
  }

  return { loadChatIds, registerUser, loadUsers, removeChatId };
}
