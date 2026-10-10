/**
 * Fetches health, readiness and usage from the gateway. Pure (URL/key passed
 * in) so it can be unit-tested; the server-only wrapper in ./server.ts reads
 * the secrets from the environment.
 */
import type { InferenceStatus, ReadinessResponse, UsageSummary } from "./types";

export interface GatewayClientOptions {
  baseUrl: string | undefined;
  readKey: string | undefined;
  days: number | "all";
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function getInferenceStatus(opts: GatewayClientOptions): Promise<InferenceStatus> {
  const checkedAt = new Date().toISOString();
  if (!opts.baseUrl || !opts.readKey) {
    return { health: "not_configured", checkedAt, liveness: false, readiness: null, summary: null, error: "Inference gateway is not configured on this deployment." };
  }
  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const timeout = opts.timeoutMs ?? 4000;
  const get = (path: string, auth: boolean) =>
    f(`${base}${path}`, {
      headers: auth ? { authorization: `Bearer ${opts.readKey}` } : {},
      signal: AbortSignal.timeout(timeout),
      cache: "no-store",
    });

  let liveness = false;
  try {
    liveness = (await get("/healthz", false)).ok;
  } catch {
    liveness = false;
  }
  if (!liveness) {
    return {
      health: "offline",
      checkedAt,
      liveness,
      readiness: null,
      summary: null,
      error: "Gateway unreachable (Mac mini offline, asleep or tunnel down). No live data is shown and nothing is estimated in its place.",
    };
  }

  let readiness: ReadinessResponse | null = null;
  try {
    const r = await get("/readyz", false);
    readiness = (await r.json()) as ReadinessResponse;
  } catch {
    readiness = null;
  }

  let summary: UsageSummary | null = null;
  let error: string | null = null;
  try {
    const r = await get(`/v1/usage/summary?days=${opts.days}`, true);
    if (r.ok) summary = (await r.json()) as UsageSummary;
    else error = r.status === 401 || r.status === 403 ? "Dashboard read key was rejected by the gateway." : `Usage summary failed (HTTP ${r.status}).`;
  } catch {
    error = "Usage summary request failed.";
  }

  const ready = readiness?.status === "ready";
  return { health: ready && summary ? "online" : "degraded", checkedAt, liveness, readiness, summary, error: error ?? (ready ? null : `Model not ready: ${readiness?.reason ?? "unknown"}`) };
}
