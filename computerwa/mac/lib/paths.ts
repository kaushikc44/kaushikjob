/** Locations used by the Mac tooling. Logs and state live outside the repository. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Paths {
  appDir: string;
  gatewayEnv: string;
  envLocal: string;
  keysFile: string;
  ledgerFile: string;
  localSecrets: string;
  reportsDir: string;
  stateDir: string;
  logDir: string;
  pidFile: string;
  gatewayLog: string;
  launchAgentPlist: string;
}

export const SERVICE_LABEL = "com.computerwa.gateway";

/** `home` and `platform` are injectable for tests. COMPUTERWA_HOME relocates state + logs. */
export function resolvePaths(opts: { appDir?: string; home?: string; platform?: NodeJS.Platform; env?: Record<string, string | undefined> } = {}): Paths {
  const env = opts.env ?? process.env;
  const appDir = resolve(opts.appDir ?? env.COMPUTERWA_APP_DIR ?? process.cwd());
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const override = env.COMPUTERWA_HOME;
  const stateDir = override ? join(override, "state") : platform === "darwin" ? join(home, "Library", "Application Support", "ComputeRWA") : join(home, ".computerwa", "state");
  const logDir = override ? join(override, "logs") : platform === "darwin" ? join(home, "Library", "Logs", "ComputeRWA") : join(home, ".computerwa", "logs");
  return {
    appDir,
    gatewayEnv: join(appDir, "gateway", ".env"),
    envLocal: join(appDir, ".env.local"),
    keysFile: join(appDir, "gateway-data", "keys.json"),
    ledgerFile: join(appDir, "gateway-data", "usage.jsonl"),
    localSecrets: join(appDir, "gateway-data", "local-secrets.json"),
    reportsDir: join(appDir, "gateway-data", "reports"),
    stateDir,
    logDir,
    pidFile: join(stateDir, "gateway.pid"),
    gatewayLog: join(logDir, "gateway.log"),
    launchAgentPlist: join(override ? join(override, "LaunchAgents") : join(home, "Library", "LaunchAgents"), `${SERVICE_LABEL}.plist`),
  };
}

/** Refuses to run from the wrong directory (the tooling writes files relative to the app). */
export function assertAppDir(appDir: string): void {
  const pkg = join(appDir, "package.json");
  let name: string | undefined;
  try {
    name = existsSync(pkg) ? JSON.parse(readFileSync(pkg, "utf8")).name : undefined;
  } catch {
    name = undefined;
  }
  if (name !== "computerwa") {
    throw new Error(`Run this from the computerwa/ directory (no computerwa package.json in ${appDir}).`);
  }
}
