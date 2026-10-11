#!/usr/bin/env node
// One-command entry for a fresh checkout: `node mac/bootstrap.mjs` (from computerwa/).
// Needs only Node. Installs project dependencies locally (npm ci) if missing, then runs `mac:setup`.
// It does not install system software, download models, expose ports or touch Vercel.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`Node ${process.versions.node} is too old; need Node 20+. Install a current LTS (brew install node, or https://nodejs.org).`);
  process.exit(1);
}
if (!existsSync(join(appDir, "package.json")) || JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).name !== "computerwa") {
  console.error("Run this from a ComputeRWA checkout (computerwa/ directory not found).");
  process.exit(1);
}
const run = (cmd, args) => spawnSync(cmd, args, { cwd: appDir, stdio: "inherit" }).status ?? 1;
if (!existsSync(join(appDir, "node_modules", ".bin", "tsx"))) {
  console.log("Installing project dependencies into computerwa/node_modules (npm ci) …");
  const code = run("npm", ["ci"]);
  if (code !== 0) {
    console.error("npm ci failed. Fix the error above (network? Node/npm version?) and re-run.");
    process.exit(code);
  }
}
process.exit(run("npm", ["run", "mac:setup", "--", ...process.argv.slice(2)]));
