/**
 * Append-only usage ledger (JSON Lines). Stores metadata only: never prompts
 * or completions. All entries are kept in memory for aggregation, which is
 * fine for a single-machine demo (≈300 bytes per request).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CostAssumptions, LedgerEntry, UsageSummary } from "../src/lib/inference/types";

export class Ledger {
  private entries: LedgerEntry[] = [];
  readonly skippedLines: number = 0;

  constructor(private readonly path: string | null) {
    if (path && existsSync(path)) {
      let skipped = 0;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as LedgerEntry;
          if (e.v === 1 && e.requestId && e.ts) this.entries.push(e);
          else skipped++;
        } catch {
          skipped++; // e.g. a torn final line after a crash
        }
      }
      this.skippedLines = skipped;
    }
  }

  append(entry: LedgerEntry): void {
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(entry) + "\n", { mode: 0o600 });
    }
    this.entries.push(entry);
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  /** Most recent completed entry for an idempotency key hash + API key, within the TTL. */
  findByIdempotency(keyId: string, idemHash: string, sinceMs: number): LedgerEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (Date.parse(e.ts) < sinceMs) break;
      if (e.keyId === keyId && e.idempotencyKeyHash === idemHash && e.outcome !== "duplicate") return e;
    }
    return undefined;
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarize(
  entries: readonly LedgerEntry[],
  opts: {
    from: Date | null;
    to: Date;
    model: string;
    assumptions: CostAssumptions;
    assumptionsId: string;
    gatewayStartedAt: string;
    unauthenticatedRejected: number;
    now?: Date;
  },
): UsageSummary {
  const fromMs = opts.from ? opts.from.getTime() : -Infinity;
  const toMs = opts.to.getTime();
  const inRange = entries.filter((e) => {
    const t = Date.parse(e.ts);
    return t >= fromMs && t <= toMs;
  });

  const requests = {
    total: 0,
    success: 0,
    clientErrors: 0,
    rateLimited: 0,
    upstreamErrors: 0,
    upstreamTimeouts: 0,
    upstreamUnavailable: 0,
    duplicatesRejected: 0,
  };
  const latencies: number[] = [];
  let withUsage = 0;
  let withoutUsage = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let energy = 0;
  const days = new Map<string, { requests: number; success: number; outputTokens: number; estimatedCostUsd: number }>();

  for (const e of inRange) {
    if (e.outcome === "duplicate") {
      requests.duplicatesRejected++;
      continue;
    }
    requests.total++;
    const day = e.ts.slice(0, 10);
    const d = days.get(day) ?? { requests: 0, success: 0, outputTokens: 0, estimatedCostUsd: 0 };
    d.requests++;
    switch (e.outcome) {
      case "success":
        requests.success++;
        d.success++;
        latencies.push(e.measured.latencyMs);
        if (e.measured.tokenSource === "runtime_usage_field" && e.measured.inputTokens !== null && e.measured.outputTokens !== null) {
          withUsage++;
          inputTokens += e.measured.inputTokens;
          outputTokens += e.measured.outputTokens;
          d.outputTokens += e.measured.outputTokens;
        } else {
          withoutUsage++;
        }
        break;
      case "client_error":
        requests.clientErrors++;
        break;
      case "rate_limited":
        requests.rateLimited++;
        break;
      case "upstream_error":
        requests.upstreamErrors++;
        break;
      case "upstream_timeout":
        requests.upstreamTimeouts++;
        break;
      case "upstream_unavailable":
        requests.upstreamUnavailable++;
        break;
    }
    cost += e.estimated.costUsd;
    energy += e.estimated.energyKwh;
    d.estimatedCostUsd += e.estimated.costUsd;
    days.set(day, d);
  }

  latencies.sort((a, b) => a - b);
  const mean = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;

  return {
    source: {
      system: "computerwa-gateway",
      ledger: "append-only JSONL on the gateway host",
      generatedAt: (opts.now ?? new Date()).toISOString(),
      gatewayStartedAt: opts.gatewayStartedAt,
    },
    range: {
      from: opts.from ? opts.from.toISOString() : null,
      to: opts.to.toISOString(),
      firstRecordAt: inRange[0]?.ts ?? null,
      lastRecordAt: inRange.at(-1)?.ts ?? null,
    },
    model: opts.model,
    requests,
    latencyMs: {
      count: latencies.length,
      mean: mean === null ? null : Math.round(mean),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.at(-1) ?? null,
    },
    tokens: {
      requestsWithUsage: withUsage,
      requestsWithoutUsage: withoutUsage,
      inputTokens,
      outputTokens,
      source: "runtime-reported usage field; requests without it are excluded, never estimated",
    },
    estimated: {
      operatingCostUsd: cost,
      energyKwh: energy,
      assumptions: opts.assumptions,
      assumptionsId: opts.assumptionsId,
      basis: "model-server busy time × (power × electricity price + hardware amortisation per busy hour)",
    },
    revenue: {
      recordedPaymentsUsd: 0,
      paymentRecords: 0,
      note: "Free API: no payment records exist, so customer revenue is $0. Usage is not revenue.",
    },
    byDay: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
    unauthenticatedRejectedSinceStart: opts.unauthenticatedRejected,
  };
}
