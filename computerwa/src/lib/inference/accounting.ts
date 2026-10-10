/**
 * Maps live gateway usage into simulator inputs. Actual revenue comes only
 * from recorded payments (none exist for the free API, so it is $0).
 * Hypothetical paid scenarios are computed separately and only from
 * runtime-reported token counts — never from estimated tokens.
 */
import type { UsageSummary } from "./types";

export interface LiveActualInputs {
  revenue: number;
  operatingExpenses: number;
  reserve: number;
  label: "LIVE_ACTUAL";
}

export function liveActualInputs(s: UsageSummary): LiveActualInputs {
  return {
    revenue: s.revenue.recordedPaymentsUsd, // always 0 until real payments are recorded
    operatingExpenses: round2(s.estimated.operatingCostUsd),
    reserve: 0,
    label: "LIVE_ACTUAL",
  };
}

export interface PriceAssumption {
  usdPerMillionInputTokens: number;
  usdPerMillionOutputTokens: number;
}

export interface HypotheticalRevenue {
  /** Unrounded; callers round when feeding the cent-based simulator. */
  revenueUsd: number;
  /** Successful requests whose tokens were measured and priced. */
  pricedRequests: number;
  /** Successful requests without token counts — excluded, not estimated. */
  unpricedRequests: number;
  label: "HYPOTHETICAL";
}

/** Returns null when no request has measured token counts (nothing to price). */
export function hypotheticalPaidRevenue(s: UsageSummary, price: PriceAssumption): HypotheticalRevenue | null {
  if (!Number.isFinite(price.usdPerMillionInputTokens) || !Number.isFinite(price.usdPerMillionOutputTokens)) return null;
  if (price.usdPerMillionInputTokens < 0 || price.usdPerMillionOutputTokens < 0) return null;
  if (s.tokens.requestsWithUsage === 0) return null;
  const revenueUsd = (s.tokens.inputTokens / 1e6) * price.usdPerMillionInputTokens + (s.tokens.outputTokens / 1e6) * price.usdPerMillionOutputTokens;
  return { revenueUsd, pricedRequests: s.tokens.requestsWithUsage, unpricedRequests: s.tokens.requestsWithoutUsage, label: "HYPOTHETICAL" };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
