import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec";
import { Checks } from "./report";

export const MIN_NODE_MAJOR = 20;

export function parseNodeMajor(version: string): number {
  const m = /^v?(\d+)\./.exec(version);
  return m ? Number(m[1]) : 0;
}

export interface SystemInfo {
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
}

export function systemInfo(): SystemInfo {
  return { platform: process.platform, arch: process.arch, nodeVersion: process.version };
}

/** `pmset -g` reports the system sleep timer in minutes; 0 = never. */
export function parseSleepMinutes(pmsetOutput: string): number | null {
  const m = /^\s*sleep\s+(\d+)/m.exec(pmsetOutput);
  return m ? Number(m[1]) : null;
}

export async function systemChecks(checks: Checks, opts: { info: SystemInfo; exec: Exec; appDir: string }) {
  const { info, exec, appDir } = opts;
  const G = "System";
  if (info.platform === "darwin") {
    checks.pass("sys.macos", G, `macOS detected (${info.arch === "arm64" ? "Apple silicon" : info.arch})`, "local-real");
    if (info.arch !== "arm64") checks.warn("sys.arch", G, "Not Apple silicon", "local-real", `CPU architecture is ${info.arch}; local LLM speed will be much lower.`);
  } else {
    checks.notRun("sys.macos", G, `macOS check (this machine is ${info.platform}/${info.arch})`, "physical-mac", "Not running on macOS, so macOS-specific checks (launchd, sleep settings) cannot run here.", "Run `npm run mac:doctor` on the Mac mini.");
  }

  const major = parseNodeMajor(info.nodeVersion);
  if (major >= MIN_NODE_MAJOR) checks.pass("sys.node", G, `Node.js ${info.nodeVersion} (need ≥ ${MIN_NODE_MAJOR})`, "local-real");
  else checks.fail("sys.node", G, `Node.js ${info.nodeVersion} is too old`, "local-real", `Need Node ${MIN_NODE_MAJOR} or newer.`, "Install a current Node LTS: `brew install node` or https://nodejs.org");

  const npm = await exec("npm", ["--version"], { timeoutMs: 10_000 });
  if (npm.code === 0) checks.pass("sys.npm", G, `npm ${npm.stdout.trim()}`, "local-real");
  else checks.fail("sys.npm", G, "npm not found", "local-real", "npm is required to install dependencies.", "Install Node.js (it includes npm).");

  const haveTsx = existsSync(join(appDir, "node_modules", ".bin", "tsx"));
  const haveNext = existsSync(join(appDir, "node_modules", "next"));
  if (haveTsx && haveNext) checks.pass("sys.deps", G, "Dependencies installed", "local-real");
  else checks.fail("sys.deps", G, "Dependencies are not installed", "local-real", "node_modules is missing or incomplete.", "Run `npm ci` in computerwa/ (or `node mac/bootstrap.mjs`).");

  if (info.platform === "darwin") {
    const pm = await exec("pmset", ["-g"], { timeoutMs: 5000 });
    const sleep = pm.code === 0 ? parseSleepMinutes(pm.stdout) : null;
    if (sleep === 0) checks.pass("sys.sleep", G, "System sleep is disabled", "local-real");
    else if (sleep === null) checks.warn("sys.sleep", G, "Could not read sleep settings", "local-real", "`pmset -g` gave no sleep value.", "Check System Settings → Energy (or Battery) → prevent automatic sleeping.");
    else checks.warn("sys.sleep", G, `Mac sleeps after ${sleep} min idle`, "local-real", "A sleeping Mac mini drops the gateway and the tunnel; the dashboard will show Offline.", "System Settings → Energy → \"Prevent automatic sleeping when the display is off\", or run the gateway under `caffeinate -is`.");
  }
}

/** Reads the example env file shipped in the repo (the template for gateway/.env). */
export function readExampleEnv(appDir: string): string {
  return readFileSync(join(appDir, "gateway", ".env.example"), "utf8");
}
