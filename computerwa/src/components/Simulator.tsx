"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { allocateToHolders, computeDistribution, formatUsd, type Holder, validateInputs } from "@/lib/finance";
import { getPools, monthLabel, totalOpex } from "@/lib/pools";
import { usePoolChainState } from "@/lib/solana/useChainState";
import { hypotheticalPaidRevenue, liveActualInputs } from "@/lib/inference/accounting";
import { useInferenceStatus } from "@/lib/inference/useInferenceStatus";
import { CLUSTER } from "@/lib/solana/config";
import { AddressLink } from "./TxLink";

const pools = getPools();

interface DemoHolder {
  label: string;
  balance: string;
}

type Scenario = "seed" | "live_actual" | "live_hypothetical";

const SCENARIO_LABEL: Record<Scenario, { text: string; cls: string }> = {
  seed: { text: "Seeded pool data (fictional)", cls: "bg-fuchsia-500/15 text-fuchsia-300" },
  live_actual: { text: "Live usage · actual — revenue = recorded payments ($0)", cls: "bg-sky-500/15 text-sky-300" },
  live_hypothetical: { text: "HYPOTHETICAL paid-inference scenario — not actual revenue", cls: "bg-amber-500/20 text-amber-200" },
};

const DEFAULT_DEMO: DemoHolder[] = [
  { label: "Demo holder A", balance: "400000" },
  { label: "Demo holder B", balance: "250000" },
  { label: "Demo holder C", balance: "100000" },
];

export function Simulator() {
  const params = useSearchParams();
  const router = useRouter();
  const poolId = params.get("pool") && pools.some((p) => p.id === params.get("pool")) ? params.get("pool")! : pools[0].id;
  const pool = pools.find((p) => p.id === poolId)!;
  const chain = usePoolChainState(pool.id);

  const [monthIdx, setMonthIdx] = useState(pool.months.length - 1);
  const [revenue, setRevenue] = useState("0");
  const [opex, setOpex] = useState("0");
  const [reserve, setReserve] = useState("0");
  const [share, setShare] = useState("0");
  const [source, setSource] = useState<"chain" | "demo">("demo");
  const [demo, setDemo] = useState<DemoHolder[]>(DEFAULT_DEMO);
  const [scenario, setScenario] = useState<Scenario>("seed");
  const [edited, setEdited] = useState(false);
  const [priceIn, setPriceIn] = useState("0.10");
  const [priceOut, setPriceOut] = useState("0.40");
  const live = useInferenceStatus("30", 0);
  const liveSummary = live.status?.summary ?? null;
  const hypo = liveSummary
    ? hypotheticalPaidRevenue(liveSummary, { usdPerMillionInputTokens: num(priceIn), usdPerMillionOutputTokens: num(priceOut) })
    : null;
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    setEdited(true);
  };

  const applyLiveActual = () => {
    if (!liveSummary) return;
    const i = liveActualInputs(liveSummary);
    setRevenue(String(i.revenue));
    setOpex(String(i.operatingExpenses));
    setReserve(String(i.reserve));
    setScenario("live_actual");
    setEdited(false);
  };
  const applyHypothetical = () => {
    if (!liveSummary || !hypo) return;
    const i = liveActualInputs(liveSummary);
    setRevenue(String(Math.round(hypo.revenueUsd * 100) / 100));
    setOpex(String(i.operatingExpenses));
    setReserve(String(i.reserve));
    setScenario("live_hypothetical");
    setEdited(false);
  };

  const loadMonth = (i: number) => {
    const m = pool.months[i];
    if (!m) return;
    setMonthIdx(i);
    setRevenue(String(m.revenue));
    setOpex(totalOpex(m).toFixed(2));
    setReserve(String(m.reserve));
    setShare(String(pool.holderSharePct));
    setScenario("seed");
    setEdited(false);
  };

  useEffect(() => {
    loadMonth(pool.months.length - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool.id]);

  // Arriving from /inference: start from live actual usage once it loads.
  const wantsLive = params.get("source") === "live";
  useEffect(() => {
    if (wantsLive && liveSummary && scenario === "seed" && !edited) applyLiveActual();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsLive, liveSummary]);

  useEffect(() => {
    setSource(chain.mintState && chain.mintState.holders.length ? "chain" : "demo");
  }, [chain.mintState]);

  const inputs = { revenue: num(revenue), operatingExpenses: num(opex), reserve: num(reserve), holderSharePct: num(share) };
  const errors = validateInputs(inputs);
  const result = errors.length ? null : computeDistribution(inputs);

  const { holders, supply, holderError } = useMemo(() => {
    if (source === "chain" && chain.mintState) {
      return {
        holders: chain.mintState.holders.map<Holder>((h) => ({ address: h.owner, balance: h.balance })),
        supply: chain.mintState.supply,
        holderError: null as string | null,
      };
    }
    const out: Holder[] = [];
    for (const [i, d] of demo.entries()) {
      if (!/^\d+$/.test(d.balance.trim())) return { holders: [], supply: 0n, holderError: `Balance for “${d.label || `row ${i + 1}`}” must be a whole number` };
      out.push({ address: `demo-${i}`, label: d.label || `Holder ${i + 1}`, balance: BigInt(d.balance.trim()) });
    }
    const listed = out.reduce((a, h) => a + h.balance, 0n);
    const s = BigInt(pool.tokenSupply);
    if (listed > s) return { holders: [], supply: s, holderError: `Balances total ${listed.toLocaleString()}, more than the ${s.toLocaleString()} token supply` };
    return { holders: out, supply: s, holderError: null };
  }, [source, chain.mintState, demo, pool.tokenSupply]);

  const alloc = result && !holderError ? allocateToHolders(result.holderPoolCents, holders, supply) : null;
  const reservePct = inputs.revenue > 0 ? (inputs.reserve / inputs.revenue) * 100 : 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      <section className="card min-w-0 space-y-4">
        <div>
          <label className="label" htmlFor="pool">
            Asset pool
          </label>
          <select id="pool" className="input mt-1" value={pool.id} onChange={(e) => router.replace(`/simulator?pool=${e.target.value}`)}>
            {pools.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="month">
            Start from reported month
          </label>
          <select id="month" className="input mt-1" value={monthIdx} onChange={(e) => loadMonth(Number(e.target.value))}>
            {pool.months.map((m, i) => (
              <option key={m.month} value={i}>
                {monthLabel(m.month)}
              </option>
            ))}
          </select>
        </div>
        <LivePanel
          status={live.status?.health ?? null}
          loading={live.loading}
          summary={liveSummary}
          priceIn={priceIn}
          priceOut={priceOut}
          setPriceIn={setPriceIn}
          setPriceOut={setPriceOut}
          hypoRevenue={hypo?.revenueUsd ?? null}
          hypoCoverage={hypo ? `${hypo.pricedRequests} priced · ${hypo.unpricedRequests} without token counts (excluded)` : null}
          onActual={applyLiveActual}
          onHypothetical={applyHypothetical}
        />
        <MoneyInput id="revenue" label={scenario === "seed" ? "Monthly revenue (USD)" : scenario === "live_actual" ? "Revenue (USD) — recorded payments" : "Revenue (USD) — HYPOTHETICAL"} value={revenue} onChange={edit(setRevenue)} />
        <MoneyInput id="opex" label={scenario === "seed" ? "Operating expenses (USD)" : "Operating expenses (USD) — estimated"} value={opex} onChange={edit(setOpex)} />
        <MoneyInput id="reserve" label="Maintenance reserve (USD)" value={reserve} onChange={edit(setReserve)} hint={`${reservePct.toFixed(1)}% of revenue`} />
        <div>
          <div className="flex items-baseline justify-between">
            <label className="label" htmlFor="share">
              Allocated to token holders
            </label>
            <span className="text-sm tabular-nums text-white">{share || 0}%</span>
          </div>
          <input id="share" type="range" min={0} max={100} step={1} value={num(share) || 0} onChange={(e) => edit(setShare)(e.target.value)} className="mt-2 w-full accent-teal-300" />
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost py-1 text-xs" onClick={() => loadMonth(monthIdx)}>
            Reset to seeded month
          </button>
          <button className="btn-ghost py-1 text-xs" onClick={() => edit(setRevenue)(String(Math.round(num(revenue) * 0.6)))}>
            Stress: −40% revenue
          </button>
          <button className="btn-ghost py-1 text-xs" onClick={() => edit(setOpex)(String(Math.round(num(opex) * 1.25)))}>
            Stress: +25% opex
          </button>
        </div>
        {errors.length > 0 && (
          <ul role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </section>

      <div className="min-w-0 space-y-6">
        <section className="card">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-white">Net distributable cash</h2>
            <span data-testid="scenario-label" className={`badge ${SCENARIO_LABEL[scenario].cls}`}>
              {SCENARIO_LABEL[scenario].text}
              {edited ? " · manually edited" : ""}
            </span>
          </div>
          {result ? (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <Big label="Net operating cash" value={formatUsd(result.netOperatingCashCents)} sub="revenue − opex" />
              <Big label="Distributable cash" value={formatUsd(result.distributableCashCents)} sub="after reserve, floored at $0" />
              <Big label="Holder pool" value={formatUsd(result.holderPoolCents)} sub={`${share}% of distributable`} accent />
              <Big label="Retained by operator" value={formatUsd(result.retainedCents)} sub="remaining distributable" />
            </div>
          ) : (
            <p className="text-sm text-slate-400">Fix the inputs to see results.</p>
          )}
          {result && result.shortfallCents > 0 && (
            <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-200">
              Costs plus reserve exceed revenue by {formatUsd(result.shortfallCents)}. Nothing would be distributable this month.
            </p>
          )}
        </section>

        <section className="card space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-white">Hypothetical allocation by holder</h2>
            <div className="flex rounded-lg border border-ink-600 p-0.5 text-xs">
              <button
                className={`rounded-md px-3 py-1 ${source === "chain" ? "bg-ink-700 text-white" : "text-slate-400"}`}
                onClick={() => setSource("chain")}
                disabled={!chain.mintState}
                title={chain.mintState ? "" : "Create or load a test mint on the pool page first"}
              >
                On-chain balances ({CLUSTER})
              </button>
              <button className={`rounded-md px-3 py-1 ${source === "demo" ? "bg-ink-700 text-white" : "text-slate-400"}`} onClick={() => setSource("demo")}>
                Demo holders
              </button>
            </div>
          </div>

          {source === "chain" && chain.mintState && (
            <p className="text-xs text-slate-400">
              <span className="badge mr-1 bg-sky-500/15 text-sky-300">on-chain</span>
              Balances read from mint <AddressLink address={chain.mintState.mint} /> at slot {chain.mintState.slot}. Total supply{" "}
              {chain.mintState.supply.toLocaleString()}.
            </p>
          )}
          {source === "chain" && !chain.mintState && (
            <p className="text-sm text-slate-400">{chain.loading ? "Loading on-chain holders…" : "No test mint found for this pool. Create one on the pool page."}</p>
          )}
          {source === "demo" && (
            <div className="space-y-2">
              <p className="text-xs text-slate-400">
                <span className="badge mr-1 bg-slate-500/20 text-slate-300">local</span>
                Editable hypothetical holders. Token supply {pool.tokenSupply.toLocaleString()}; any unheld supply is treated as
                unallocated.
              </p>
              {demo.map((d, i) => (
                <div key={i} className="flex gap-2">
                  <input className="input" value={d.label} aria-label={`Holder ${i + 1} name`} onChange={(e) => setDemo((ds) => ds.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                  <input className="input w-40" inputMode="numeric" value={d.balance} aria-label={`Holder ${i + 1} balance`} onChange={(e) => setDemo((ds) => ds.map((x, j) => (j === i ? { ...x, balance: e.target.value } : x)))} />
                  <button className="btn-ghost px-2 py-1" onClick={() => setDemo((ds) => ds.filter((_, j) => j !== i))} aria-label={`Remove holder ${i + 1}`}>
                    ✕
                  </button>
                </div>
              ))}
              <button className="btn-ghost py-1 text-xs" onClick={() => setDemo((ds) => [...ds, { label: `Demo holder ${String.fromCharCode(65 + ds.length)}`, balance: "0" }])}>
                + Holder
              </button>
            </div>
          )}

          {holderError && <p role="alert" className="text-sm text-rose-300">{holderError}</p>}

          {alloc && holders.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm tabular-nums">
                <thead className="text-xs uppercase text-slate-400">
                  <tr>
                    <th className="py-2 text-left font-medium">Holder</th>
                    <th className="text-right font-medium">Balance</th>
                    <th className="text-right font-medium">Share of supply</th>
                    <th className="text-right font-medium">Hypothetical allocation</th>
                  </tr>
                </thead>
                <tbody>
                  {alloc.allocations.map((a) => (
                    <tr key={a.address} className="border-t border-ink-700/60">
                      <td className="py-2">{a.label ?? <AddressLink address={a.address} />}</td>
                      <td className="text-right">{a.balance.toLocaleString()}</td>
                      <td className="text-right">{a.sharePct.toFixed(2)}%</td>
                      <td className="text-right font-semibold text-white">{formatUsd(a.allocationCents)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-ink-700/60 text-slate-400">
                    <td className="py-2">Unheld / unallocated supply</td>
                    <td className="text-right">{(alloc.totalSupply - holders.reduce((s, h) => s + h.balance, 0n)).toLocaleString()}</td>
                    <td />
                    <td className="text-right">{formatUsd(alloc.unallocatedCents)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-2 text-xs text-slate-400">
                Allocation = holder pool × balance ÷ total supply, rounded to cents with the largest-remainder method so the
                rows sum exactly to the pool.
              </p>
            </div>
          )}
          {alloc && holders.length === 0 && !holderError && <p className="text-sm text-slate-400">No holders to allocate to.</p>}
        </section>
      </div>
    </div>
  );
}

function num(s: string): number {
  if (s.trim() === "") return Number.NaN;
  return Number(s);
}

function MoneyInput({ id, label, value, onChange, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label className="label" htmlFor={id}>
          {label}
        </label>
        {hint && <span className="text-xs text-slate-400">{hint}</span>}
      </div>
      <input id={id} className="input mt-1 tabular-nums" type="number" inputMode="decimal" min={0} step="0.01" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function Big({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${accent ? "border-accent/50 bg-accent/5" : "border-ink-700 bg-ink-950/60"}`}>
      <div className="label">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${accent ? "text-accent" : "text-white"}`}>{value}</div>
      <div className="text-xs text-slate-400">{sub}</div>
    </div>
  );
}

function LivePanel(p: {
  status: string | null;
  loading: boolean;
  summary: import("@/lib/inference/types").UsageSummary | null;
  priceIn: string;
  priceOut: string;
  setPriceIn: (v: string) => void;
  setPriceOut: (v: string) => void;
  hypoRevenue: number | null;
  hypoCoverage: string | null;
  onActual: () => void;
  onHypothetical: () => void;
}) {
  const s = p.summary;
  return (
    <details className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3" open>
      <summary className="cursor-pointer text-sm font-semibold text-white">Live inference usage (Mac mini · last 30 days)</summary>
      <div className="mt-2 space-y-2 text-xs text-slate-300">
        {p.loading && !s && <p className="text-slate-400">Loading live usage…</p>}
        {!p.loading && !s && (
          <p className="text-slate-400">
            Live usage unavailable ({p.status === "not_configured" ? "gateway not configured" : p.status === "offline" ? "gateway offline" : "no summary"}). Nothing is estimated in its place.
          </p>
        )}
        {s && (
          <>
            <p>
              {s.requests.success.toLocaleString()} successful requests · {s.tokens.inputTokens.toLocaleString()} in / {s.tokens.outputTokens.toLocaleString()} out tokens (measured) · est. cost ${s.estimated.operatingCostUsd.toFixed(4)}
            </p>
            <button className="btn-ghost w-full py-1 text-xs" onClick={p.onActual}>
              Load actual: revenue $0 (no payments), opex = estimated cost
            </button>
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
              <p className="mb-1 font-semibold text-amber-200">Hypothetical paid scenario</p>
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="text-slate-400">$ / 1M input tokens</span>
                  <input className="input py-1" type="number" min={0} step="0.01" value={p.priceIn} onChange={(e) => p.setPriceIn(e.target.value)} />
                </label>
                <label className="space-y-1">
                  <span className="text-slate-400">$ / 1M output tokens</span>
                  <input className="input py-1" type="number" min={0} step="0.01" value={p.priceOut} onChange={(e) => p.setPriceOut(e.target.value)} />
                </label>
              </div>
              {p.hypoRevenue === null ? (
                <p className="mt-1 text-slate-400">No runtime-reported token counts to price (or invalid prices). Token counts are never estimated.</p>
              ) : (
                <>
                  <p className="mt-1 text-slate-400">Would-be revenue ${p.hypoRevenue < 0.01 ? p.hypoRevenue.toFixed(6) : p.hypoRevenue.toFixed(2)} ({p.hypoCoverage}); the simulator rounds to whole cents. Illustrative prices, not an offer.</p>
                  <button className="btn-ghost mt-1 w-full py-1 text-xs" onClick={p.onHypothetical}>
                    Load HYPOTHETICAL scenario
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </details>
  );
}
