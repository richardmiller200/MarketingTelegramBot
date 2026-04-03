import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import XLSX from "xlsx";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "bots.example.xlsx");

const rows = [
  [
    "name",
    "bot_token",
    "admin_ids",
    "enabled",
    "welcome_message",
    "welcome_image",
  ],
  [
    "my_club_bot",
    "PASTE_TOKEN_FROM_BOTFATHER",
    "123456789",
    "yes",
    "Member updates, events, and notices. (Edit this line.)",
    "https://telegram.org/img/t_logo.png",
  ],
];

const placeholderRows = [
  ["Where do I set the welcome image?"],
  [
    "→ On the **Bots** sheet (first sheet). Row 1 = headers. Each row below = one Telegram bot.",
  ],
  [
    "→ The image is the **last column**: header **welcome_image** (to the right of welcome_message).",
  ],
  [
    "→ Put the URL or path in **that cell on the same row** as that bot’s name and token (not on this sheet).",
  ],
  [
    "→ If your Excel file is old and has no welcome_image column: insert a new column at the end, name it exactly: welcome_image",
  ],
  [""],
  ["Column order on Bots (left to right)"],
  [
    "name → bot_token → admin_ids → enabled → welcome_message → welcome_image",
  ],
  [""],
  ["Column", "Sample / placeholder — replace with your values"],
  [""],
  [
    "name",
    "Short id for this bot (letters, numbers, underscores). Used in logs and folder data/<name>-0/.",
  ],
  [
    "bot_token",
    "From @BotFather → New Bot → copy token. Looks like: 123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  ],
  [
    "admin_ids",
    "Your Telegram user id from @userinfobot. Multiple admins: 111111111,222222222",
  ],
  ["enabled", "yes = this row is active. no = skip this row."],
  [
    "welcome_message",
    "Optional extra lines under the default “Welcome, Name!” text. Leave empty if you only want the default.",
  ],
  [
    "welcome_image",
    "Optional. Examples: https://yoursite.com/banner.jpg | assets/welcome.png | or a Telegram file_id",
  ],
  [""],
  ["Blank cells", "Empty welcome_message / welcome_image is OK — text-only welcome."],
];

const helpRows = [
  ["Broadcast (same as before)"],
  [
    "• In Telegram, open each bot in private chat and send: /broadcast Your message here",
  ],
  [""],
  ["admin_ids column"],
  [
    "Comma-separated Telegram user IDs who may use /broadcast (get ID from @userinfobot).",
  ],
  [
    "If you leave admin_ids empty for a row, ADMIN_TELEGRAM_IDS from .env is used for that bot (when set).",
  ],
  [""],
  ["Users list"],
  [
    "Each bot stores subscribers under data/<name>/users.json — broadcast only reaches users who messaged that bot.",
  ],
  [""],
  ["welcome_image (optional)"],
  [
    "HTTPS URL to an image, OR a file path under this folder (e.g. assets/club.jpg), OR a Telegram file_id after you send a photo to the bot once.",
  ],
  [
    "Leave blank for text-only welcome. Caption is the same welcome text as before.",
  ],
  [""],
  ["See sheet", "Placeholders — sample text for every column."],
];

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.aoa_to_sheet(rows);
XLSX.utils.book_append_sheet(wb, ws, "Bots");
const wsPlaceholders = XLSX.utils.aoa_to_sheet(placeholderRows);
XLSX.utils.book_append_sheet(wb, wsPlaceholders, "Placeholders");
const wsHelp = XLSX.utils.aoa_to_sheet(helpRows);
XLSX.utils.book_append_sheet(wb, wsHelp, "Broadcast_help");
XLSX.writeFile(wb, out);
console.log("Wrote", out);
const dest = path.join(root, "bots.xlsx");
if (!fs.existsSync(dest)) {
  fs.copyFileSync(out, dest);
  console.log("Created bots.xlsx from template (edit tokens and admin_ids).");
} else {
  console.log("bots.xlsx already exists — not overwritten.");
}
