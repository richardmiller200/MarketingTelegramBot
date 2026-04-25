import "dotenv/config";
import { resolveConfigs } from "./src/db/database.js";
import { startBot } from "./src/bot/runner.js";
import { startAdminPanel } from "./src/panel/server.js";
import { startBroadcastScheduler } from "./src/bot/broadcastScheduler.js";

const { configs, source, db } = await resolveConfigs();
console.log(`Config: ${configs.length} bot(s) from ${source}`);

const instances = [];
for (const cfg of configs) {
  instances.push(startBot(cfg));
}

console.log("All bots polling. Press Ctrl+C to stop.");
startAdminPanel(db, instances);
startBroadcastScheduler(db, instances);
