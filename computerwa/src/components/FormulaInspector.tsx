"use client";

import { useState } from "react";
import { formatUsd } from "@/lib/finance";
import { monthLabel, type MonthSummary } from "@/lib/pools";
import type { MonthlyRecord } from "@/lib/types";

export function FormulaInspector({
  months,
  records,
  holderSharePct,
  reserveRatePct,
}: {
  months: MonthSummary[];
  records: MonthlyRecord[];
  holderSharePct: number;
  reserveRatePct: number;
}) {
  const [idx, setIdx] = useState(months.length - 1);
  if (!months.length) return <p className="text-sm text-slate-400">No months to inspect.</p>;
  const m = months[idx];
  const r = records[idx];
  const row = (label: string, value: string, note?: string, strong?: boolean) => (
    <div className={`flex flex-wrap items-baseline justify-between gap-2 border-b border-ink-700/60 py-1.5 ${strong ? "font-semibold text-white" : ""}`}>
      <span>{label}</span>
      <span className="flex items-baseline gap-3">
        {note && <span className="text-xs text-slate-500">{note}</span>}
        <span className="tabular-nums">{value}</span>
      </span>
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="month" className="label">
          Month
        </label>
        <select id="month" className="input w-auto" value={idx} onChange={(e) => setIdx(Number(e.target.value))}>
          {months.map((mm, i) => (
            <option key={mm.month} value={i}>
              {monthLabel(mm.month)}
            </option>
          ))}
        </select>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-ink-950 p-3 font-mono text-xs leading-relaxed text-slate-300">
{`revenue            = units × hours × utilisation × price/GPU-hr
distributable cash = max(0, revenue − operating expenses − reserve)
holder pool        = distributable cash × holder share (${holderSharePct}%)
shortfall          = max(0, operating expenses + reserve − revenue)
holder i           = holder pool × balance_i ÷ total supply`}
      </pre>
      <div className="text-sm text-slate-300">
        {row("Revenue", formatUsd(m.revenueCents), `${m.hours}h × ${m.utilizationPct}% × $${m.pricePerGpuHour}/GPU-hr`)}
        {row("− Power", formatUsd(Math.round(r.opex.power * 100)))}
        {row("− Colocation & cooling", formatUsd(Math.round(r.opex.colocation * 100)))}
        {row("− Network", formatUsd(Math.round(r.opex.network * 100)))}
        {row("− Operations & insurance", formatUsd(Math.round(r.opex.operations * 100)))}
        {row("= Net operating cash", formatUsd(m.netOperatingCashCents), undefined, true)}
        {row("− Maintenance reserve", formatUsd(m.reserveCents), `${reserveRatePct}% of revenue`)}
        {row("= Distributable cash", formatUsd(m.distributableCashCents), m.shortfallCents ? "floored at $0" : undefined, true)}
        {row("Holder pool", formatUsd(m.holderPoolCents), `${holderSharePct}% of distributable`, true)}
        {row("Retained by operator", formatUsd(m.retainedCents))}
        {m.shortfallCents > 0 && row("Shortfall", formatUsd(m.shortfallCents), "costs + reserve exceeded revenue")}
      </div>
      <p className="text-xs text-slate-400">
        Computed in integer cents by <code className="text-slate-300">src/lib/finance.ts</code> (unit-tested). Inputs are
        off-chain, operator-reported demo figures; the result is hypothetical and is not a payment.
      </p>
    </div>
  );
}
