import { Suspense } from "react";
import { Simulator } from "@/components/Simulator";

export const metadata = { title: "Distribution simulator · ComputeRWA (demo)" };

export default function SimulatorPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white">Distribution simulator</h1>
        <p className="mt-1 max-w-3xl text-slate-300">
          Change the month&apos;s revenue, costs, reserve and holder share to see net distributable cash and each holder&apos;s
          hypothetical allocation, pro-rata to their test-token balance.
        </p>
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          <strong>Simulation only.</strong> Allocations shown here are not payments, are not owed to anyone and do not predict
          future results. No yield is promised or guaranteed.
        </div>
      </div>
      <Suspense fallback={<div className="card h-96 animate-pulse" />}>
        <Simulator />
      </Suspense>
    </div>
  );
}
