/**
 * launchd user agent for the gateway. User-level only (no root, no
 * LaunchDaemons). Nothing is installed or loaded unless the user runs
 * `npm run mac:service -- install`.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Exec } from "./exec";
import { type Paths, SERVICE_LABEL } from "./paths";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Contains no secrets: configuration is read from gateway/.env by run-gateway.ts.
 * KeepAlive/SuccessfulExit=false restarts after crashes but not after a clean exit
 * (e.g. SIGTERM from `mac:service stop`); ThrottleInterval stops crash loops.
 */
export function buildPlist(p: { paths: Paths; nodeBin: string }): string {
  const tsxCli = join(p.paths.appDir, "node_modules", "tsx", "dist", "cli.mjs");
  const launcher = join(p.paths.appDir, "mac", "run-gateway.ts");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(p.nodeBin)}</string>
    <string>${xml(tsxCli)}</string>
    <string>${xml(launcher)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(p.paths.appDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COMPUTERWA_APP_DIR</key><string>${xml(p.paths.appDir)}</string>
    <key>PATH</key><string>${xml(dirname(p.nodeBin))}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(p.paths.gatewayLog)}</string>
  <key>StandardErrorPath</key><string>${xml(p.paths.gatewayLog)}</string>
</dict>
</plist>
`;
}

export type ServiceAction = "install" | "start" | "stop" | "status" | "remove" | "print";

export interface ServiceResult {
  ok: boolean;
  message: string;
  detail?: string;
}

export async function runService(action: ServiceAction, p: { paths: Paths; exec: Exec; platform: NodeJS.Platform; uid: number; nodeBin: string }): Promise<ServiceResult> {
  const { paths, exec, uid } = p;
  const domain = `gui/${uid}`;
  const target = `${domain}/${SERVICE_LABEL}`;

  if (action === "print") return { ok: true, message: `Would write ${paths.launchAgentPlist}:`, detail: buildPlist({ paths, nodeBin: p.nodeBin }) };
  if (p.platform !== "darwin") return { ok: false, message: `launchd is macOS-only (this machine is ${p.platform}). Nothing was changed. Use \`npm run mac:service -- print\` to preview the plist.` };
  if (uid === 0) return { ok: false, message: "Refusing to install a launchd agent as root. Run as your normal user." };

  switch (action) {
    case "install": {
      if (!existsSync(paths.gatewayEnv)) return { ok: false, message: "gateway/.env not found. Run `npm run mac:setup` before installing the service." };
      mkdirSync(dirname(paths.launchAgentPlist), { recursive: true });
      mkdirSync(paths.logDir, { recursive: true });
      const next = buildPlist({ paths, nodeBin: p.nodeBin });
      const changed = !existsSync(paths.launchAgentPlist) || readFileSync(paths.launchAgentPlist, "utf8") !== next;
      if (changed) writeFileSync(paths.launchAgentPlist, next, { mode: 0o644 });
      await exec("launchctl", ["bootout", target], { timeoutMs: 10_000 }); // ignore "not loaded"
      const r = await exec("launchctl", ["bootstrap", domain, paths.launchAgentPlist], { timeoutMs: 15_000 });
      if (r.code !== 0) return { ok: false, message: "launchctl bootstrap failed.", detail: (r.stderr || r.stdout).trim() };
      return { ok: true, message: `Service ${SERVICE_LABEL} installed and started. It starts at every login and restarts after crashes.` };
    }
    case "start": {
      if (!existsSync(paths.launchAgentPlist)) return { ok: false, message: "Service is not installed. Run `npm run mac:service -- install`." };
      const r = await exec("launchctl", ["bootstrap", domain, paths.launchAgentPlist], { timeoutMs: 15_000 });
      return r.code === 0 ? { ok: true, message: "Service started." } : { ok: false, message: "launchctl bootstrap failed (already running?).", detail: (r.stderr || r.stdout).trim() };
    }
    case "stop": {
      const r = await exec("launchctl", ["bootout", target], { timeoutMs: 15_000 });
      return r.code === 0 ? { ok: true, message: "Service stopped for this session. It will start again at next login (use `remove` to prevent that)." } : { ok: false, message: "Service was not running (or bootout failed).", detail: (r.stderr || r.stdout).trim() };
    }
    case "status": {
      const installed = existsSync(paths.launchAgentPlist);
      const r = await exec("launchctl", ["print", target], { timeoutMs: 10_000 });
      const loaded = r.code === 0;
      const state = /state = (\w+)/.exec(r.stdout)?.[1];
      const pid = /pid = (\d+)/.exec(r.stdout)?.[1];
      return { ok: true, message: `plist installed: ${installed ? "yes" : "no"} · loaded: ${loaded ? "yes" : "no"}${state ? ` · state: ${state}` : ""}${pid ? ` · pid ${pid}` : ""}`, detail: installed ? paths.launchAgentPlist : undefined };
    }
    case "remove": {
      await exec("launchctl", ["bootout", target], { timeoutMs: 15_000 });
      rmSync(paths.launchAgentPlist, { force: true });
      return { ok: true, message: `Service removed (plist deleted). Gateway config, keys and ledger were not touched.` };
    }
  }
}
