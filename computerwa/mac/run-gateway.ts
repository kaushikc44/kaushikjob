/**
 * Launcher used by `mac:start` and the launchd service. It loads gateway/.env
 * (values already present in the process environment win), then starts the
 * unchanged gateway. Secrets therefore never appear in the plist, the process
 * arguments or the logs.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "./lib/dotenv";

const appDir = process.env.COMPUTERWA_APP_DIR || process.cwd();
const envFile = join(appDir, "gateway", ".env");
if (existsSync(envFile)) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(envFile, "utf8")))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
process.chdir(appDir); // GATEWAY_KEYS_FILE / LEDGER default to relative gateway-data/
void import("../gateway/main");
