import Link from "next/link";
import { notFound } from "next/navigation";
import { OffChainNote } from "@/components/Disclaimer";
import { FormulaInspector } from "@/components/FormulaInspector";
import { LedgerTable } from "@/components/LedgerTable";
import { OnChainPanel } from "@/components/OnChainPanel";
import { RevenueChart, UtilizationChart } from "@/components/PoolCharts";
import { Stat } from "@/components/Stat";
import { formatUsd } from "@/lib/finance";
import { CLUSTER } from "@/lib/solana/config";
import { getPool, getPools, monthLabel, STATUS_STYLE, summarizePool } from "@/lib/pools";

export function generateStaticParams() {
  return getPools().map((p) => ({ id: p.id }));
}

export function generateMetadata({ params }: { params: { id: string } }) {
  const pool = getPool(params.id);
  return { title: pool ? `${pool.name} · ComputeRWA (demo)` : "Pool not found · ComputeRWA" };
}

export default function PoolPage({ params }: { params: { id: string } }) {
  const pool = getPool(params.id);
  if (!pool) notFound();
  const s = summarizePool(pool);
  const latest = s.latest;
  const n = s.months.length;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-slate-400 hover:text-white">
          ← All pools
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className={`badge ${STATUS_STYLE[pool.status]}`}>{pool.status}</span>
          <span className="badge bg-fuchsia-500/15 text-fuchsia-300">Fictional demo data</span>
        </div>
        <h1 className="mt-2 text-3xl font-bold text-white">{pool.name}</h1>
        <p className="mt-1 max-w-3xl text-slate-300">{pool.description}</p>
      </div>

      <section className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Hardware" value={`${pool.units}× GPU`} sub={pool.gpuModel} />
        <Stat label="Acquisition cost" value={formatUsd(pool.acquisitionCost * 100, { compact: true })} sub={pool.acquisitionDate} />
        <Stat label="Latest utilisation" value={latest ? `${latest.utilizationPct.toFixed(1)}%` : "—"} sub={latest ? monthLabel(latest.month) : undefined} />
        <Stat label="Latest revenue" value={latest ? formatUsd(latest.revenueCents, { compact: true }) : "—"} sub="simulated" />
        <Stat
          label="Latest distributable"
          value={latest ? formatUsd(latest.distributableCashCents, { compact: true }) : "—"}
          sub={latest?.shortfallCents ? `shortfall ${formatUsd(latest.shortfallCents, { compact: true })}` : `holder share ${pool.holderSharePct}%`}
          tone={latest?.shortfallCents ? "warn" : undefined}
        />
        <Stat label={`${n}-mo distributable`} value={formatUsd(s.totals.distributableCashCents, { compact: true })} sub="historical, simulated — not a forecast" />
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.25fr_1fr]">
        <div className="min-w-0 space-y-6">
          <section className="card">
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold text-white">Where the revenue went</h2>
              <span className="text-xs text-slate-400">Monthly, USD</span>
            </div>
            <OffChainNote />
            <div className="mt-3">
              <RevenueChart months={s.months} />
            </div>
          </section>
          <section className="card">
            <h2 className="mb-1 text-lg font-semibold text-white">GPU utilisation</h2>
            <OffChainNote>Share of available GPU-hours sold, as reported by the (fictional) operator.</OffChainNote>
            <div className="mt-3">
              <UtilizationChart months={s.months} />
            </div>
          </section>
          <section className="card overflow-x-auto">
            <h2 className="mb-3 text-lg font-semibold text-white">Monthly financial report</h2>
            <table className="w-full min-w-[640px] text-right text-sm tabular-nums">
              <thead className="text-xs uppercase text-slate-400">
                <tr>
                  <th className="py-2 text-left font-medium">Month</th>
                  <th className="font-medium">Util.</th>
                  <th className="font-medium">Revenue</th>
                  <th className="font-medium">Opex</th>
                  <th className="font-medium">Reserve</th>
                  <th className="font-medium">Distributable</th>
                  <th className="font-medium">Holder pool</th>
                </tr>
              </thead>
              <tbody>
                {[...s.months].reverse().map((m) => (
                  <tr key={m.month} className="border-t border-ink-700/60">
                    <td className="py-2 text-left">{monthLabel(m.month)}</td>
                    <td>{m.utilizationPct.toFixed(1)}%</td>
                    <td>{formatUsd(m.revenueCents)}</td>
                    <td className="text-slate-400">{formatUsd(m.operatingExpensesCents)}</td>
                    <td className="text-slate-400">{formatUsd(m.reserveCents)}</td>
                    <td className={m.shortfallCents ? "text-amber-300" : ""}>{formatUsd(m.distributableCashCents)}</td>
                    <td>{formatUsd(m.holderPoolCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-ink-600 font-semibold text-white">
                <tr>
                  <td className="py-2 text-left">Total</td>
                  <td>{s.avgUtil.toFixed(1)}%</td>
                  <td>{formatUsd(s.totals.revenueCents)}</td>
                  <td>{formatUsd(s.totals.operatingExpensesCents)}</td>
                  <td>{formatUsd(s.totals.reserveCents)}</td>
                  <td>{formatUsd(s.totals.distributableCashCents)}</td>
                  <td>{formatUsd(s.totals.holderPoolCents)}</td>
                </tr>
              </tfoot>
            </table>
          </section>
          <section className="card">
            <h2 className="mb-3 text-lg font-semibold text-white">Inspect the distributable-cash formula</h2>
            <FormulaInspector months={s.months} records={pool.months} holderSharePct={pool.holderSharePct} reserveRatePct={pool.reserveRatePct} />
          </section>
          <section className="card">
            <h2 className="mb-3 text-lg font-semibold text-white">Transaction &amp; accounting history</h2>
            <LedgerTable entries={pool.ledger} />
          </section>
        </div>

        <div className="min-w-0 space-y-6">
          <section className="card">
            <h2 className="mb-3 text-lg font-semibold text-white">Solana {CLUSTER}</h2>
            <OnChainPanel pool={pool} />
            <Link href={`/simulator?pool=${pool.id}`} className="btn-primary mt-4 w-full">
              Simulate a distribution with these holders →
            </Link>
          </section>
          <section className="card space-y-3">
            <h2 className="text-lg font-semibold text-white">Asset record (off-chain)</h2>
            <OffChainNote>Identifiers below are invented. A production system would attest to them via operator and auditor signatures.</OffChainNote>
            <dl className="grid grid-cols-[140px_1fr] gap-y-1.5 text-sm">
              <dt className="text-slate-400">Pool ID</dt>
              <dd className="mono">{pool.id}</dd>
              <dt className="text-slate-400">Operator</dt>
              <dd>{pool.operator}</dd>
              <dt className="text-slate-400">Location</dt>
              <dd>{pool.location}</dd>
              <dt className="text-slate-400">GPU model</dt>
              <dd>{pool.gpuModel}</dd>
              <dt className="text-slate-400">Power / GPU</dt>
              <dd>{pool.kwPerGpu} kW</dd>
              <dt className="text-slate-400">Reserve rate</dt>
              <dd>{pool.reserveRatePct}% of revenue</dd>
              <dt className="text-slate-400">Holder share</dt>
              <dd>{pool.holderSharePct}% of distributable cash</dd>
              <dt className="text-slate-400">Demo token</dt>
              <dd>
                {pool.tokenSymbol} · {pool.tokenSupply.toLocaleString()} units = 100% of holder share
              </dd>
            </dl>
            <details className="text-sm">
              <summary className="cursor-pointer text-slate-300">Serial numbers ({pool.serials.length})</summary>
              <div className="mt-2 grid max-h-48 grid-cols-2 gap-1 overflow-y-auto font-mono text-xs text-slate-400 sm:grid-cols-3">
                {pool.serials.map((sn) => (
                  <span key={sn}>{sn}</span>
                ))}
              </div>
            </details>
          </section>
        </div>
      </div>
    </div>
  );
}
