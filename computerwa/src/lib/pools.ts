import seed from "@/data/pools.json";
import { computeDistribution, type DistributionResult } from "./finance";
import type { AssetPool, MonthlyRecord, SeedFile } from "./types";

const data = seed as SeedFile;

export const SEED_DISCLAIMER = data.disclaimer;
export const SEED_GENERATED_AT = data.generatedAt;

export function getPools(): AssetPool[] {
  return data.pools;
}

export function getPool(id: string): AssetPool | undefined {
  return data.pools.find((p) => p.id === id);
}

export function totalOpex(m: MonthlyRecord): number {
  return m.opex.power + m.opex.colocation + m.opex.network + m.opex.operations;
}

export interface MonthSummary extends DistributionResult {
  month: string;
  utilizationPct: number;
  hours: number;
  pricePerGpuHour: number;
}

export function summarizeMonth(pool: AssetPool, m: MonthlyRecord): MonthSummary {
  const r = computeDistribution({
    revenue: m.revenue,
    operatingExpenses: totalOpex(m),
    reserve: m.reserve,
    holderSharePct: pool.holderSharePct,
  });
  return { ...r, month: m.month, utilizationPct: m.utilizationPct, hours: m.hours, pricePerGpuHour: m.pricePerGpuHour };
}

export function summarizePool(pool: AssetPool) {
  const months = pool.months.map((m) => summarizeMonth(pool, m));
  const latest = months.at(-1);
  const sum = (k: keyof DistributionResult) => months.reduce((a, m) => a + (m[k] as number), 0);
  const avgUtil = months.length ? months.reduce((a, m) => a + m.utilizationPct, 0) / months.length : 0;
  return {
    months,
    latest,
    totals: {
      revenueCents: sum("revenueCents"),
      operatingExpensesCents: sum("operatingExpensesCents"),
      reserveCents: sum("reserveCents"),
      distributableCashCents: sum("distributableCashCents"),
      holderPoolCents: sum("holderPoolCents"),
      shortfallCents: sum("shortfallCents"),
    },
    avgUtil,
  };
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-AU", { month: "short", year: "2-digit", timeZone: "UTC" });
}

export const STATUS_STYLE: Record<AssetPool["status"], string> = {
  Deployed: "bg-emerald-500/15 text-emerald-300",
  Commissioning: "bg-sky-500/15 text-sky-300",
  Procurement: "bg-slate-500/20 text-slate-300",
};
