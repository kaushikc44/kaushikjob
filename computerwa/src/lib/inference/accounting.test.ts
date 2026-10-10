import { describe, expect, it } from "vitest";
import { computeDistribution } from "../finance";
import { hypotheticalPaidRevenue, liveActualInputs } from "./accounting";
import { getInferenceStatus } from "./gatewayClient";
import type { UsageSummary } from "./types";

function summary(p: Partial<UsageSummary["tokens"]> = {}, cost = 1.234): UsageSummary {
  return {
    source: { system: "computerwa-gateway", ledger: "append-only JSONL on the gateway host", generatedAt: "", gatewayStartedAt: "" },
    range: { from: null, to: "", firstRecordAt: null, lastRecordAt: null },
    model: "gemma-4",
    requests: { total: 10, success: 8, clientErrors: 0, rateLimited: 1, upstreamErrors: 0, upstreamTimeouts: 0, upstreamUnavailable: 1, duplicatesRejected: 0 },
    latencyMs: { count: 8, mean: 900, p50: 800, p95: 2000, max: 2500 },
    tokens: { requestsWithUsage: 6, requestsWithoutUsage: 2, inputTokens: 2_000_000, outputTokens: 500_000, source: "runtime-reported usage field; requests without it are excluded, never estimated", ...p },
    estimated: { operatingCostUsd: cost, energyKwh: 0.01, assumptions: { powerWatts: 40, electricityUsdPerKwh: 0.22, hardwareUsd: 0, hardwareLifetimeHours: 1, note: "" }, assumptionsId: "x", basis: "model-server busy time × (power × electricity price + hardware amortisation per busy hour)" },
    revenue: { recordedPaymentsUsd: 0, paymentRecords: 0, note: "" },
    byDay: [],
    unauthenticatedRejectedSinceStart: 0,
  };
}

describe("live usage → simulator", () => {
  it("never treats free API usage as revenue", () => {
    const i = liveActualInputs(summary());
    expect(i).toEqual({ revenue: 0, operatingExpenses: 1.23, reserve: 0, label: "LIVE_ACTUAL" });
    const r = computeDistribution({ revenue: i.revenue, operatingExpenses: i.operatingExpenses, reserve: i.reserve, holderSharePct: 70 });
    expect(r.distributableCashCents).toBe(0);
    expect(r.holderPoolCents).toBe(0);
    expect(r.shortfallCents).toBe(123);
  });

  it("prices only measured tokens in a separately labelled hypothetical", () => {
    const h = hypotheticalPaidRevenue(summary(), { usdPerMillionInputTokens: 0.1, usdPerMillionOutputTokens: 0.4 });
    expect(h).toMatchObject({ pricedRequests: 6, unpricedRequests: 2, label: "HYPOTHETICAL" });
    expect(h!.revenueUsd).toBeCloseTo(0.4);
    // sub-cent amounts are kept (not rounded away) for display
    const tiny = hypotheticalPaidRevenue(summary({ inputTokens: 100, outputTokens: 900 }), { usdPerMillionInputTokens: 0.1, usdPerMillionOutputTokens: 0.4 });
    expect(tiny!.revenueUsd).toBeCloseTo(0.00037);
  });

  it("returns null when there are no measured tokens or prices are invalid", () => {
    expect(hypotheticalPaidRevenue(summary({ requestsWithUsage: 0, inputTokens: 0, outputTokens: 0 }), { usdPerMillionInputTokens: 1, usdPerMillionOutputTokens: 1 })).toBeNull();
    expect(hypotheticalPaidRevenue(summary(), { usdPerMillionInputTokens: -1, usdPerMillionOutputTokens: 1 })).toBeNull();
    expect(hypotheticalPaidRevenue(summary(), { usdPerMillionInputTokens: Number.NaN, usdPerMillionOutputTokens: 1 })).toBeNull();
  });
});

describe("dashboard gateway client", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("reports not_configured without secrets", async () => {
    const s = await getInferenceStatus({ baseUrl: undefined, readKey: undefined, days: 7 });
    expect(s.health).toBe("not_configured");
    expect(s.summary).toBeNull();
  });

  it("reports offline when the Mac mini / gateway is unreachable, with no invented data", async () => {
    const s = await getInferenceStatus({
      baseUrl: "http://127.0.0.1:9",
      readKey: "crwa_x",
      days: 7,
      timeoutMs: 500,
    });
    expect(s.health).toBe("offline");
    expect(s.summary).toBeNull();
    expect(JSON.stringify(s)).not.toContain("127.0.0.1");
    expect(JSON.stringify(s)).not.toContain("crwa_x");
  });

  it("reports degraded when the gateway is up but the model is not ready", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith("/healthz")) return json({ status: "ok" });
      if (url.endsWith("/readyz")) return json({ status: "not_ready", model: "gemma-4", reason: "model server unreachable", checkedAt: "" }, 503);
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer crwa_read");
      return json(summary());
    }) as typeof fetch;
    const s = await getInferenceStatus({ baseUrl: "https://gw.example/", readKey: "crwa_read", days: 30, fetchImpl });
    expect(s.health).toBe("degraded");
    expect(s.summary?.requests.total).toBe(10);
    expect(s.error).toMatch(/not ready/);
    expect(calls).toContain("https://gw.example/v1/usage/summary?days=30");
  });

  it("is online when healthy, ready and the summary loads; flags a rejected read key", async () => {
    const ok = (async (url: string) =>
      url.endsWith("/readyz") ? json({ status: "ready", model: "gemma-4", checkedAt: "" }) : url.endsWith("/healthz") ? json({ status: "ok" }) : json(summary())) as typeof fetch;
    expect((await getInferenceStatus({ baseUrl: "https://gw", readKey: "k", days: 7, fetchImpl: ok })).health).toBe("online");
    const denied = (async (url: string) =>
      url.endsWith("/readyz") ? json({ status: "ready", model: "gemma-4", checkedAt: "" }) : url.endsWith("/healthz") ? json({ status: "ok" }) : json({}, 401)) as typeof fetch;
    const s = await getInferenceStatus({ baseUrl: "https://gw", readKey: "k", days: 7, fetchImpl: denied });
    expect(s.health).toBe("degraded");
    expect(s.error).toMatch(/read key was rejected/);
  });
});
