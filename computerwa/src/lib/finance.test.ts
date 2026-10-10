import { describe, expect, it } from "vitest";
import {
  allocateToHolders,
  computeDistribution,
  FinanceInputError,
  formatUsd,
  reserveFromRate,
  toCents,
  validateInputs,
} from "./finance";

const base = { revenue: 100_000, operatingExpenses: 40_000, reserve: 8_000, holderSharePct: 70 };

describe("computeDistribution", () => {
  it("computes the standard waterfall", () => {
    const r = computeDistribution(base);
    expect(r.netOperatingCashCents).toBe(6_000_000);
    expect(r.distributableCashCents).toBe(5_200_000);
    expect(r.holderPoolCents).toBe(3_640_000);
    expect(r.retainedCents).toBe(1_560_000);
    expect(r.shortfallCents).toBe(0);
  });

  it("floors distributable cash at zero and reports the shortfall when costs exceed revenue", () => {
    const r = computeDistribution({ ...base, revenue: 30_000 });
    expect(r.netOperatingCashCents).toBe(-1_000_000);
    expect(r.distributableCashCents).toBe(0);
    expect(r.holderPoolCents).toBe(0);
    expect(r.shortfallCents).toBe(1_800_000);
  });

  it("reports shortfall when only the reserve cannot be funded", () => {
    const r = computeDistribution({ ...base, revenue: 45_000 });
    expect(r.netOperatingCashCents).toBe(500_000);
    expect(r.distributableCashCents).toBe(0);
    expect(r.shortfallCents).toBe(300_000);
  });

  it("returns exactly zero at break-even", () => {
    const r = computeDistribution({ ...base, revenue: 48_000 });
    expect(r.distributableCashCents).toBe(0);
    expect(r.shortfallCents).toBe(0);
  });

  it("handles zero revenue", () => {
    const r = computeDistribution({ revenue: 0, operatingExpenses: 0, reserve: 0, holderSharePct: 50 });
    expect(r.distributableCashCents).toBe(0);
    expect(r.holderPoolCents).toBe(0);
  });

  it("handles 0% and 100% holder share", () => {
    expect(computeDistribution({ ...base, holderSharePct: 0 }).holderPoolCents).toBe(0);
    const full = computeDistribution({ ...base, holderSharePct: 100 });
    expect(full.holderPoolCents).toBe(full.distributableCashCents);
    expect(full.retainedCents).toBe(0);
  });

  it("never invents cents: holderPool + retained === distributable", () => {
    for (const pct of [0, 0.01, 33.33, 66.67, 70.1, 99.99, 100]) {
      const r = computeDistribution({ revenue: 12_345.67, operatingExpenses: 1_234.56, reserve: 98.76, holderSharePct: pct });
      expect(r.holderPoolCents + r.retainedCents).toBe(r.distributableCashCents);
      expect(r.holderPoolCents).toBeGreaterThanOrEqual(0);
    }
  });

  it("avoids floating point drift on decimal amounts", () => {
    const r = computeDistribution({ revenue: 0.3, operatingExpenses: 0.1, reserve: 0.1, holderSharePct: 100 });
    expect(r.distributableCashCents).toBe(10);
  });

  it.each([
    [{ ...base, revenue: -1 }, /Revenue cannot be negative/],
    [{ ...base, operatingExpenses: Number.NaN }, /Operating expenses must be a number/],
    [{ ...base, reserve: Number.POSITIVE_INFINITY }, /Reserve must be a number/],
    [{ ...base, holderSharePct: 101 }, /between 0 and 100/],
    [{ ...base, holderSharePct: -5 }, /between 0 and 100/],
  ])("rejects invalid input %#", (inputs, msg) => {
    expect(() => computeDistribution(inputs)).toThrow(FinanceInputError);
    expect(() => computeDistribution(inputs)).toThrow(msg);
  });
});

describe("validateInputs", () => {
  it("returns no errors for valid input", () => {
    expect(validateInputs(base)).toEqual([]);
  });
  it("collects multiple errors", () => {
    expect(validateInputs({ revenue: -1, operatingExpenses: -1, reserve: 0, holderSharePct: 200 })).toHaveLength(3);
  });
});

describe("allocateToHolders", () => {
  const holders = [
    { address: "A", balance: 500n },
    { address: "B", balance: 300n },
    { address: "C", balance: 200n },
  ];

  it("splits pro rata", () => {
    const r = allocateToHolders(10_000, holders);
    expect(r.allocations.map((a) => a.allocationCents)).toEqual([5_000, 3_000, 2_000]);
    expect(r.allocations.map((a) => a.sharePct)).toEqual([50, 30, 20]);
    expect(r.unallocatedCents).toBe(0);
  });

  it("uses largest remainder so allocations sum exactly to the pool", () => {
    const three = [
      { address: "A", balance: 1n },
      { address: "B", balance: 1n },
      { address: "C", balance: 1n },
    ];
    const r = allocateToHolders(100, three);
    expect(r.allocations.map((a) => a.allocationCents)).toEqual([34, 33, 33]);
    expect(r.unallocatedCents).toBe(0);
  });

  it("gives the extra cent to the largest fractional remainder", () => {
    const r = allocateToHolders(10, [
      { address: "A", balance: 1n },
      { address: "B", balance: 2n },
    ]);
    // A: 3.33 -> 3, B: 6.67 -> 7
    expect(r.allocations.map((a) => a.allocationCents)).toEqual([3, 7]);
  });

  it("leaves the treasury share unallocated when total supply exceeds listed balances", () => {
    const r = allocateToHolders(10_000, holders, 2_000n);
    expect(r.allocations.map((a) => a.allocationCents)).toEqual([2_500, 1_500, 1_000]);
    expect(r.unallocatedCents).toBe(5_000);
  });

  it("handles a zero pool", () => {
    const r = allocateToHolders(0, holders);
    expect(r.allocations.every((a) => a.allocationCents === 0)).toBe(true);
  });

  it("handles no holders / zero supply without dividing by zero", () => {
    expect(allocateToHolders(500, []).unallocatedCents).toBe(500);
    const r = allocateToHolders(500, [{ address: "A", balance: 0n }]);
    expect(r.allocations[0].allocationCents).toBe(0);
    expect(r.unallocatedCents).toBe(500);
  });

  it("gives zero to zero-balance holders", () => {
    const r = allocateToHolders(1_000, [...holders, { address: "D", balance: 0n }]);
    expect(r.allocations[3].allocationCents).toBe(0);
  });

  it("handles very large balances (u64 range) without precision loss", () => {
    const big = 18_000_000_000_000_000_000n; // > Number.MAX_SAFE_INTEGER
    const r = allocateToHolders(99_999_999, [
      { address: "A", balance: big },
      { address: "B", balance: big },
    ]);
    expect(r.allocations[0].allocationCents + r.allocations[1].allocationCents).toBe(99_999_999);
  });

  it("is deterministic on ties (input order wins)", () => {
    const r = allocateToHolders(1, [
      { address: "X", balance: 1n },
      { address: "Y", balance: 1n },
    ]);
    expect(r.allocations.map((a) => a.allocationCents)).toEqual([1, 0]);
  });

  it("rejects bad pool and balances", () => {
    expect(() => allocateToHolders(-1, holders)).toThrow(FinanceInputError);
    expect(() => allocateToHolders(1.5, holders)).toThrow(FinanceInputError);
    expect(() => allocateToHolders(1, [{ address: "A", balance: -1n }])).toThrow(FinanceInputError);
    expect(() => allocateToHolders(1, holders, 10n)).toThrow(/smaller than/);
  });
});

describe("helpers", () => {
  it("toCents rounds and rejects non-finite", () => {
    expect(toCents(12.345)).toBe(1235);
    expect(() => toCents(Number.NaN)).toThrow();
  });
  it("reserveFromRate clamps the rate", () => {
    expect(reserveFromRate(1000, 8)).toBe(80);
    expect(reserveFromRate(1000, -5)).toBe(0);
    expect(reserveFromRate(1000, 150)).toBe(1000);
  });
  it("formats USD", () => {
    expect(formatUsd(123456)).toBe("$1,234.56");
    expect(formatUsd(-500)).toBe("-$5.00");
  });
});
