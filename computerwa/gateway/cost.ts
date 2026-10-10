/** Estimated operating cost of a request from configurable assumptions. Never presented as measured. */
import { createHash } from "node:crypto";
import type { CostAssumptions } from "../src/lib/inference/types";

export function assumptionsId(a: CostAssumptions): string {
  const canonical = JSON.stringify([a.powerWatts, a.electricityUsdPerKwh, a.hardwareUsd, a.hardwareLifetimeHours]);
  return "cost-v1-" + createHash("sha256").update(canonical).digest("hex").slice(0, 10);
}

/**
 * Busy-time allocation: the model server's time spent on this request is
 * charged at (power × electricity price) plus hardware cost per lifetime hour.
 * Idle power and idle amortisation are not allocated to requests.
 */
export function estimateCost(busyMs: number | null, a: CostAssumptions): { costUsd: number; energyKwh: number } {
  if (!busyMs || busyMs <= 0) return { costUsd: 0, energyKwh: 0 };
  const hours = busyMs / 3_600_000;
  const energyKwh = (a.powerWatts / 1000) * hours;
  const hardware = a.hardwareLifetimeHours > 0 ? (a.hardwareUsd / a.hardwareLifetimeHours) * hours : 0;
  return { costUsd: energyKwh * a.electricityUsdPerKwh + hardware, energyKwh };
}
