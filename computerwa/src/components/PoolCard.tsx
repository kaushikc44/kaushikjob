import Link from "next/link";
import type { AssetPool } from "@/lib/types";
import { formatUsd } from "@/lib/finance";
import { monthLabel, STATUS_STYLE, summarizePool } from "@/lib/pools";
import { Stat } from "./Stat";

export function PoolCard({ pool }: { pool: AssetPool }) {
  const s = summarizePool(pool);
  const latest = s.latest;
  return (
    <Link href={`/pools/${pool.id}`} className="card group flex flex-col gap-4 transition hover:border-accent/60">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`badge ${STATUS_STYLE[pool.status]}`}>{pool.status}</span>
            <span className="badge bg-fuchsia-500/15 text-fuchsia-300">Fictional demo data</span>
          </div>
          <h3 className="mt-2 text-lg font-semibold text-white group-hover:text-accent">{pool.name}</h3>
          <p className="text-sm text-slate-400">{pool.location}</p>
        </div>
      </div>
      <div className="rounded-lg bg-ink-950/60 px-3 py-2 text-sm">
        <span className="font-semibold text-white">{pool.units}×</span> {pool.gpuModel}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Acquisition cost" value={formatUsd(pool.acquisitionCost * 100, { compact: true })} />
        <Stat
          label="Utilisation"
          value={latest ? `${latest.utilizationPct.toFixed(1)}%` : "—"}
          sub={latest ? monthLabel(latest.month) : "No history"}
        />
        <Stat
          label="Monthly revenue"
          value={latest ? formatUsd(latest.revenueCents, { compact: true }) : "—"}
          sub="simulated, latest month"
        />
        <Stat
          label="Distributable cash"
          value={latest ? formatUsd(latest.distributableCashCents, { compact: true }) : "—"}
          sub={latest && latest.shortfallCents > 0 ? `shortfall ${formatUsd(latest.shortfallCents, { compact: true })}` : "after opex & reserve"}
          tone={latest && latest.shortfallCents > 0 ? "warn" : undefined}
        />
      </div>
      <div className="mt-auto flex items-center justify-between text-xs text-slate-400">
        <span>{pool.months.length} months of history</span>
        <span className="text-accent">Inspect pool →</span>
      </div>
    </Link>
  );
}
