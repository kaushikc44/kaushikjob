/**
 * Gateway behaviour self-test against an in-process MOCK model server, using
 * temporary keys/ledger. It exercises the real gateway code on this machine's
 * Node, but says nothing about the real model. Every check is tagged "mock".
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../gateway/config";
import { createGateway, type Gateway } from "../../gateway/server";
import { allocateToHolders, computeDistribution } from "../../src/lib/finance";
import { liveActualInputs } from "../../src/lib/inference/accounting";
import { getInferenceStatus } from "../../src/lib/inference/gatewayClient";
import type { UsageSummary } from "../../src/lib/inference/types";
import { Checks } from "./report";

type Mode = "ok" | "slow" | "hang";

let MOCK_URL = "";

async function startMock() {
  let mode: Mode = "ok";
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/models") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "mock-model" }] }));
      const reply = () =>
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ id: "x", object: "chat.completion", model: "mock-model", choices: [{ index: 0, message: { role: "assistant", content: "MOCK-REPLY-CANARY" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }),
        );
      if (mode === "hang") return;
      if (mode === "slow") setTimeout(reply, 200);
      else reply();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    set: (m: Mode) => (mode = m),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

async function startGw(dir: string, env: Record<string, string>, logs: string[]) {
  const config = loadConfig({
    UPSTREAM_BASE_URL: MOCK_URL,
    UPSTREAM_MODEL: "mock-model",
    PUBLIC_MODEL_ID: "mock-model",
    GATEWAY_KEYS_FILE: join(dir, "keys.json"),
    GATEWAY_LEDGER_FILE: join(dir, "usage.jsonl"),
    UPSTREAM_TIMEOUT_MS: "800",
    READINESS_TIMEOUT_MS: "500",
    ...env,
  });
  const gw: Gateway = createGateway(config, (l) => logs.push(JSON.stringify(l)));
  await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(gw.server.address() as AddressInfo).port}`;
  return { gw, base, ledgerFile: config.ledgerFile, close: () => { gw.server.closeAllConnections(); gw.server.close(); } };
}

const chat = (base: string, key: string | null, body: unknown = { messages: [{ role: "user", content: "hello" }], max_tokens: 8 }) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

export async function runSelfTest(checks: Checks): Promise<void> {
  const G = "Gateway behaviour (mock model server)";
  const dir = mkdtempSync(join(tmpdir(), "crwa-selftest-"));
  const mock = await startMock();
  MOCK_URL = mock.url;
  const logs: string[] = [];
  const closers: (() => void)[] = [mock.close];
  const step = async (id: string, title: string, fn: () => Promise<string | void>, fix = "Report this: the gateway code misbehaves on this machine.") => {
    try {
      const detail = await fn();
      checks.pass(id, G, title, "mock", detail || undefined);
    } catch (e) {
      checks.fail(id, G, title, "mock", (e as Error).message, fix);
    }
  };
  const expectEq = (got: unknown, want: unknown, what: string) => {
    if (got !== want) throw new Error(`${what}: expected ${String(want)}, got ${String(got)}`);
  };

  try {
    const main = await startGw(dir, { RATE_LIMIT_PER_MINUTE: "3", MAX_BODY_BYTES: "1024", PER_KEY_CONCURRENCY: "1" }, logs);
    closers.push(main.close);
    const infKey = main.gw.keys.create("selftest-inference", ["inference"]).key;
    const readKey = main.gw.keys.create("selftest-read", ["usage:read"]).key;
    const CANARY = `PROMPT-CANARY-${Math.random().toString(36).slice(2)}`;

    await step("gw.auth", "Missing/invalid keys → 401, read-only key on inference → 403", async () => {
      expectEq((await chat(main.base, null)).status, 401, "no key");
      expectEq((await chat(main.base, "crwa_deadbeef_" + "x".repeat(43))).status, 401, "invalid key");
      expectEq((await chat(main.base, readKey)).status, 403, "insufficient scope");
    });

    await step("gw.inference", "Authenticated request returns a response and records measured usage", async () => {
      const r = await chat(main.base, infKey, { messages: [{ role: "user", content: CANARY }], max_tokens: 8 });
      expectEq(r.status, 200, "status");
      const s = (await (await fetch(`${main.base}/v1/usage/summary?days=1`, { headers: { authorization: `Bearer ${readKey}` } })).json()) as UsageSummary;
      expectEq(s.requests.success, 1, "success count");
      expectEq(s.tokens.outputTokens, 3, "measured output tokens");
    });

    await step("gw.privacy", "Ledger and logs contain no prompt or response text", async () => {
      const ledger = readFileSync(main.ledgerFile, "utf8");
      const all = ledger + logs.join("\n");
      if (all.includes(CANARY) || all.includes("MOCK-REPLY-CANARY")) throw new Error("prompt/response text found in ledger or logs");
    });

    await step("gw.zero-revenue", "Free inference records $0 customer revenue", async () => {
      const s = (await (await fetch(`${main.base}/v1/usage/summary?days=1`, { headers: { authorization: `Bearer ${readKey}` } })).json()) as UsageSummary;
      expectEq(s.revenue.recordedPaymentsUsd, 0, "recorded payments");
      const i = liveActualInputs(s);
      expectEq(i.revenue, 0, "simulator revenue");
      const d = computeDistribution({ revenue: i.revenue, operatingExpenses: i.operatingExpenses, reserve: i.reserve, holderSharePct: 70 });
      expectEq(d.distributableCashCents, 0, "distributable cash");
      expectEq(d.holderPoolCents, 0, "holder pool");
    });

    await step("gw.limits.size", "Oversized body → 413", async () => {
      expectEq((await chat(main.base, infKey, { messages: [{ role: "user", content: "x".repeat(2000) }] })).status, 413, "status");
    });

    await step("gw.limits.rate", "Per-key rate limit → 429 with Retry-After", async () => {
      // 1 success + 1 oversize consumed 2 of 3 tokens; one more passes, the next is limited.
      await chat(main.base, infKey);
      const limited = await chat(main.base, infKey);
      expectEq(limited.status, 429, "status");
      if (!(Number(limited.headers.get("retry-after")) > 0)) throw new Error("missing Retry-After");
    });

    await step("gw.limits.concurrency", "Concurrency limit rejects (does not queue) parallel requests", async () => {
      const dir2 = mkdtempSync(join(tmpdir(), "crwa-selftest-c-"));
      const g = await startGw(dir2, { PER_KEY_CONCURRENCY: "1", GLOBAL_CONCURRENCY: "1", RATE_LIMIT_PER_MINUTE: "100" }, []);
      closers.push(g.close);
      const k = g.gw.keys.create("c", ["inference"]).key;
      mock.set("slow");
      const [a, b] = await Promise.all([chat(g.base, k), chat(g.base, k)]);
      mock.set("ok");
      const codes = [a.status, b.status].sort().join(",");
      expectEq(codes, "200,429", "statuses");
      rmSync(dir2, { recursive: true, force: true });
    });

    await step("gw.timeout", "Model hang → 504 within the timeout", async () => {
      const dir3 = mkdtempSync(join(tmpdir(), "crwa-selftest-t-"));
      const g = await startGw(dir3, { UPSTREAM_TIMEOUT_MS: "300", RATE_LIMIT_PER_MINUTE: "100" }, []);
      closers.push(g.close);
      const k = g.gw.keys.create("t", ["inference"]).key;
      mock.set("hang");
      const t0 = Date.now();
      const r = await chat(g.base, k);
      mock.set("ok");
      expectEq(r.status, 504, "status");
      if (Date.now() - t0 > 3000) throw new Error("timeout took too long");
      rmSync(dir3, { recursive: true, force: true });
    });

    await step("gw.offline", "Model server offline → /readyz 503, chat 503, honest dashboard state", async () => {
      const dir4 = mkdtempSync(join(tmpdir(), "crwa-selftest-o-"));
      const g = await startGw(dir4, { UPSTREAM_BASE_URL: "http://127.0.0.1:9/v1" }, []);
      closers.push(g.close);
      const k = g.gw.keys.create("o", ["inference"]).key;
      const rk = g.gw.keys.create("or", ["usage:read"]).key;
      expectEq((await fetch(`${g.base}/healthz`)).status, 200, "healthz");
      expectEq((await fetch(`${g.base}/readyz`)).status, 503, "readyz");
      expectEq((await chat(g.base, k)).status, 503, "chat");
      const degraded = await getInferenceStatus({ baseUrl: g.base, readKey: rk, days: 1 });
      expectEq(degraded.health, "degraded", "dashboard health with model down");
      const offline = await getInferenceStatus({ baseUrl: "http://127.0.0.1:9", readKey: rk, days: 1, timeoutMs: 500 });
      expectEq(offline.health, "offline", "dashboard health with gateway down");
      expectEq(offline.summary, null, "no invented summary");
      rmSync(dir4, { recursive: true, force: true });
    });

    await step("fin.consistency", "Financial calculations stay consistent", async () => {
      const d = computeDistribution({ revenue: 100_000, operatingExpenses: 40_000, reserve: 8_000, holderSharePct: 70 });
      expectEq(d.holderPoolCents + d.retainedCents, d.distributableCashCents, "pool + retained");
      const a = allocateToHolders(d.holderPoolCents, [{ address: "a", balance: 1n }, { address: "b", balance: 2n }]);
      expectEq(a.allocations.reduce((s, x) => s + x.allocationCents, 0), d.holderPoolCents, "allocations sum to pool");
    });
  } finally {
    for (const c of closers) c();
    rmSync(dir, { recursive: true, force: true });
  }
}
