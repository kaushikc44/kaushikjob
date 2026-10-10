/**
 * ComputeRWA financial engine.
 *
 * All money is handled internally as integer cents to avoid floating point
 * drift. Token balances are bigint base units (as returned by SPL Token).
 *
 * Formula (one month):
 *   netOperatingCash   = revenue - operatingExpenses            (may be negative)
 *   distributableCash  = max(0, revenue - operatingExpenses - reserve)
 *   holderPool         = floor(distributableCash * holderSharePct / 100)
 *   retainedByOperator = distributableCash - holderPool
 *   shortfall          = max(0, operatingExpenses + reserve - revenue)
 *   holderAllocation_i = holderPool * balance_i / totalSupply   (largest-remainder rounding)
 *
 * Everything this module produces is a hypothetical calculation. It does not
 * move funds and does not imply any right to receive a payment.
 */

export interface DistributionInputs {
  /** Gross monthly revenue, in dollars. */
  revenue: number;
  /** Total monthly operating expenses (power, colocation, network, ops), in dollars. */
  operatingExpenses: number;
  /** Amount set aside for maintenance / hardware replacement, in dollars. */
  reserve: number;
  /** Percentage (0–100) of distributable cash allocated to token holders. */
  holderSharePct: number;
}

export interface DistributionResult {
  revenueCents: number;
  operatingExpensesCents: number;
  reserveCents: number;
  netOperatingCashCents: number;
  distributableCashCents: number;
  holderPoolCents: number;
  retainedCents: number;
  shortfallCents: number;
}

export interface Holder {
  address: string;
  /** Token balance in base units. */
  balance: bigint;
  label?: string;
}

export interface HolderAllocation extends Holder {
  /** Share of total supply, as a percentage (display only). */
  sharePct: number;
  allocationCents: number;
}

export interface AllocationResult {
  allocations: HolderAllocation[];
  /** Cents attributable to supply not held by any listed holder (e.g. unminted treasury or unlisted accounts). */
  unallocatedCents: number;
  totalSupply: bigint;
}

export class FinanceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinanceInputError";
  }
}

/** Convert dollars to integer cents. Rejects non-finite values. */
export function toCents(dollars: number): number {
  if (!Number.isFinite(dollars)) throw new FinanceInputError("Amount must be a finite number");
  return Math.round(dollars * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/** Returns human-readable problems with the inputs; an empty array means valid. */
export function validateInputs(inputs: DistributionInputs): string[] {
  const errors: string[] = [];
  const money: [keyof DistributionInputs, string][] = [
    ["revenue", "Revenue"],
    ["operatingExpenses", "Operating expenses"],
    ["reserve", "Reserve"],
  ];
  for (const [key, label] of money) {
    const v = inputs[key];
    if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${label} must be a number`);
    else if (v < 0) errors.push(`${label} cannot be negative`);
    else if (v > 1e12) errors.push(`${label} is unrealistically large`);
  }
  const s = inputs.holderSharePct;
  if (typeof s !== "number" || !Number.isFinite(s)) errors.push("Holder share must be a number");
  else if (s < 0 || s > 100) errors.push("Holder share must be between 0 and 100%");
  return errors;
}

export function computeDistribution(inputs: DistributionInputs): DistributionResult {
  const errors = validateInputs(inputs);
  if (errors.length) throw new FinanceInputError(errors.join("; "));

  const revenueCents = toCents(inputs.revenue);
  const operatingExpensesCents = toCents(inputs.operatingExpenses);
  const reserveCents = toCents(inputs.reserve);

  const netOperatingCashCents = revenueCents - operatingExpensesCents;
  const afterReserve = netOperatingCashCents - reserveCents;
  const distributableCashCents = Math.max(0, afterReserve);
  const shortfallCents = Math.max(0, -afterReserve);
  // Basis points avoid float error from e.g. 70.1%.
  const shareBps = Math.round(inputs.holderSharePct * 100);
  const holderPoolCents = Math.floor((distributableCashCents * shareBps) / 10_000);

  return {
    revenueCents,
    operatingExpensesCents,
    reserveCents,
    netOperatingCashCents,
    distributableCashCents,
    holderPoolCents,
    retainedCents: distributableCashCents - holderPoolCents,
    shortfallCents,
  };
}

/** Reserve amount (dollars) for a reserve rate expressed as % of revenue. */
export function reserveFromRate(revenue: number, ratePct: number): number {
  if (!Number.isFinite(revenue) || !Number.isFinite(ratePct)) return 0;
  return Math.max(0, (revenue * Math.min(Math.max(ratePct, 0), 100)) / 100);
}

/**
 * Split `poolCents` across holders pro rata to their balance relative to
 * `totalSupply`. Uses the largest-remainder method so the allocations sum
 * exactly to the pro-rata total (no lost or invented cents). Ties are broken
 * by input order, so results are deterministic.
 *
 * If `totalSupply` is omitted, the sum of listed balances is used.
 */
export function allocateToHolders(
  poolCents: number,
  holders: Holder[],
  totalSupply?: bigint,
): AllocationResult {
  if (!Number.isInteger(poolCents) || poolCents < 0) {
    throw new FinanceInputError("Pool must be a non-negative whole number of cents");
  }
  for (const h of holders) {
    if (h.balance < 0n) throw new FinanceInputError(`Negative balance for ${h.address}`);
  }
  const listed = holders.reduce((acc, h) => acc + h.balance, 0n);
  const supply = totalSupply ?? listed;
  if (supply < listed) {
    throw new FinanceInputError("Total supply is smaller than the sum of holder balances");
  }
  if (supply === 0n || holders.length === 0) {
    return {
      allocations: holders.map((h) => ({ ...h, sharePct: 0, allocationCents: 0 })),
      unallocatedCents: poolCents,
      totalSupply: supply,
    };
  }

  const pool = BigInt(poolCents);
  const targetTotal = (pool * listed) / supply; // cents owed to listed holders, floored
  const floors = holders.map((h) => (pool * h.balance) / supply);
  const remainders = holders.map((h) => (pool * h.balance) % supply);
  let leftover = targetTotal - floors.reduce((a, b) => a + b, 0n);

  const order = holders
    .map((_, i) => i)
    .sort((a, b) => (remainders[b] > remainders[a] ? 1 : remainders[b] < remainders[a] ? -1 : a - b));
  const extra = new Array<bigint>(holders.length).fill(0n);
  for (const i of order) {
    if (leftover <= 0n) break;
    if (remainders[i] === 0n) break;
    extra[i] = 1n;
    leftover -= 1n;
  }

  const allocations = holders.map((h, i) => ({
    ...h,
    sharePct: Number((h.balance * 1_000_000n) / supply) / 10_000,
    allocationCents: Number(floors[i] + extra[i]),
  }));
  const allocated = allocations.reduce((a, h) => a + h.allocationCents, 0);
  return { allocations, unallocatedCents: poolCents - allocated, totalSupply: supply };
}

export function formatUsd(cents: number, opts: { compact?: boolean } = {}): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: opts.compact ? "compact" : "standard",
    maximumFractionDigits: opts.compact ? 1 : 2,
  }).format(dollars);
}
