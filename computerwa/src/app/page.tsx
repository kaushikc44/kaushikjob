import { PoolCard } from "@/components/PoolCard";
import { formatUsd } from "@/lib/finance";
import { getPools, SEED_DISCLAIMER, summarizePool } from "@/lib/pools";

export default function MarketplacePage() {
  const pools = getPools();
  const gpus = pools.reduce((a, p) => a + p.units, 0);
  const capex = pools.reduce((a, p) => a + p.acquisitionCost, 0);
  const ttmRevenue = pools.reduce((a, p) => a + summarizePool(p).totals.revenueCents, 0);
  return (
    <div className="space-y-8">
      <section className="grid gap-6 lg:grid-cols-[1.4fr_1fr] lg:items-end">
        <div>
          <p className="label text-accent">AI inference infrastructure · transparent economics</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-white md:text-4xl">
            See the GPUs, the cash flow and the math behind every distribution.
          </h1>
          <p className="mt-3 max-w-2xl text-slate-300">
            ComputeRWA links identifiable GPU asset pools to auditable revenue, cost and reserve records, and represents demo
            economic interests as SPL test tokens on Solana devnet. Use the simulator to see how net cash flow would be
            allocated across token holders.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="card p-3">
            <div className="label">Pools</div>
            <div className="text-2xl font-bold text-white">{pools.length}</div>
          </div>
          <div className="card p-3">
            <div className="label">GPUs</div>
            <div className="text-2xl font-bold text-white">{gpus}</div>
          </div>
          <div className="card p-3">
            <div className="label">Capex</div>
            <div className="text-2xl font-bold text-white">{formatUsd(capex * 100, { compact: true })}</div>
          </div>
          <p className="col-span-3 text-xs text-slate-400">
            Simulated revenue across all history: {formatUsd(ttmRevenue, { compact: true })} (fictional, unverified).
          </p>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-white">Asset pools</h2>
          <span className="text-xs text-slate-400">{SEED_DISCLAIMER}</span>
        </div>
        {pools.length === 0 ? (
          <div className="card text-center text-slate-400">No asset pools have been seeded yet. Run `npm run seed`.</div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {pools.map((p) => (
              <PoolCard key={p.id} pool={p} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
