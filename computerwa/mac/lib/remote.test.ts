import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../gateway/config";
import { KeyStore } from "../../gateway/keys";
import { createGateway } from "../../gateway/server";
import { remoteApply, remoteStatus, tailscaleState, verifyRemote } from "./remote";
import { fakeExec, freePort, makeAppDir, makeCtx, startMockModel } from "./testkit";
import type { Check } from "./report";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const status = (l: Check[], id: string) => l.find((c) => c.id === id)?.status;

const running = JSON.stringify({ BackendState: "Running", Self: { DNSName: "mini.tail1234.ts.net." } });
const tsExec = (backend = "Running") =>
  fakeExec((cmd, args) => {
    if (cmd === "tailscale" && args[0] === "status") return { code: 0, stdout: backend === "Running" ? running : JSON.stringify({ BackendState: backend }), stderr: "" };
    if (cmd === "tailscale") return { code: 0, stdout: "", stderr: "" };
    return undefined;
  });

async function gatewayApp(over: { host?: string; keys?: boolean } = {}) {
  const app = makeAppDir();
  const m = await startMockModel({ models: ["gemma4:test"] });
  const port = await freePort();
  cleanups.push(app.cleanup, m.close);
  const exec = tsExec();
  const ctx = makeCtx(app, { exec, env: {} });
  mkdirSync(join(app.dir, "gateway"), { recursive: true });
  writeFileSync(ctx.paths.gatewayEnv, `GATEWAY_HOST=${over.host ?? "127.0.0.1"}\nGATEWAY_PORT=${port}\nUPSTREAM_BASE_URL=${m.url}\nUPSTREAM_MODEL=gemma4:test\n`);
  if (over.keys !== false) new KeyStore(ctx.paths.keysFile).create("c", ["inference"]);
  const gw = createGateway(loadConfig({ UPSTREAM_BASE_URL: m.url, UPSTREAM_MODEL: "gemma4:test", GATEWAY_KEYS_FILE: ctx.paths.keysFile, GATEWAY_LEDGER_FILE: ctx.paths.ledgerFile, MAX_BODY_BYTES: "4096", RATE_LIMIT_PER_MINUTE: "5" }), () => {});
  await new Promise<void>((r) => gw.server.listen(port, "127.0.0.1", r));
  cleanups.push(() => {
    gw.server.closeAllConnections();
    gw.server.close();
  });
  return { app, ctx, exec, port, gw };
}
const serveCalls = (e: ReturnType<typeof tsExec>) => e.calls.filter((c) => c.cmd === "tailscale" && ["serve", "funnel"].includes(c.args[0]));

describe("tailscale detection", () => {
  it("parses a running node and a logged-out node", async () => {
    const app = makeAppDir();
    cleanups.push(app.cleanup);
    expect(await tailscaleState(makeCtx(app, { exec: tsExec() }))).toMatchObject({ installed: true, backend: "Running", dnsName: "mini.tail1234.ts.net" });
    expect(await tailscaleState(makeCtx(app, { exec: tsExec("NeedsLogin") }))).toMatchObject({ installed: true, backend: "NeedsLogin" });
    expect(await tailscaleState(makeCtx(app, { exec: fakeExec() }))).toEqual({ installed: false });
  });
  it("status marks missing/unauthenticated tunnels as NOT RUN (never as passed)", async () => {
    const app = makeAppDir();
    cleanups.push(app.cleanup);
    expect(status((await remoteStatus(makeCtx(app, { exec: fakeExec() }))).list, "remote.tailscale")).toBe("not_run");
    expect(status((await remoteStatus(makeCtx(app, { exec: tsExec("NeedsLogin") }))).list, "remote.tailscale")).toBe("not_run");
  });
});

describe("mac:remote apply", () => {
  it("is a dry run by default: prints the command, runs nothing", async () => {
    const { ctx, exec } = await gatewayApp();
    for (const mode of ["private", "public"] as const) {
      const r = await remoteApply(ctx, mode, {});
      expect(r.ok).toBe(true);
      expect(r.lines.join("\n")).toMatch(/Dry run/);
    }
    expect(serveCalls(exec)).toHaveLength(0);
  });

  it("public --apply runs tailscale funnel for the GATEWAY port only", async () => {
    const { ctx, exec, port } = await gatewayApp();
    const r = await remoteApply(ctx, "public", { apply: true });
    expect(r.ok).toBe(true);
    expect(serveCalls(exec).map((c) => c.args)).toEqual([["funnel", "--bg", String(port)]]);
    expect(r.lines.join("\n")).toContain("https://mini.tail1234.ts.net");
    for (const p of [11434, 1234, 8080]) expect(serveCalls(exec).some((c) => c.args.includes(String(p)))).toBe(false);
  });

  it("private --apply uses serve, off resets", async () => {
    const { ctx, exec, port } = await gatewayApp();
    await remoteApply(ctx, "private", { apply: true });
    await remoteApply(ctx, "off", { apply: true });
    expect(serveCalls(exec).map((c) => c.args)).toEqual([["serve", "--bg", String(port)], ["serve", "reset"]]);
  });

  it("refuses without Tailscale, without login, with a non-loopback bind, without keys, or without a running gateway", async () => {
    const a = await gatewayApp();
    expect((await remoteApply(makeCtx(a.app, { exec: fakeExec() }), "public", { apply: true })).ok).toBe(false);
    expect((await remoteApply(makeCtx(a.app, { exec: tsExec("NeedsLogin") }), "public", { apply: true })).ok).toBe(false);

    const lan = await gatewayApp({ host: "0.0.0.0" });
    const rLan = await remoteApply(lan.ctx, "public", { apply: true });
    expect(rLan.ok).toBe(false);
    expect(status(rLan.checks.list, "remote.host")).toBe("fail");
    expect(serveCalls(lan.exec)).toHaveLength(0);

    const nokeys = await gatewayApp({ keys: false });
    expect(status((await remoteApply(nokeys.ctx, "public", { apply: true })).checks.list, "remote.keys")).toBe("fail");
    expect(serveCalls(nokeys.exec)).toHaveLength(0);

    const down = makeAppDir();
    cleanups.push(down.cleanup);
    mkdirSync(join(down.dir, "gateway"), { recursive: true });
    const port = await freePort();
    const exec = tsExec();
    const dctx = makeCtx(down, { exec });
    writeFileSync(dctx.paths.gatewayEnv, `GATEWAY_PORT=${port}\nUPSTREAM_MODEL=gemma4:test\n`);
    new KeyStore(dctx.paths.keysFile).create("c", ["inference"]);
    const rDown = await remoteApply(dctx, "public", { apply: true });
    expect(status(rDown.checks.list, "remote.gateway")).toBe("not_run");
    expect(serveCalls(exec)).toHaveLength(0);
  });

  it("reports command failure honestly (Funnel not enabled)", async () => {
    const { ctx } = await gatewayApp();
    ctx.exec = fakeExec((cmd, args) => (cmd === "tailscale" && args[0] === "status" ? { code: 0, stdout: running, stderr: "" } : cmd === "tailscale" ? { code: 1, stdout: "", stderr: "Funnel not enabled for this node" } : undefined));
    const r = await remoteApply(ctx, "public", { apply: true });
    expect(r.ok).toBe(false);
    expect(status(r.checks.list, "remote.apply")).toBe("fail");
    expect(r.checks.list.find((c) => c.id === "remote.apply")?.detail).toContain("Funnel not enabled");
  });
});

describe("mac:remote verify", () => {
  it("passes a correctly protected gateway (real gateway on loopback)", async () => {
    const { ctx, port } = await gatewayApp();
    const smoke = new KeyStore(ctx.paths.keysFile).create("s", ["inference"], 100).key;
    const checks = await verifyRemote(ctx, `http://127.0.0.1:${port}`, { smokeKey: smoke });
    const l = checks.list;
    expect(status(l, "rv.health")).toBe("pass");
    expect(status(l, "rv.auth-none")).toBe("pass");
    expect(status(l, "rv.auth-bad")).toBe("pass");
    expect(status(l, "rv.usage-private")).toBe("pass");
    expect(status(l, "rv.size")).toBe("pass");
    expect(status(l, "rv.https")).toBe("warn"); // plain http on loopback is not shareable
    expect(status(l, "rv.rate")).toBe("not_run");
  });

  it("burst test observes the rate limit without invoking the model", async () => {
    const { ctx, port } = await gatewayApp();
    const key = new KeyStore(ctx.paths.keysFile).create("b", ["inference"], 5).key;
    const checks = await verifyRemote(ctx, `http://127.0.0.1:${port}`, { smokeKey: key, burst: true });
    const rate = checks.list.find((c) => c.id === "rv.rate")!;
    expect(rate.status).toBe("pass");
    expect(rate.title).toMatch(/429 on burst request #5/);
  });

  it("FAILS an unprotected endpoint and plain HTTP to a remote host", async () => {
    const open = (async (url: string, init?: RequestInit) => {
      if (String(url).includes(":11434")) return new Response("{}", { status: 200 });
      return new Response("{}", { status: init?.method === "POST" || String(url).includes("usage") ? 200 : 200 });
    }) as unknown as typeof fetch;
    const app = makeAppDir();
    cleanups.push(app.cleanup);
    const checks = await verifyRemote(makeCtx(app, { fetchImpl: open }), "http://mini.example.com");
    const l = checks.list;
    expect(status(l, "rv.https")).toBe("fail");
    expect(status(l, "rv.auth-none")).toBe("fail");
    expect(status(l, "rv.auth-bad")).toBe("fail");
    expect(status(l, "rv.usage-private")).toBe("fail");
    expect(status(l, "rv.raw-port")).toBe("fail");
  });

  it("fails cleanly on unreachable or invalid URLs", async () => {
    const app = makeAppDir();
    cleanups.push(app.cleanup);
    expect(status((await verifyRemote(makeCtx(app), "nonsense")).list, "rv.url")).toBe("fail");
    const refused = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(status((await verifyRemote(makeCtx(app, { fetchImpl: refused }), "https://x.example.com")).list, "rv.reach")).toBe("fail");
  });
});
