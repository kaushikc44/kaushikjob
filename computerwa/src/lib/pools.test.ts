import { describe, expect, it } from "vitest";
import { getPool, getPools, summarizePool, totalOpex } from "./pools";

describe("seed data", () => {
  it("has three fictional pools with complete monthly records", () => {
    const pools = getPools();
    expect(pools).toHaveLength(3);
    for (const p of pools) {
      expect(p.operator).toMatch(/fictional/i);
      expect(p.months.length).toBeGreaterThan(0);
      expect(p.serials).toHaveLength(p.units);
      for (const m of p.months) {
        expect(m.revenue).toBeGreaterThanOrEqual(0);
        expect(m.utilizationPct).toBeGreaterThan(0);
        expect(m.utilizationPct).toBeLessThanOrEqual(100);
        expect(totalOpex(m)).toBeGreaterThan(0);
      }
    }
  });

  it("summaries reconcile: revenue - opex - reserve = distributable - shortfall", () => {
    for (const p of getPools()) {
      const s = summarizePool(p);
      for (const m of s.months) {
        expect(m.revenueCents - m.operatingExpensesCents - m.reserveCents).toBe(m.distributableCashCents - m.shortfallCents);
        expect(m.holderPoolCents + m.retainedCents).toBe(m.distributableCashCents);
      }
    }
  });

  it("returns undefined for unknown pools", () => {
    expect(getPool("nope")).toBeUndefined();
  });
});
