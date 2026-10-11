import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../gateway/config";
import { createGateway, type Gateway } from "../../gateway/server";
import { ledgerSchemaProblems, runDoctor } from "./doctor";
import { runSelfTest } from "./selftest";
import { Checks } from "./report";
import { runSetup } from "./setup";
import { freePort, makeAppDir, makeCtx, startMockModel, type MockModel } from "./testkit";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

/** A configured app dir (via the real setup) with a real in-process gateway on the configured port. */
async function configured(opts: { startGateway: boolean }) {
  const app = makeAppDir();
  const m: MockModel = await startMockModel({ models: ["gemma4:test"] });
  cleanups.push(app.cleanup, m.close);
  const port = await freePort();
  const ctx = makeCtx(app, { env: { GATEWAY_PORT: String(port) } });
  mkdirSync(join(app.dir, "gateway"), { recursive: true });
  writeFileSync(ctx.paths.gatewayEnv, `GATEWAY_PORT=${port}\n`);
  const res = await runSetup(ctx, { upstreamUrl: m.url, fillMissing: true });
  expect(res.ok).toBe(true);
  let gw: Gateway | null = null;
  if (opts.startGateway) {
    gw = createGateway(loadConfig({ UPSTREAM_BASE_URL: m.url, UPSTREAM_MODEL: "gemma4:test", PUBLIC_MODEL_ID: "gemma-4", GATEWAY_KEYS_FILE: ctx.paths.keysFile, GATEWAY_LEDGER_FILE: ctx.paths.ledgerFile }), () => {});
    await new Promise<void>((r) => gw!.server.listen(port, "127.0.0.1", r));
    cleanups.push(() => {
      gw!.server.closeAllConnections();
      gw!.server.close();
    });
  }
  return { app, ctx, m, port };
}
const byId = (r: { checks: { id: string }[] }, id: string) => r.checks.find((c) => c.id === id) as import("./report").Check | undefined;

describe("mac:doctor", () => {
  it("separates real local checks from mock and from checks it cannot run, and never leaks secrets", async () => {
    const { ctx } = await configured({ startGateway: true });
    const rep = await runDoctor(ctx);
    // no failures on a healthy, configured setup (warnings for placeholders/non-mac are expected)
    expect(rep.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(byId(rep, "gw.live")?.status).toBe("pass");
    expect(byId(rep, "gw.auth-none")?.status).toBe("pass");
    expect(byId(rep, "gw.scope")?.status).toBe("pass");
    expect(byId(rep, "gw.revenue0")?.status).toBe("pass");
    expect(byId(rep, "rt.gemma4")?.status).toBe("pass");
    expect(byId(rep, "cfg.cost")?.status).toBe("warn"); // placeholders flagged
    expect(byId(rep, "app.devnet")?.status).toBe("pass");
    expect(byId(rep, "app.mainnet-guard")?.status).toBe("pass");
    // evidence tagging
    expect(byId(rep, "gw.inference")?.environment).toBe("mock");
    expect(byId(rep, "gw.live")?.environment).toBe("local-real");
    for (const id of ["ext.tunnel", "ext.vercel", "ext.devnet", "ext.mac", "sys.macos"]) expect(byId(rep, id)).toMatchObject({ status: "not_run", environment: "not-run" });
    expect(byId(rep, "ext.tunnel")?.requires).toBe("tunnel-auth");
    expect(byId(rep, "ext.vercel")?.requires).toBe("vercel");
    expect(byId(rep, "ext.devnet")?.requires).toBe("devnet-wallet");
    expect(rep.summary.ranMock).toBeGreaterThanOrEqual(10);
    // no secrets anywhere in the machine-readable report
    const json = JSON.stringify(rep);
    expect(json).not.toMatch(/crwa_[0-9a-f]{8}_/);
  }, 30_000);

  it("reports a stopped gateway as NOT RUN with the exact next command", async () => {
    const { ctx } = await configured({ startGateway: false });
    const rep = await runDoctor(ctx, { skipSelfTest: true });
    expect(byId(rep, "gw.live")).toMatchObject({ status: "not_run", requires: "gateway-running", fix: "npm run mac:start" });
  });

  it("fails clearly when nothing is configured", async () => {
    const app = makeAppDir();
    cleanups.push(app.cleanup);
    const rep = await runDoctor(makeCtx(app), { skipSelfTest: true });
    expect(byId(rep, "cfg.env")).toMatchObject({ status: "fail", fix: "npm run mac:setup" });
    expect(byId(rep, "keys.file")?.status).toBe("fail");
  });

  it("fails when the configured model disappeared from the runtime", async () => {
    const { ctx, m } = await configured({ startGateway: false });
    m.close();
    const m2 = await startMockModel({ models: ["other"] });
    cleanups.push(m2.close);
    const env = require("node:fs").readFileSync(ctx.paths.gatewayEnv, "utf8").replace(m.url, m2.url);
    writeFileSync(ctx.paths.gatewayEnv, env);
    const rep = await runDoctor(ctx, { skipSelfTest: true });
    expect(byId(rep, "rt.model")).toMatchObject({ status: "fail" });
  });

  it("flags a mainnet RPC in the app configuration", async () => {
    const app = makeAppDir();
    cleanups.push(app.cleanup);
    const rep = await runDoctor(makeCtx(app, { env: { NEXT_PUBLIC_SOLANA_RPC: "https://api.mainnet-beta.solana.com" } }), { skipSelfTest: true });
    expect(byId(rep, "app.devnet")).toMatchObject({ status: "fail" });
  });
});

describe("ledger schema check", () => {
  it("detects stored prompt/response fields", () => {
    const app = makeAppDir();
    cleanups.push(app.cleanup);
    const p = join(app.dir, "usage.jsonl");
    const ok = { v: 1, requestId: "r", ts: "t", keyId: "k", model: "m", status: 200, outcome: "success", measured: { latencyMs: 1, upstreamMs: 1, inputTokens: 1, outputTokens: 1, tokenSource: "runtime_usage_field" }, estimated: { costUsd: 0, energyKwh: 0, assumptionsId: "x" } };
    writeFileSync(p, JSON.stringify(ok) + "\n");
    expect(ledgerSchemaProblems(p).problems).toEqual([]);
    appendFileSync(p, JSON.stringify({ ...ok, prompt: "secret text", measured: { ...ok.measured, completion: "x" } }) + "\n");
    expect(ledgerSchemaProblems(p).problems[0]).toMatch(/prompt.*measured\.completion/);
  });
});

describe("self-test", () => {
  it("passes every mock-model behaviour check and tags them all as mock", async () => {
    const c = new Checks();
    await runSelfTest(c);
    expect(c.list.length).toBeGreaterThanOrEqual(10);
    expect(c.list.filter((x) => x.status !== "pass")).toEqual([]);
    expect(c.list.every((x) => x.environment === "mock")).toBe(true);
  }, 30_000);
});
