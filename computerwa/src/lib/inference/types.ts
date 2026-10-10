/**
 * Types shared by the inference gateway (runs on the Mac mini) and the
 * ComputeRWA dashboard. Measured values and estimates are kept in separate
 * objects so they can never be confused.
 */

export type Outcome =
  | "success"
  | "client_error"
  | "rate_limited"
  | "upstream_error"
  | "upstream_timeout"
  | "upstream_unavailable"
  | "duplicate";

export type TokenSource = "runtime_usage_field" | "unavailable";

export interface LedgerEntry {
  v: 1;
  requestId: string;
  /** ISO time the request finished. */
  ts: string;
  keyId: string;
  /** Model id exposed to API clients. */
  model: string;
  status: number;
  outcome: Outcome;
  errorCode?: string;
  /** SHA-256 of the client's Idempotency-Key header, if sent. */
  idempotencyKeyHash?: string;
  duplicateOf?: string;
  /** Values observed directly by the gateway or reported by the runtime. */
  measured: {
    latencyMs: number;
    /** Time spent waiting on the model server (null if it was never called). */
    upstreamMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    tokenSource: TokenSource;
    finishReason?: string | null;
  };
  /** Derived from configurable assumptions — never measured. */
  estimated: {
    costUsd: number;
    energyKwh: number;
    assumptionsId: string;
  };
}

export interface CostAssumptions {
  /** Average wall power of the Mac mini while generating, in watts. */
  powerWatts: number;
  electricityUsdPerKwh: number;
  /** Purchase price of the machine, amortised over busy time only. */
  hardwareUsd: number;
  hardwareLifetimeHours: number;
  /** Human-readable note on where the numbers came from. */
  note: string;
}

export interface UsageSummary {
  source: {
    system: "computerwa-gateway";
    ledger: "append-only JSONL on the gateway host";
    generatedAt: string;
    gatewayStartedAt: string;
  };
  range: {
    from: string | null;
    to: string;
    firstRecordAt: string | null;
    lastRecordAt: string | null;
  };
  model: string;
  requests: {
    /** Requests that reached the model-handling path (excludes duplicates). */
    total: number;
    success: number;
    clientErrors: number;
    rateLimited: number;
    upstreamErrors: number;
    upstreamTimeouts: number;
    upstreamUnavailable: number;
    duplicatesRejected: number;
  };
  /** Measured end-to-end gateway latency of successful requests. */
  latencyMs: { count: number; mean: number | null; p50: number | null; p95: number | null; max: number | null };
  tokens: {
    /** Successful requests where the runtime reported token counts. */
    requestsWithUsage: number;
    requestsWithoutUsage: number;
    inputTokens: number;
    outputTokens: number;
    source: "runtime-reported usage field; requests without it are excluded, never estimated";
  };
  estimated: {
    operatingCostUsd: number;
    energyKwh: number;
    assumptions: CostAssumptions;
    assumptionsId: string;
    basis: "model-server busy time × (power × electricity price + hardware amortisation per busy hour)";
  };
  revenue: {
    /** Always 0 — the gateway records no payments. */
    recordedPaymentsUsd: 0;
    paymentRecords: 0;
    note: string;
  };
  byDay: { date: string; requests: number; success: number; outputTokens: number; estimatedCostUsd: number }[];
  /** Since gateway start; not persisted (no key = no ledger record). */
  unauthenticatedRejectedSinceStart: number;
}

export interface ReadinessResponse {
  status: "ready" | "not_ready";
  model: string;
  reason?: string;
  checkedAt: string;
}

export type GatewayHealth = "online" | "degraded" | "offline" | "not_configured";

/** What the dashboard's server route returns to the browser. Contains no URLs or keys. */
export interface InferenceStatus {
  health: GatewayHealth;
  checkedAt: string;
  liveness: boolean;
  readiness: ReadinessResponse | null;
  summary: UsageSummary | null;
  error: string | null;
}
