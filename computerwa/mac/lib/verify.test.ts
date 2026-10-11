import { appendFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getInferenceStatus } from "../../src/lib/inference/gatewayClient";
import { readEnvFile } from "./dotenv";
import { runVerify } from "./verify";
import { configuredApp } from "./testkit";
import type { Check } from "./report";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const st = (r: { checks: Check[] }, id: string) => r.checks.find((c) => c.id === id)?.status;

/** Emulates the app's /api/inference route using the app's real client code. */
async function fakeDashboard(gatewayUrl: string, readKey: string, mutate?: (body: unknown) => unknown): Promise<string> {
  const server: Server = createServer(async (req, res) => {
    const status = await getInferenceStatus({ baseUrl: gatewayUrl, readKey, days: 1 });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(mutate ? mutate(status) : status));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("mac:verify", () => {
  it("performs a real request and verifies usage, privacy, revenue, ledger and the dashboard route", async () => {
    const a = await configuredApp();
    cleanups.push(a.close);
    const readKey = readEnvFile(a.ctx.paths.envLocal).INFERENCE_GATEWAY_READ_KEY;
    const appUrl = await fakeDashboard(`http://127.0.0.1:${a.port}`, readKey);
    const rep = await runVerify(a.ctx, { appUrl });
    expect(rep.checks.filter((c) => c.status === "fail")).toEqual([]);
    for (const id of ["v.gateway", "v.ready", "v.infer", "v.usage", "v.tokens", "v.latency", "v.privacy", "v.ledger", "v.schema", "v.recompute", "v.revenue", "v.dashboard"]) expect(st(rep, id), id).toBe("pass");
    expect(a.m.chatCalls).toBe(1); // exactly one inference request
    expect(JSON.stringify(rep)).not.toMatch(/crwa_[0-9a-f]{8}_/);
    // things it cannot prove stay NOT RUN
    expect(st(rep, "v.devnet")).toBe("not_run");
    expect(st(rep, "v.tests")).toBe("not_run");
  }, 30_000);

  it("fails with the next command when the gateway is not running", async () => {
    const a = await configuredApp({ startGateway: false });
    cleanups.push(a.close);
    const rep = await runVerify(a.ctx);
    expect(rep.checks.find((c) => c.id === "v.gateway")).toMatchObject({ status: "fail", fix: expect.stringContaining("npm run mac:start") });
    expect(a.m.chatCalls).toBe(0);
  });

  it("fails when the model returns an empty response", async () => {
    const a = await configuredApp({ modelContent: "  " });
    cleanups.push(a.close);
    expect(st(await runVerify(a.ctx), "v.infer")).toBe("fail");
  });

  it("warns (not fails) when the runtime reports no token counts, and never invents them", async () => {
    const a = await configuredApp({ usage: false });
    cleanups.push(a.close);
    const rep = await runVerify(a.ctx);
    expect(st(rep, "v.tokens")).toBe("warn");
    expect(st(rep, "v.infer")).toBe("pass");
  });

  it("marks the dashboard check NOT RUN when no app is running", async () => {
    const a = await configuredApp();
    cleanups.push(a.close);
    const rep = await runVerify(a.ctx, { appUrl: "http://127.0.0.1:9" });
    expect(rep.checks.find((c) => c.id === "v.dashboard")).toMatchObject({ status: "not_run", requires: "app-running" });
  });

  it("fails if the dashboard response leaks the gateway address or key", async () => {
    const a = await configuredApp();
    cleanups.push(a.close);
    const readKey = readEnvFile(a.ctx.paths.envLocal).INFERENCE_GATEWAY_READ_KEY;
    const appUrl = await fakeDashboard(`http://127.0.0.1:${a.port}`, readKey, (b) => ({ ...(b as object), debug: `via http://127.0.0.1:${a.port}` }));
    expect(st(await runVerify(a.ctx, { appUrl }), "v.dashboard")).toBe("fail");
  });

  it("fails if the dashboard cannot reach the gateway", async () => {
    const a = await configuredApp();
    cleanups.push(a.close);
    const appUrl = await fakeDashboard("http://127.0.0.1:9", "crwa_0123abcd_" + "A".repeat(43));
    expect(st(await runVerify(a.ctx, { appUrl }), "v.dashboard")).toBe("fail");
  });

  it("FAILS if prompt text ends up in the ledger (simulated faulty gateway)", async () => {
    const a = await configuredApp();
    cleanups.push(a.close);
    const realFetch = fetch;
    a.ctx.fetchImpl = (async (url: string, init?: RequestInit) => {
      const res = await realFetch(url, init);
      if (String(url).endsWith("/v1/chat/completions") && init?.body) appendFileSync(a.ctx.paths.ledgerFile, JSON.stringify({ leaked: String(init.body) }) + "\n");
      return res;
    }) as typeof fetch;
    const rep = await runVerify(a.ctx);
    expect(st(rep, "v.privacy")).toBe("fail");
    expect(st(rep, "v.schema")).toBe("fail");
  });

  it("requires setup first", async () => {
    const a = await configuredApp({ startGateway: false });
    cleanups.push(a.close);
    require("node:fs").rmSync(a.ctx.paths.localSecrets);
    expect(st(await runVerify(a.ctx), "v.keys")).toBe("fail");
  });
});
