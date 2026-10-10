import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CostAssumptions, LedgerEntry } from "../src/lib/inference/types";
import { ConfigError, loadConfig } from "./config";
import { assumptionsId, estimateCost } from "./cost";
import { extractKey, hashKey, KeyStore } from "./keys";
import { Ledger, summarize } from "./ledger";
import { ConcurrencyLimiter, RateLimiter } from "./limits";
import { readUsage } from "./upstream";

const tmp = () => mkdtempSync(join(tmpdir(), "crwa-gw-"));
const A: CostAssumptions = { powerWatts: 40, electricityUsdPerKwh: 0.25, hardwareUsd: 876, hardwareLifetimeHours: 8760, note: "test" };

describe("keys", () => {
  it("stores only a hash, authenticates, enforces scopes and revocation", () => {
    const path = join(tmp(), "keys.json");
    const store = new KeyStore(path);
    const { key, stored } = store.create("alice", ["inference"]);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(key);
    expect(raw).not.toContain(key.split("_")[2]);
    expect(stored.hash).toBe(hashKey(key));
    expect(statSync(path).mode & 0o777).toBe(0o600);

    expect(store.authenticate(key, "inference")).toMatchObject({ ok: true });
    expect(store.authenticate(key, "usage:read")).toEqual({ ok: false, reason: "forbidden" });
    expect(store.authenticate(null, "inference")).toEqual({ ok: false, reason: "missing" });
    expect(store.authenticate("not-a-key", "inference")).toEqual({ ok: false, reason: "invalid" });
    const tampered = key.slice(0, -1) + (key.endsWith("A") ? "B" : "A");
    expect(store.authenticate(tampered, "inference")).toEqual({ ok: false, reason: "invalid" });
    expect(store.revoke(stored.id)).toBe(true);
    expect(store.authenticate(key, "inference")).toEqual({ ok: false, reason: "revoked" });
  });

  it("picks up keys added by another process (file reload)", () => {
    const path = join(tmp(), "keys.json");
    const server = new KeyStore(path);
    expect(server.authenticate("crwa_00000000_" + "a".repeat(43), "inference").ok).toBe(false);
    const { key } = new KeyStore(path).create("bob", ["inference"]);
    // ensure mtime differs on coarse filesystems
    const f = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify(f));
    expect(server.authenticate(key, "inference").ok).toBe(true);
  });

  it("rejects bad scopes and empty names", () => {
    const store = new KeyStore(join(tmp(), "k.json"));
    expect(() => store.create("", ["inference"])).toThrow();
    expect(() => store.create("x", ["admin" as never])).toThrow();
  });

  it("extracts bearer or x-api-key", () => {
    expect(extractKey({ authorization: "Bearer abc" })).toBe("abc");
    expect(extractKey({ "x-api-key": "def" })).toBe("def");
    expect(extractKey({ authorization: "Basic xyz" })).toBeNull();
  });
});

describe("limits", () => {
  it("rate limits per key in one-minute windows", () => {
    let now = 0;
    const r = new RateLimiter(() => now);
    expect(r.take("a", 2)).toBe(0);
    expect(r.take("a", 2)).toBe(0);
    expect(r.take("a", 2)).toBe(60);
    expect(r.take("b", 2)).toBe(0); // independent keys
    now = 30_000;
    expect(r.take("a", 2)).toBe(30);
    now = 60_000;
    expect(r.take("a", 2)).toBe(0);
  });

  it("enforces global and per-key concurrency and releases idempotently", () => {
    const c = new ConcurrencyLimiter(2, 1);
    const a = c.acquire("a");
    expect(a.ok).toBe(true);
    expect(c.acquire("a")).toEqual({ ok: false, scope: "key" });
    const b = c.acquire("b");
    expect(b.ok).toBe(true);
    expect(c.acquire("c")).toEqual({ ok: false, scope: "global" });
    if (a.ok) {
      a.release();
      a.release();
    }
    expect(c.active).toBe(1);
    expect(c.acquire("c").ok).toBe(true);
  });
});

describe("cost estimate", () => {
  it("charges busy time only, from assumptions", () => {
    const { costUsd, energyKwh } = estimateCost(3_600_000, A); // 1 busy hour
    expect(energyKwh).toBeCloseTo(0.04);
    expect(costUsd).toBeCloseTo(0.04 * 0.25 + 876 / 8760);
    expect(estimateCost(null, A)).toEqual({ costUsd: 0, energyKwh: 0 });
    expect(estimateCost(0, A)).toEqual({ costUsd: 0, energyKwh: 0 });
  });
  it("assumption id changes with the assumptions", () => {
    expect(assumptionsId(A)).not.toBe(assumptionsId({ ...A, powerWatts: 41 }));
  });
});

describe("usage parsing", () => {
  it("never invents token counts", () => {
    expect(readUsage({ usage: { prompt_tokens: 12, completion_tokens: 30 } })).toEqual({ inputTokens: 12, outputTokens: 30 });
    expect(readUsage({})).toEqual({ inputTokens: null, outputTokens: null });
    expect(readUsage({ usage: { prompt_tokens: 12 } })).toEqual({ inputTokens: null, outputTokens: null });
    expect(readUsage({ usage: { prompt_tokens: -1, completion_tokens: 3 } })).toEqual({ inputTokens: null, outputTokens: null });
    expect(readUsage({ usage: { prompt_tokens: 1.5, completion_tokens: 3 } })).toEqual({ inputTokens: null, outputTokens: null });
  });
});

function entry(p: Partial<LedgerEntry> & { outcome: LedgerEntry["outcome"] }): LedgerEntry {
  return {
    v: 1,
    requestId: p.requestId ?? Math.random().toString(36),
    ts: p.ts ?? "2026-10-10T00:00:00.000Z",
    keyId: "k1",
    model: "gemma-4",
    status: p.outcome === "success" ? 200 : 500,
    measured: { latencyMs: 100, upstreamMs: 90, inputTokens: null, outputTokens: null, tokenSource: "unavailable" },
    estimated: { costUsd: 0.001, energyKwh: 0.0001, assumptionsId: "x" },
    ...p,
  };
}

describe("ledger summary", () => {
  const opts = { from: null, to: new Date("2026-12-31"), model: "gemma-4", assumptions: A, assumptionsId: "x", gatewayStartedAt: "2026-10-01T00:00:00Z", unauthenticatedRejected: 3 };

  it("separates measured from estimated, excludes duplicates, never invents tokens, revenue stays 0", () => {
    const entries = [
      entry({ outcome: "success", measured: { latencyMs: 100, upstreamMs: 90, inputTokens: 10, outputTokens: 20, tokenSource: "runtime_usage_field" } }),
      entry({ outcome: "success", measured: { latencyMs: 300, upstreamMs: 290, inputTokens: null, outputTokens: null, tokenSource: "unavailable" } }),
      entry({ outcome: "upstream_unavailable", estimated: { costUsd: 0, energyKwh: 0, assumptionsId: "x" } }),
      entry({ outcome: "rate_limited", estimated: { costUsd: 0, energyKwh: 0, assumptionsId: "x" } }),
      entry({ outcome: "duplicate", estimated: { costUsd: 0, energyKwh: 0, assumptionsId: "x" } }),
    ];
    const s = summarize(entries, opts);
    expect(s.requests).toMatchObject({ total: 4, success: 2, upstreamUnavailable: 1, rateLimited: 1, duplicatesRejected: 1 });
    expect(s.tokens).toMatchObject({ requestsWithUsage: 1, requestsWithoutUsage: 1, inputTokens: 10, outputTokens: 20 });
    expect(s.latencyMs).toMatchObject({ count: 2, p50: 100, p95: 300, max: 300, mean: 200 });
    expect(s.estimated.operatingCostUsd).toBeCloseTo(0.002);
    expect(s.revenue.recordedPaymentsUsd).toBe(0);
    expect(s.unauthenticatedRejectedSinceStart).toBe(3);
    expect(s.byDay).toEqual([{ date: "2026-10-10", requests: 4, success: 2, outputTokens: 20, estimatedCostUsd: 0.002 }]);
  });

  it("filters by date range and handles an empty ledger", () => {
    const e = [entry({ outcome: "success", ts: "2026-01-01T00:00:00Z" }), entry({ outcome: "success", ts: "2026-10-09T00:00:00Z" })];
    const s = summarize(e, { ...opts, from: new Date("2026-10-01") });
    expect(s.requests.total).toBe(1);
    expect(s.range.firstRecordAt).toBe("2026-10-09T00:00:00Z");
    const empty = summarize([], opts);
    expect(empty.requests.total).toBe(0);
    expect(empty.latencyMs).toEqual({ count: 0, mean: null, p50: null, p95: null, max: null });
  });

  it("persists across restarts and tolerates a torn final line", () => {
    const path = join(tmp(), "usage.jsonl");
    const l = new Ledger(path);
    l.append(entry({ outcome: "success", requestId: "r1" }));
    writeFileSync(path, readFileSync(path, "utf8") + '{"v":1,"requestId":"r2"', { flag: "w" });
    const reloaded = new Ledger(path);
    expect(reloaded.all().map((e) => e.requestId)).toEqual(["r1"]);
    expect(reloaded.skippedLines).toBe(1);
  });
});

describe("config", () => {
  it("requires the upstream model and validates numbers", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ UPSTREAM_MODEL: "m", RATE_LIMIT_PER_MINUTE: "abc" })).toThrow(/RATE_LIMIT_PER_MINUTE/);
    const c = loadConfig({ UPSTREAM_MODEL: "m", DEFAULT_MAX_TOKENS: "5000", MAX_OUTPUT_TOKENS: "100" });
    expect(c.defaultMaxTokens).toBe(100);
    expect(c.host).toBe("127.0.0.1");
    expect(c.publicModelId).toBe("m");
  });
});
