export type DeploymentStatus = "Deployed" | "Commissioning" | "Procurement";

export interface OpexBreakdown {
  power: number;
  colocation: number;
  network: number;
  operations: number;
}

export interface MonthlyRecord {
  /** YYYY-MM */
  month: string;
  hours: number;
  utilizationPct: number;
  pricePerGpuHour: number;
  revenue: number;
  opex: OpexBreakdown;
  reserve: number;
}

export type LedgerKind = "acquisition" | "revenue" | "expense" | "reserve" | "maintenance" | "note";

export interface LedgerEntry {
  id: string;
  date: string; // ISO date
  kind: LedgerKind;
  description: string;
  /** Positive = inflow to the pool, negative = outflow. Dollars. */
  amount: number;
  reference: string;
}

export interface AssetPool {
  id: string;
  name: string;
  operator: string;
  location: string;
  gpuModel: string;
  units: number;
  acquisitionCost: number;
  acquisitionDate: string;
  status: DeploymentStatus;
  kwPerGpu: number;
  reserveRatePct: number;
  holderSharePct: number;
  /** Demo token supply (whole tokens) that represents 100% of the holder interest. */
  tokenSupply: number;
  tokenSymbol: string;
  serials: string[];
  description: string;
  months: MonthlyRecord[];
  ledger: LedgerEntry[];
}

export interface SeedFile {
  generatedAt: string;
  disclaimer: string;
  pools: AssetPool[];
}
