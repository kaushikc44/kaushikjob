import { describe, expect, it } from "vitest";
import seed from "@/data/pools.json";
import type { SeedFile } from "../types";
import { canonicalPoolRecord, encodeRecord, parseMemoField, poolDataHash, tryParseRecord } from "./records";

const pools = (seed as SeedFile).pools;

describe("records", () => {
  it("hashes pool data deterministically and detects changes", async () => {
    const a = await poolDataHash(pools[0]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await poolDataHash(pools[0])).toBe(a);
    const tampered = { ...pools[0], months: pools[0].months.map((m, i) => (i === 0 ? { ...m, revenue: m.revenue + 1 } : m)) };
    expect(await poolDataHash(tampered)).not.toBe(a);
    expect(canonicalPoolRecord(pools[0])).not.toContain("holderSharePct");
  });

  it("parses RPC memo fields, including multiple memos and foreign memos", () => {
    const rec = encodeRecord({ app: "ComputeRWA", v: 1, t: "pool-registration", pool: "p1", gpu: "H100", units: 8, dataHash: "ab", demo: true });
    expect(parseMemoField(`[${rec.length}] ${rec}`)).toHaveLength(1);
    expect(parseMemoField(`[5] hello; [${rec.length}] ${rec}`)[0].pool).toBe("p1");
    expect(parseMemoField("[5] hello")).toEqual([]);
    expect(parseMemoField(null)).toEqual([]);
    expect(tryParseRecord('{"app":"Other","t":"x","pool":"p"}')).toBeNull();
  });

  it("rejects oversize records", () => {
    expect(() =>
      encodeRecord({ app: "ComputeRWA", v: 1, t: "pool-registration", pool: "x".repeat(600), gpu: "", units: 1, dataHash: "", demo: true }),
    ).toThrow(/too large/);
  });
});
