import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeyStore } from "../../gateway/keys";
import { gatewayBaseUrl, isAlive, isHealthy, readPid, startGateway, stopGateway, tailFile } from "./proc";
import { parseArgs } from "../cli";
import { freePort, makeAppDir, makeCtx, startMockModel } from "./testkit";

const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("log tailing", () => {
  it("redacts API keys that somehow reach a log line", () => {
    const a = makeAppDir();
    cleanups.push(a.cleanup);
    const p = join(a.dir, "g.log");
    const key = "crwa_0123abcd_" + "Z".repeat(43);
    writeFileSync(p, `line1\nauth failed for ${key}\nline3\n`);
    const out = tailFile(p, 5);
    expect(out).toContain("line3");
    expect(out).not.toContain("Z".repeat(43));
    expect(tailFile(join(a.dir, "missing.log"), 5)).toBe("");
  });
});

describe("argument parsing", () => {
  it("parses flags with and without values", () => {
    expect(parseArgs(["setup", "--model", "gemma4:12b", "--yes", "--dry-run"])).toEqual({ cmd: "setup", pos: [], flags: { model: "gemma4:12b", yes: true, "dry-run": true } });
    expect(parseArgs(["remote", "verify", "https://x", "--burst"]).pos).toEqual(["verify", "https://x"]);
    expect(() => parseArgs(["setup", "--model"])).toThrow(/needs a value/);
  });
});

/** Real background process: spawns the actual launcher via tsx against a mock model. */
describe("start / stop (real process)", () => {
  async function appWithGateway() {
    const a = makeAppDir();
    const m = await startMockModel({ models: ["gemma4:test"] });
    const port = await freePort();
    // reuse the real launcher + gateway code; keep config/state in the temp app dir
    const real = process.cwd();
    for (const link of ["mac"]) symlinkSync(join(real, link), join(a.dir, link));
    require("node:fs").rmSync(join(a.dir, "node_modules"), { recursive: true, force: true });
    symlinkSync(join(real, "node_modules"), join(a.dir, "node_modules"));
    const ctx = makeCtx(a);
    mkdirSync(join(a.dir, "gateway"), { recursive: true });
    writeFileSync(ctx.paths.gatewayEnv, `GATEWAY_PORT=${port}\nUPSTREAM_BASE_URL=${m.url}\nUPSTREAM_MODEL=gemma4:test\nPUBLIC_MODEL_ID=gemma-4\n`);
    new KeyStore(ctx.paths.keysFile).create("c", ["inference"]);
    cleanups.push(async () => {
      await stopGateway(ctx.paths, { graceMs: 3000 });
      m.close();
      a.cleanup();
    });
    return { ctx, port };
  }

  it("starts in the background with logs outside the repo, is idempotent, and stops cleanly", async () => {
    const { ctx, port } = await appWithGateway();
    const r = await startGateway(ctx.paths);
    expect(r.ok).toBe(true);
    expect(await isHealthy(`http://127.0.0.1:${port}`)).toBe(true);
    const pid = readPid(ctx.paths.pidFile)!;
    expect(isAlive(pid)).toBe(true);
    expect(ctx.paths.gatewayLog.startsWith(join(ctx.paths.appDir, "gateway"))).toBe(false); // not in a source dir (real layout: ~/Library/Logs, see paths test)
    expect(readFileSync(ctx.paths.gatewayLog, "utf8")).toContain("listening");
    // the env file was loaded by the launcher (model id and port came from gateway/.env)
    const ready = await (await fetch(`http://127.0.0.1:${port}/readyz`)).json();
    expect(ready).toMatchObject({ status: "ready", model: "gemma-4" });
    // running twice does not start a second process
    const again = await startGateway(ctx.paths);
    expect(again).toMatchObject({ ok: true, alreadyRunning: true });
    expect(readPid(ctx.paths.pidFile)).toBe(pid);
    // stop
    const s = await stopGateway(ctx.paths, { graceMs: 5000 });
    expect(s.ok).toBe(true);
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(ctx.paths.pidFile)).toBe(false);
    expect(await isHealthy(`http://127.0.0.1:${port}`)).toBe(false);
  }, 60_000);

  it("fails with a log tail when the gateway cannot start (bad config)", async () => {
    const { ctx } = await appWithGateway();
    writeFileSync(ctx.paths.gatewayEnv, "GATEWAY_PORT=notanumber\nUPSTREAM_MODEL=x\n");
    const r = await startGateway(ctx.paths, { waitMs: 8000 });
    expect(r.ok).toBe(false);
    expect(r.logTail).toMatch(/GATEWAY_PORT/);
    expect(existsSync(ctx.paths.pidFile)).toBe(false);
  }, 30_000);

  it("refuses to start without gateway/.env and handles a stale pid file on stop", async () => {
    const a = makeAppDir();
    cleanups.push(a.cleanup);
    const ctx = makeCtx(a);
    expect((await startGateway(ctx.paths)).message).toMatch(/mac:setup/);
    mkdirSync(join(ctx.paths.stateDir), { recursive: true });
    writeFileSync(ctx.paths.pidFile, "999999");
    expect((await stopGateway(ctx.paths)).message).toMatch(/stale pid/);
    expect(existsSync(ctx.paths.pidFile)).toBe(false);
    expect(gatewayBaseUrl(ctx.paths, {})).toBe("http://127.0.0.1:8787");
  });
});
