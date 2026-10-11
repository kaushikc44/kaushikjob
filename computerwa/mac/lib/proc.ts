/** Background gateway process management (no root, no launchd). */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, watchFile, unwatchFile, writeFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { readEnvFile } from "./dotenv";
import type { Paths } from "./paths";
import { redact } from "./redact";

export function gatewayBaseUrl(paths: Paths, env: Record<string, string | undefined> = process.env): string {
  const file = readEnvFile(paths.gatewayEnv);
  const host = env.GATEWAY_HOST ?? file.GATEWAY_HOST ?? "127.0.0.1";
  const port = env.GATEWAY_PORT ?? file.GATEWAY_PORT ?? "8787";
  return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
}

export async function isHealthy(baseUrl: string, timeoutMs = 1500, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await f(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

export function readPid(pidFile: string): number | null {
  try {
    const n = Number(readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface StartResult {
  ok: boolean;
  alreadyRunning?: boolean;
  pid?: number;
  message: string;
  logTail?: string;
}

export async function startGateway(paths: Paths, opts: { waitMs?: number; nodeBin?: string } = {}): Promise<StartResult> {
  const base = gatewayBaseUrl(paths);
  if (await isHealthy(base)) return { ok: true, alreadyRunning: true, message: `A gateway is already answering at ${base}. Not starting another.` };
  const existing = readPid(paths.pidFile);
  if (existing && isAlive(existing)) return { ok: false, message: `Gateway process ${existing} is alive but not answering ${base}/healthz. Check \`npm run mac:logs\`; stop it with \`npm run mac:stop\`.` };
  if (!existsSync(paths.gatewayEnv)) return { ok: false, message: "gateway/.env not found. Run `npm run mac:setup` first." };
  const tsxCli = join(paths.appDir, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(tsxCli)) return { ok: false, message: "Dependencies missing (tsx not found). Run `npm ci`." };

  mkdirSync(paths.logDir, { recursive: true });
  mkdirSync(dirname(paths.pidFile), { recursive: true });
  const fd = openSync(paths.gatewayLog, "a", 0o600);
  const child = spawn(opts.nodeBin ?? process.execPath, [tsxCli, join(paths.appDir, "mac", "run-gateway.ts")], {
    cwd: paths.appDir,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, COMPUTERWA_APP_DIR: paths.appDir },
  });
  child.unref();
  closeSync(fd);
  if (!child.pid) return { ok: false, message: "Failed to spawn the gateway process." };
  writeFileSync(paths.pidFile, String(child.pid), { mode: 0o600 });

  const deadline = Date.now() + (opts.waitMs ?? 20_000);
  while (Date.now() < deadline) {
    if (await isHealthy(base)) return { ok: true, pid: child.pid, message: `Gateway started (pid ${child.pid}) at ${base}. Logs: ${paths.gatewayLog}` };
    if (!isAlive(child.pid)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  rmSync(paths.pidFile, { force: true });
  return { ok: false, message: "Gateway did not become healthy. It exited or timed out; last log lines below.", logTail: tailFile(paths.gatewayLog, 15) };
}

export async function stopGateway(paths: Paths, opts: { graceMs?: number } = {}): Promise<{ ok: boolean; message: string }> {
  const pid = readPid(paths.pidFile);
  if (!pid) return { ok: true, message: "No gateway pid file; nothing started by mac:start is running. (A launchd service is managed with `npm run mac:service -- stop`.)" };
  if (!isAlive(pid)) {
    rmSync(paths.pidFile, { force: true });
    return { ok: true, message: `Gateway process ${pid} was not running; removed stale pid file.` };
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + (opts.graceMs ?? 10_000);
  while (Date.now() < deadline && isAlive(pid)) await new Promise((r) => setTimeout(r, 150));
  if (isAlive(pid)) process.kill(pid, "SIGKILL");
  rmSync(paths.pidFile, { force: true });
  return { ok: true, message: `Gateway process ${pid} stopped.` };
}

/** Last `lines` lines of a log file, with secrets redacted. */
export function tailFile(path: string, lines: number): string {
  if (!existsSync(path)) return "";
  const size = statSync(path).size;
  const len = Math.min(size, 256 * 1024);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  return redact(buf.toString("utf8").split("\n").slice(-lines - 1).join("\n").trimEnd());
}

/** Follows a log file until interrupted. Output is redacted. */
export function followFile(path: string, write: (s: string) => void): () => void {
  let pos = existsSync(path) ? statSync(path).size : 0;
  const onChange = () => {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size < pos) pos = 0;
    if (size === pos) return;
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - pos);
      readSync(fd, buf, 0, buf.length, pos);
      pos = size;
      write(redact(buf.toString("utf8")));
    } finally {
      closeSync(fd);
    }
  };
  watchFile(path, { interval: 500 }, onChange);
  return () => unwatchFile(path, onChange);
}
