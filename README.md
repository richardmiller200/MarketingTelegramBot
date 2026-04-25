# Marketing Telegram Bot

A multi-bot Telegram management system with a built-in admin panel. Run multiple bots from a single process, broadcast messages, schedule daily content, and manage everything from a web UI.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create your .env file (see Environment Variables below)
cp .env.example .env

# 3. Start
npm start
```

Then open **http://127.0.0.1:3000/login** to access the admin panel.

---

## Environment Variables

Create a `.env` file in the project root:

```env
# PostgreSQL (use either DATABASE_URL or individual fields)
DATABASE_URL=postgresql://user:password@localhost:5432/dbname

# Or individual fields:
# PGHOST=127.0.0.1
# PGPORT=5432
# PGUSER=postgres
# PGPASSWORD=yourpassword
# PGDATABASE=postgres

# Admin Panel
PANEL_PORT=3000
PANEL_HOST=127.0.0.1
PANEL_USERNAME=admin
PANEL_PASSWORD=yourpassword

# Optional: seed a single bot from env instead of the panel
BOT_TOKEN=123456789:AAH...
ADMIN_TELEGRAM_IDS=123456789,987654321

# Optional: seed multiple bots from env (JSON array)
# BOTS_JSON=[{"name":"bot1","bot_token":"...","admin_ids":"123"}]

# Optional: path to bots Excel file (default: bots.xlsx)
# BOTS_EXCEL_PATH=bots.xlsx
```

---

## Project Structure

```
MarketingTelegramBot/
│
├── index.js                        # Entry point — starts bots + admin panel
├── package.json
│
├── src/
│   ├── config/
│   │   ├── constants.js            # All constants and env variable parsing
│   │   └── botLoader.js            # Loads bot configs from Excel / env vars
│   │
│   ├── db/
│   │   └── database.js             # PostgreSQL connection, table setup,
│   │                               # bot config CRUD, resolveConfigs()
│   │
│   ├── bot/
│   │   ├── userStore.js            # Per-bot user list (JSON file, write-safe queue)
│   │   ├── schedulerStore.js       # Daily message schedule state + tick logic
│   │   ├── handlers.js             # All Telegram command handlers:
│   │   │                           #   /start, /broadcast, /setgroup,
│   │   │                           #   /addmsg, /listmsgs, /delmsg
│   │   └── runner.js               # startBot(), getStatusRows(), member count helpers
│   │
│   ├── templates/
│   │   └── messageTemplates.js     # Message Library: DB queries, parsing,
│   │                               # sanitization, HTML preview rendering
│   │
│   ├── panel/
│   │   ├── auth.js                 # Admin login state (failed attempts, lockout)
│   │   ├── broadcastLog.js         # Read/write broadcast history log
│   │   ├── broadcast.js            # Panel broadcast logic (single bot + multi-bot)
│   │   ├── renderer.js             # All HTML page rendering (login, panel, views)
│   │   └── server.js               # HTTP server — all routes and request handling
│   │
│   └── utils/
│       ├── parsers.js              # Pure parsing helpers (no I/O, safe to import anywhere):
│       │                           #   parseAdminIds, parseButtonsPerRow,
│       │                           #   parseWelcomeButtons, slugify, etc.
│       └── helpers.js              # General helpers:
│                                   #   sleep, escapeHtml, parseCookies,
│                                   #   buildUrlButtonReplyMarkup, isBlockedByUserError, etc.
│
├── templates/                      # HTML templates for the admin panel
│   ├── login.html
│   ├── panel.html
│   └── assets/
│       ├── login.css
│       └── panel.css
│
├── data/                           # Runtime data (auto-created, do not edit manually)
│   ├── admin-login-state.json      # Login lock state
│   ├── broadcast-log.json          # Broadcast history
│   └── <bot-slug>/
│       ├── users.json              # Subscribers for that bot
│       └── schedule.json           # Daily message library + scheduler state
│
└── scripts/
    ├── make-template.mjs           # npm run template — generates bots.example.xlsx
    └── reset-admin-login-lock.mjs  # npm run reset-admin-lock — unlocks admin panel
```

---

## npm Scripts

| Command | Description |
|---|---|
| `npm start` | Start all bots and the admin panel |
| `npm run template` | Generate `bots.example.xlsx` template file |
| `npm run reset-admin-lock` | Unlock the admin panel after too many failed logins |

---

## How Bots Are Loaded

On startup, the app tries sources in this order:

1. **PostgreSQL** — if bots exist in the DB, they are used (this is the normal running state)
2. **Auto-seed from env** — if DB is empty and `BOT_TOKEN` or `BOTS_JSON` is set in `.env`, those bots are inserted into the DB once
3. **Auto-seed from Excel** — if DB is empty and `bots.xlsx` exists, bots are read from it and inserted into the DB once

After the first seed, all management is done through the **Admin Panel**.

---

## Admin Panel

| View | URL | Description |
|---|---|---|
| Dashboard | `/panel` | Live stats — active bots, total users, error count |
| Bots | `/panel?view=bots` | List, add, edit, delete bots |
| Broadcast | `/panel?view=broadcast` | Send a message to all users of one or more bots |
| Message Library | `/panel?view=messages` | Save reusable messages (text + image + buttons) |
| Users | `/panel?view=users` | View interacted users per bot |
| Analytics | `/panel?view=analytics` | Aggregate member and error stats |
| Logs | `/panel?view=logs` | Live polling status per bot |

---

## Telegram Bot Commands

These commands are sent directly inside Telegram:

| Command | Who | Description |
|---|---|---|
| `/start` | Anyone | Sends the welcome message to the user |
| `/broadcast <text>` | Admins | Broadcasts a text message to all users |
| `/broadcast` (reply) | Admins | Broadcasts the replied-to message (photo, video, doc, etc.) |
| `/setgroup` | Admins | Sets the current group for daily scheduled messages |
| `/addmsg` (reply) | Admins | Adds the replied-to message to the daily schedule library |
| `/listmsgs` | Admins | Lists all messages in the schedule library |
| `/delmsg <id>` | Admins | Removes a message from the schedule library |

> **Admins** are Telegram user IDs set in the `admin_ids` field for each bot.

---

## Where to Make Changes

| What you want to change | File to edit |
|---|---|
| Add a new bot command | `src/bot/handlers.js` |
| Change welcome message logic | `src/bot/handlers.js` |
| Change broadcast behaviour | `src/bot/handlers.js` and/or `src/panel/broadcast.js` |
| Add a new admin panel page/route | `src/panel/server.js` + `src/panel/renderer.js` |
| Change DB schema or queries | `src/db/database.js` |
| Change how bots are loaded from Excel/env | `src/config/botLoader.js` |
| Add/change app-wide constants | `src/config/constants.js` |
| Add a utility function | `src/utils/parsers.js` (pure) or `src/utils/helpers.js` |
