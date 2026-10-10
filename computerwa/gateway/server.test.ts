/**
 * Integration tests: a real gateway HTTP server in front of a mock
 * OpenAI-compatible model server (shaped like Ollama's /v1 responses).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { UsageSummary } from "../src/lib/inference/types";
import { loadConfig } from "./config";
import { createGateway, type Gateway } from "./server";

type Mode = "ok" | "no_usage" | "slow" | "error500" | "badjson" | "hang";
let mode: Mode = "ok";
let upstreamCalls = 0;
let lastUpstreamBody: Record<string, unknown> | null = null;
let upstream: Server;
let upstreamUrl: string;

const SECRET_PROMPT = "PROMPT-CANARY-7f3a";
const SECRET_REPLY = "REPLY-CANARY-91bc";

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: "gemma4:test", object: "model" }] }));
      }
      upstreamCalls++;
      lastUpstreamBody = JSON.parse(raw);
      const reply = () => {
        if (mode === "error500") {
          res.writeHead(500);
          return res.end("boom");
        }
        if (mode === "badjson") {
          res.writeHead(200);
          return res.end("not json");
        }
        const body: Record<string, unknown> = {
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1,
          model: "gemma4:test",
          choices: [{ index: 0, message: { role: "assistant", content: SECRET_REPLY }, finish_reason: "stop" }],
        };
        if (mode !== "no_usage") body.usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (mode === "hang") return; // never responds
      if (mode === "slow") setTimeout(reply, 150);
      else reply();
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
});

afterAll(() => {
  upstream.closeAllConnections();
  upstream.close();
});

const started: Gateway[] = [];
afterEach(() => {
  mode = "ok";
  for (const g of started.splice(0)) {
    g.server.closeAllConnections();
    g.server.close();
  }
});

async function startGateway(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crwa-gw-int-"));
  const config = loadConfig({
    UPSTREAM_BASE_URL: upstreamUrl,
    UPSTREAM_MODEL: "gemma4:test",
    PUBLIC_MODEL_ID: "gemma-4",
    GATEWAY_KEYS_FILE: join(dir, "keys.json"),
    GATEWAY_LEDGER_FILE: join(dir, "usage.jsonl"),
    UPSTREAM_TIMEOUT_MS: "1000",
    READINESS_TIMEOUT_MS: "500",
    ...env,
  });
  const logs: string[] = [];
  const gw = createGateway(config, (l) => logs.push(JSON.stringify(l)));
  started.push(gw);
  await new Promise<void>((r) => gw.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(gw.server.address() as AddressInfo).port}`;
  const inference = gw.keys.create("client", ["inference"]).key;
  const reader = gw.keys.create("dashboard", ["usage:read"]).key;
  return { gw, base, inference, reader, ledgerPath: config.ledgerFile, logs };
}

const chat = (base: string, key: string | null, body: unknown = { messages: [{ role: "user", content: SECRET_PROMPT }] }, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const summary = async (base: string, key: string) => (await (await fetch(`${base}/v1/usage/summary?days=7`, { headers: { authorization: `Bearer ${key}` } })).json()) as UsageSummary;

describe("gateway", () => {
  it("serves an OpenAI-compatible completion and records measured usage without content", async () => {
    const { base, inference, reader, ledgerPath, logs } = await startGateway();
    const res = await chat(base, inference, { model: "gemma-4", messages: [{ role: "user", content: SECRET_PROMPT }], max_tokens: 5000, temperature: 0.2, foo: "dropped" });
    expect(res.status).toBe(200);
    const reqId = res.headers.get("x-request-id");
    expect(reqId).toMatch(/^req_[0-9a-f]{32}$/);
    const body = await res.json();
    expect(body.model).toBe("gemma-4");
    expect(body.choices[0].message.content).toBe(SECRET_REPLY);
    // upstream got the real model, a clamped max_tokens and only allow-listed fields
    expect(lastUpstreamBody).toMatchObject({ model: "gemma4:test", max_tokens: 1024, temperature: 0.2, stream: false });
    expect(lastUpstreamBody).not.toHaveProperty("foo");

    const s = await summary(base, reader);
    expect(s.requests).toMatchObject({ total: 1, success: 1 });
    expect(s.tokens).toMatchObject({ requestsWithUsage: 1, inputTokens: 11, outputTokens: 7 });
    expect(s.latencyMs.count).toBe(1);
    expect(s.estimated.operatingCostUsd).toBeGreaterThanOrEqual(0);
    expect(s.revenue.recordedPaymentsUsd).toBe(0);

    const ledger = readFileSync(ledgerPath, "utf8");
    expect(ledger).toContain(reqId);
    expect(ledger).not.toContain(SECRET_PROMPT);
    expect(ledger).not.toContain(SECRET_REPLY);
    expect(logs.join("\n")).not.toContain(SECRET_PROMPT);
    expect(logs.join("\n")).not.toContain(SECRET_REPLY);
  });

  it("records null tokens when the runtime does not report usage", async () => {
    mode = "no_usage";
    const { base, inference, reader } = await startGateway();
    expect((await chat(base, inference)).status).toBe(200);
    const s = await summary(base, reader);
    expect(s.tokens).toMatchObject({ requestsWithUsage: 0, requestsWithoutUsage: 1, inputTokens: 0, outputTokens: 0 });
  });

  it("authenticates and enforces scopes", async () => {
    const { base, inference, reader } = await startGateway();
    const none = await chat(base, null);
    expect(none.status).toBe(401);
    const err = await none.json();
    expect(err.error).toMatchObject({ type: "authentication_error", code: "missing_api_key" });
    expect(err.error.request_id).toMatch(/^req_/);
    expect((await chat(base, "crwa_deadbeef_" + "x".repeat(43))).status).toBe(401);
    expect((await chat(base, reader)).status).toBe(403); // read-only key cannot run inference
    expect((await fetch(`${base}/v1/usage/summary`, { headers: { authorization: `Bearer ${inference}` } })).status).toBe(403);
    expect(upstreamCalls).toBeGreaterThanOrEqual(0);
    const s = await summary(base, reader);
    expect(s.unauthenticatedRejectedSinceStart).toBe(2);
    expect(s.requests.total).toBe(0); // unauthenticated attempts are never in the ledger
  });

  it("rate limits per key with Retry-After", async () => {
    const { base, inference, reader } = await startGateway({ RATE_LIMIT_PER_MINUTE: "2" });
    expect((await chat(base, inference)).status).toBe(200);
    expect((await chat(base, inference)).status).toBe(200);
    const limited = await chat(base, inference);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await limited.json()).error.code).toBe("rate_limit_exceeded");
    expect((await summary(base, reader)).requests).toMatchObject({ total: 3, success: 2, rateLimited: 1 });
  });

  it("limits concurrency without queueing", async () => {
    mode = "slow";
    const { base, inference } = await startGateway({ PER_KEY_CONCURRENCY: "1", GLOBAL_CONCURRENCY: "1" });
    const [a, b] = await Promise.all([chat(base, inference), chat(base, inference)]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
  });

  it("rejects oversized and invalid requests with structured errors", async () => {
    const { base, inference } = await startGateway({ MAX_BODY_BYTES: "512", MAX_MESSAGES: "2" });
    const big = await chat(base, inference, { messages: [{ role: "user", content: "x".repeat(2000) }] });
    expect(big.status).toBe(413);
    expect((await big.json()).error.code).toBe("request_too_large");
    const cases: [unknown, number, string][] = [
      ["{not json", 400, "invalid_json"],
      [{ messages: [] }, 400, "invalid_messages"],
      [{ messages: [{ role: "tool", content: "x" }] }, 400, "invalid_messages"],
      [{ messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }, { role: "user", content: "c" }] }, 400, "too_many_messages"],
      [{ messages: [{ role: "user", content: "a" }], stream: true }, 400, "stream_not_supported"],
      [{ messages: [{ role: "user", content: "a" }], model: "gpt-4o" }, 404, "model_not_found"],
      [{ messages: [{ role: "user", content: "a" }], max_tokens: -3 }, 400, "invalid_max_tokens"],
    ];
    for (const [body, status, code] of cases) {
      const r = await chat(base, inference, body);
      expect(r.status, code).toBe(status);
      expect((await r.json()).error.code).toBe(code);
    }
  });

  it("de-duplicates retries with the same Idempotency-Key", async () => {
    const { base, inference, reader } = await startGateway();
    const before = upstreamCalls;
    const first = await chat(base, inference, undefined, { "idempotency-key": "order-42" });
    expect(first.status).toBe(200);
    const retry = await chat(base, inference, undefined, { "idempotency-key": "order-42" });
    expect(retry.status).toBe(409);
    expect((await retry.json()).error).toMatchObject({ code: "duplicate_request", original_request_id: first.headers.get("x-request-id") });
    expect(upstreamCalls - before).toBe(1); // no second inference
    const s = await summary(base, reader);
    expect(s.requests).toMatchObject({ total: 1, success: 1, duplicatesRejected: 1 });
  });

  it("allows retrying an Idempotency-Key whose first attempt failed", async () => {
    mode = "error500";
    const { base, inference } = await startGateway();
    expect((await chat(base, inference, undefined, { "idempotency-key": "k" })).status).toBe(502);
    mode = "ok";
    expect((await chat(base, inference, undefined, { "idempotency-key": "k" })).status).toBe(200);
  });

  it("maps upstream failures: 500 → 502, bad JSON → 502, hang → 504", async () => {
    const { base, inference, reader } = await startGateway({ UPSTREAM_TIMEOUT_MS: "300" });
    mode = "error500";
    expect((await chat(base, inference)).status).toBe(502);
    mode = "badjson";
    expect((await chat(base, inference)).status).toBe(502);
    mode = "hang";
    const t = await chat(base, inference);
    expect(t.status).toBe(504);
    expect((await t.json()).error.code).toBe("upstream_timeout");
    const s = await summary(base, reader);
    expect(s.requests).toMatchObject({ total: 3, success: 0, upstreamErrors: 2, upstreamTimeouts: 1 });
    expect(s.tokens.requestsWithUsage).toBe(0);
  });

  it("Mac mini offline: health stays up, readiness fails, requests get 503 and are recorded", async () => {
    // Port 9 on loopback: nothing listening → connection refused, like a stopped model server.
    const { base, inference, reader } = await startGateway({ UPSTREAM_BASE_URL: "http://127.0.0.1:9/v1" });
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    const rb = await ready.json();
    expect(rb).toMatchObject({ status: "not_ready", reason: "model server unreachable" });
    expect(JSON.stringify(rb)).not.toContain("127.0.0.1:9"); // upstream address not leaked
    const r = await chat(base, inference);
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("30");
    const err = await r.json();
    expect(err.error.code).toBe("model_unavailable");
    expect(JSON.stringify(err)).not.toContain("127.0.0.1:9");
    const s = await summary(base, reader);
    expect(s.requests).toMatchObject({ total: 1, success: 0, upstreamUnavailable: 1 });
    expect(s.estimated.operatingCostUsd).toBe(0);
  });

  it("readiness reports when the configured model is not loaded", async () => {
    const { base } = await startGateway({ UPSTREAM_MODEL: "other-model" });
    const r = await fetch(`${base}/readyz`);
    expect(r.status).toBe(503);
    expect((await r.json()).reason).toMatch(/not loaded/);
    expect((await fetch(`${base}/readyz`.replace("readyz", "nope"))).status).toBe(404);
  });

  it("is ready and lists only the public model id", async () => {
    const { base, inference } = await startGateway();
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    const models = await (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${inference}` } })).json();
    expect(models.data.map((m: { id: string }) => m.id)).toEqual(["gemma-4"]);
  });
});
