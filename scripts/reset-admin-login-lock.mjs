import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const stateFile = path.join(ROOT, "data", "admin-login-state.json");

try {
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
    console.log("Admin login lock reset.");
  } else {
    console.log("No admin login lock file found. Nothing to reset.");
  }
} catch (err) {
  console.error("Failed to reset admin login lock:", err.message);
  process.exit(1);
}
