/**
 * Generates src/data/pools.json — FICTIONAL demo data. Deterministic (seeded PRNG),
 * so re-running produces the same file. Run: npm run seed
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AssetPool, LedgerEntry, MonthlyRecord, SeedFile } from "../src/lib/types";

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

interface PoolSpec {
  id: string;
  name: string;
  operator: string;
  location: string;
  gpuModel: string;
  units: number;
  unitCost: number;
  acquisitionDate: string;
  status: AssetPool["status"];
  kwPerGpu: number;
  basePrice: number;
  baseUtil: number;
  utilTrend: number;
  colocationPerMonth: number;
  networkPerMonth: number;
  opsPerMonth: number;
  powerPerKwh: number;
  reserveRatePct: number;
  holderSharePct: number;
  tokenSupply: number;
  tokenSymbol: string;
  firstMonth: string;
  rampMonths: number;
  seed: number;
  serialPrefix: string;
  description: string;
}

const LAST_MONTH = "2026-09";

const specs: PoolSpec[] = [
  {
    id: "syd-h100-a",
    name: "Harbour Edge H100 Pool A",
    operator: "Demo Operator: Southern Cross Compute (fictional)",
    location: "Sydney, NSW (Tier III colocation)",
    gpuModel: "NVIDIA H100 SXM5 80GB",
    units: 64,
    unitCost: 31_500,
    acquisitionDate: "2025-09-12",
    status: "Deployed",
    kwPerGpu: 1.25,
    basePrice: 2.15,
    baseUtil: 74,
    utilTrend: 0.6,
    colocationPerMonth: 14_800,
    networkPerMonth: 3_200,
    opsPerMonth: 9_500,
    powerPerKwh: 0.21,
    reserveRatePct: 8,
    holderSharePct: 70,
    tokenSupply: 1_000_000,
    tokenSymbol: "cRWA-H100A",
    firstMonth: "2025-10",
    rampMonths: 1,
    seed: 11,
    serialPrefix: "DEMO-H100",
    description:
      "Inference-optimised H100 cluster serving LLM API workloads under short-term reserved contracts. All figures are fictional.",
  },
  {
    id: "mel-l40s-b",
    name: "Yarra L40S Batch Cluster",
    operator: "Demo Operator: Laneway GPU Co. (fictional)",
    location: "Melbourne, VIC (enterprise data hall)",
    gpuModel: "NVIDIA L40S 48GB",
    units: 128,
    unitCost: 8_900,
    acquisitionDate: "2025-08-28",
    status: "Deployed",
    kwPerGpu: 0.45,
    basePrice: 0.86,
    baseUtil: 63,
    utilTrend: 0.3,
    colocationPerMonth: 9_600,
    networkPerMonth: 2_100,
    opsPerMonth: 7_200,
    powerPerKwh: 0.19,
    reserveRatePct: 10,
    holderSharePct: 65,
    tokenSupply: 1_000_000,
    tokenSymbol: "cRWA-L40SB",
    firstMonth: "2025-10",
    rampMonths: 0,
    seed: 22,
    serialPrefix: "DEMO-L40S",
    description:
      "Mixed batch inference and image-generation cluster on spot-style pricing; utilisation is more volatile. All figures are fictional.",
  },
  {
    id: "bne-b200-c",
    name: "River City B200 Expansion",
    operator: "Demo Operator: Southern Cross Compute (fictional)",
    location: "Brisbane, QLD (liquid-cooled pod)",
    gpuModel: "NVIDIA B200 192GB",
    units: 32,
    unitCost: 46_000,
    acquisitionDate: "2026-05-30",
    status: "Commissioning",
    kwPerGpu: 1.6,
    basePrice: 3.9,
    baseUtil: 58,
    utilTrend: 0,
    colocationPerMonth: 11_200,
    networkPerMonth: 2_800,
    opsPerMonth: 8_800,
    powerPerKwh: 0.22,
    reserveRatePct: 8,
    holderSharePct: 70,
    tokenSupply: 1_000_000,
    tokenSymbol: "cRWA-B200C",
    firstMonth: "2026-07",
    rampMonths: 3,
    seed: 33,
    serialPrefix: "DEMO-B200",
    description:
      "Newly installed B200 pod in its commissioning period. Only three months of (fictional) operating history; early months include burn-in.",
  },
];

function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  let [y, m] = first.split("-").map(Number);
  const [ly, lm] = last.split("-").map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function daysIn(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function build(spec: PoolSpec): AssetPool {
  const rand = mulberry32(spec.seed);
  const months: MonthlyRecord[] = [];
  const ledger: LedgerEntry[] = [];
  let ref = 1000;
  const nextRef = (p: string) => `${p}-${spec.id.toUpperCase()}-${ref++}`;
  const acquisitionCost = spec.units * spec.unitCost;

  ledger.push({
    id: `${spec.id}-acq`,
    date: spec.acquisitionDate,
    kind: "acquisition",
    description: `Acquisition of ${spec.units}× ${spec.gpuModel} incl. servers & networking (demo)`,
    amount: -acquisitionCost,
    reference: nextRef("PO"),
  });

  monthsBetween(spec.firstMonth, LAST_MONTH).forEach((month, i) => {
    const hours = daysIn(month) * 24;
    const ramp = i < spec.rampMonths ? 0.45 + (0.55 * (i + 1)) / (spec.rampMonths + 1) : 1;
    const noise = (rand() - 0.5) * 12;
    const util = Math.min(96, Math.max(8, (spec.baseUtil + spec.utilTrend * i + noise) * ramp));
    const price = round2(spec.basePrice * (1 + (rand() - 0.5) * 0.08));
    const revenue = round2(spec.units * hours * (util / 100) * price);
    // Idle GPUs still draw ~30% power; PUE 1.3.
    const kwh = spec.units * spec.kwPerGpu * hours * (0.3 + 0.7 * (util / 100)) * 1.3;
    const opex = {
      power: round2(kwh * spec.powerPerKwh),
      colocation: spec.colocationPerMonth,
      network: round2(spec.networkPerMonth * (1 + (rand() - 0.5) * 0.1)),
      operations: spec.opsPerMonth,
    };
    const reserve = round2((revenue * spec.reserveRatePct) / 100);
    months.push({ month, hours, utilizationPct: round2(util), pricePerGpuHour: price, revenue, opex, reserve });

    const [y, m] = month.split("-").map(Number);
    const settle = new Date(Date.UTC(y, m, 5)).toISOString().slice(0, 10);
    const endOf = `${month}-${String(daysIn(month)).padStart(2, "0")}`;
    ledger.push(
      { id: `${spec.id}-${month}-rev`, date: settle, kind: "revenue", description: `Inference revenue settled for ${month} (${util.toFixed(1)}% utilisation)`, amount: revenue, reference: nextRef("INV") },
      { id: `${spec.id}-${month}-pwr`, date: endOf, kind: "expense", description: "Electricity", amount: -opex.power, reference: nextRef("BILL") },
      { id: `${spec.id}-${month}-col`, date: endOf, kind: "expense", description: "Colocation & cooling", amount: -opex.colocation, reference: nextRef("BILL") },
      { id: `${spec.id}-${month}-net`, date: endOf, kind: "expense", description: "Network & transit", amount: -opex.network, reference: nextRef("BILL") },
      { id: `${spec.id}-${month}-ops`, date: endOf, kind: "expense", description: "Operations, monitoring & insurance", amount: -opex.operations, reference: nextRef("BILL") },
      { id: `${spec.id}-${month}-res`, date: settle, kind: "reserve", description: `Maintenance reserve contribution (${spec.reserveRatePct}% of revenue)`, amount: -reserve, reference: nextRef("RSV") },
    );
    if (rand() < 0.18 && i > 0) {
      const cost = round2(spec.unitCost * 0.04 + rand() * 900);
      ledger.push({ id: `${spec.id}-${month}-mnt`, date: `${month}-15`, kind: "maintenance", description: "Component replacement (PSU/fan) — paid from reserve, not from distributable cash", amount: 0, reference: `${nextRef("WO")} · reserve draw $${cost.toFixed(2)}` });
    }
  });

  if (spec.status === "Commissioning") {
    ledger.push({ id: `${spec.id}-note`, date: `${spec.firstMonth}-01`, kind: "note", description: "Commissioning period: burn-in workloads and partial customer onboarding", amount: 0, reference: "NOTE" });
  }

  ledger.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id.localeCompare(b.id)));

  return {
    id: spec.id,
    name: spec.name,
    operator: spec.operator,
    location: spec.location,
    gpuModel: spec.gpuModel,
    units: spec.units,
    acquisitionCost,
    acquisitionDate: spec.acquisitionDate,
    status: spec.status,
    kwPerGpu: spec.kwPerGpu,
    reserveRatePct: spec.reserveRatePct,
    holderSharePct: spec.holderSharePct,
    tokenSupply: spec.tokenSupply,
    tokenSymbol: spec.tokenSymbol,
    serials: Array.from({ length: spec.units }, (_, k) => `${spec.serialPrefix}-${String(k + 1).padStart(4, "0")}`),
    description: spec.description,
    months,
    ledger,
  };
}

const file: SeedFile = {
  generatedAt: "2026-10-01T00:00:00.000Z",
  disclaimer:
    "FICTIONAL DEMO DATA. Operators, assets, serial numbers, revenue and costs are invented for a hackathon prototype and have not been independently verified.",
  pools: specs.map(build),
};

const out = resolve(__dirname, "../src/data/pools.json");
writeFileSync(out, JSON.stringify(file, null, 2) + "\n");
console.log(`Wrote ${file.pools.length} pools to ${out}`);
