"use client";

import Link from "next/link";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts";
import type { GatewayHealth, UsageSummary } from "@/lib/inference/types";
import { type RangeOption, useInferenceStatus } from "@/lib/inference/useInferenceStatus";

const RANGES: { v: RangeOption; label: string }[] = [
  { v: "1", label: "24h" },
  { v: "7", label: "7d" },
  { v: "30", label: "30d" },
  { v: "90", label: "90d" },
  { v: "all", label: "All" },
];

const HEALTH: Record<GatewayHealth, { label: string; cls: string; dot: string }> = {
  online: { label: "Online · model ready", cls: "bg-emerald-500/15 text-emerald-300", dot: "bg-emerald-400" },
  degraded: { label: "Degraded", cls: "bg-amber-500/15 text-amber-300", dot: "bg-amber-400" },
  offline: { label: "Offline", cls: "bg-rose-500/15 text-rose-300", dot: "bg-rose-400" },
  not_configured: { label: "Not configured", cls: "bg-slate-500/20 text-slate-300", dot: "bg-slate-400" },
};

const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString());
const usd = (v: number) => (v < 0.01 && v > 0 ? `$${v.toFixed(5)}` : `$${v.toFixed(2)}`);
const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

export function LiveInference() {
  const [range, setRange] = useState<RangeOption>("30");
  const { status, loading, fetchError, reload } = useInferenceStatus(range);
  const s = status?.summary ?? null;
  const h = status ? HEALTH[status.health] : null;

  return (
    <div className="space-y-6">
      <section className="card flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {h ? (
            <span className={`badge gap-2 px-3 py-1 text-sm ${h.cls}`}>
              <span className={`h-2 w-2 rounded-full ${h.dot}`} />
              API {h.label}
            </span>
          ) : (
            <span className="badge bg-ink-700 px-3 py-1 text-sm text-slate-300">Checking…</span>
          )}
          {status?.readiness && <span className="text-xs text-slate-400">model “{status.readiness.model}” · {status.readiness.status === "ready" ? "ready" : status.readiness.reason}</span>}
          <span className="text-xs text-slate-500">checked {fmtTime(status?.checkedAt ?? null)}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-ink-600 p-0.5 text-xs" role="group" aria-label="Date range">
            {RANGES.map((r) => (
              <button key={r.v} onClick={() => setRange(r.v)} className={`rounded-md px-3 py-1 ${range === r.v ? "bg-ink-700 text-white" : "text-slate-400"}`}>
                {r.label}
              </button>
            ))}
          </div>
          <button className="btn-ghost py-1 text-xs" onClick={() => reload()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </section>

      {(fetchError || status?.error) && (
        <div role="alert" className={`rounded-lg border p-3 text-sm ${status?.health === "offline" ? "border-rose-500/40 bg-rose-500/10 text-rose-200" : "border-amber-500/30 bg-amber-500/10 text-amber-200"}`}>
          {fetchError ?? status?.error}
          {status?.health === "not_configured" && (
            <span className="block text-xs text-slate-400">Set INFERENCE_GATEWAY_URL and INFERENCE_GATEWAY_READ_KEY on the server (see README).</span>
          )}
        </div>
      )}

      {s ? <SummaryView s={s} /> : !loading && <EmptyState />}

      <section className="card space-y-2">
        <h2 className="text-lg font-semibold text-white">Call the API from another device</h2>
        <p className="text-sm text-slate-400">OpenAI-compatible. Ask the operator for an API key. Requests without a valid key are rejected.</p>
        <pre className="overflow-x-auto rounded-lg bg-ink-950 p-3 font-mono text-xs text-slate-300">{`curl https://<your-gateway-host>/v1/chat/completions \\
  -H "Authorization: Bearer $COMPUTERWA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"messages":[{"role":"user","content":"Explain GPU utilisation in one sentence."}],"max_tokens":128}'`}</pre>
        <p className="text-xs text-slate-500">Prompts and responses pass through the gateway and are not stored; only request metadata is logged.</p>
      </section>
    </div>
  );
}

function EmptyState() {
  return <div className="card text-center text-sm text-slate-400">No usage data available for this view.</div>;
}

function Tile({ label, value, sub, kind }: { label: string; value: string; sub?: string; kind: "measured" | "estimated" | "recorded" }) {
  const tag =
    kind === "measured" ? "bg-sky-500/15 text-sky-300" : kind === "estimated" ? "bg-orange-500/15 text-orange-300" : "bg-emerald-500/15 text-emerald-300";
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-950/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="label">{label}</span>
        <span className={`badge ${tag}`}>{kind}</span>
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-white">{value}</div>
      {sub && <div className="text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

function SummaryView({ s }: { s: UsageSummary }) {
  const failures = s.requests.total - s.requests.success;
  const a = s.estimated.assumptions;
  return (
    <>
      <section className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Tile kind="measured" label="Requests" value={n(s.requests.total)} sub={`${n(failures)} not successful`} />
        <Tile kind="measured" label="Successful" value={n(s.requests.success)} sub={s.requests.total ? `${((s.requests.success / s.requests.total) * 100).toFixed(1)}% of requests` : "no requests yet"} />
        <Tile kind="measured" label="Latency p50 / p95" value={s.latencyMs.p50 === null ? "—" : `${n(s.latencyMs.p50)} / ${n(s.latencyMs.p95)} ms`} sub={`gateway end-to-end · ${n(s.latencyMs.count)} samples`} />
        <Tile kind="measured" label="Tokens in / out" value={`${n(s.tokens.inputTokens)} / ${n(s.tokens.outputTokens)}`} sub={`${n(s.tokens.requestsWithUsage)} reported · ${n(s.tokens.requestsWithoutUsage)} without counts`} />
        <Tile kind="estimated" label="Operating cost" value={usd(s.estimated.operatingCostUsd)} sub={`${(s.estimated.energyKwh * 1000).toFixed(2)} Wh est.`} />
        <Tile kind="recorded" label="Customer revenue" value="$0.00" sub={`${s.revenue.paymentRecords} payment records`} />
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section className="card min-w-0">
          <h2 className="mb-1 text-lg font-semibold text-white">Requests per day</h2>
          <p className="text-xs text-slate-400">Measured, UTC days, all outcomes.</p>
          {s.byDay.length ? <DailyChart rows={s.byDay} /> : <p className="py-10 text-center text-sm text-slate-400">No requests in this range.</p>}
        </section>
        <section className="card min-w-0 space-y-3 text-sm">
          <h2 className="text-lg font-semibold text-white">Outcomes</h2>
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 tabular-nums">
            <dt className="text-slate-400">Success</dt><dd>{n(s.requests.success)}</dd>
            <dt className="text-slate-400">Client errors (4xx)</dt><dd>{n(s.requests.clientErrors)}</dd>
            <dt className="text-slate-400">Rate / concurrency limited</dt><dd>{n(s.requests.rateLimited)}</dd>
            <dt className="text-slate-400">Model server offline</dt><dd>{n(s.requests.upstreamUnavailable)}</dd>
            <dt className="text-slate-400">Model timeouts</dt><dd>{n(s.requests.upstreamTimeouts)}</dd>
            <dt className="text-slate-400">Model errors</dt><dd>{n(s.requests.upstreamErrors)}</dd>
            <dt className="text-slate-400">Duplicate retries rejected</dt><dd>{n(s.requests.duplicatesRejected)}</dd>
            <dt className="text-slate-400">Unauthenticated (since restart)</dt><dd>{n(s.unauthenticatedRejectedSinceStart)}</dd>
          </dl>
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card space-y-2 text-sm">
          <h2 className="text-lg font-semibold text-white">Cost estimate assumptions</h2>
          <p className="text-xs text-slate-400">{s.estimated.basis}</p>
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 tabular-nums">
            <dt className="text-slate-400">Power while generating</dt><dd>{a.powerWatts} W</dd>
            <dt className="text-slate-400">Electricity</dt><dd>${a.electricityUsdPerKwh}/kWh</dd>
            <dt className="text-slate-400">Hardware amortised</dt><dd>{a.hardwareUsd ? `$${a.hardwareUsd} over ${a.hardwareLifetimeHours.toLocaleString()} busy h` : "off"}</dd>
            <dt className="text-slate-400">Assumption set</dt><dd className="font-mono text-xs">{s.estimated.assumptionsId}</dd>
          </dl>
          <p className="text-xs text-slate-500">{a.note}</p>
        </section>
        <section className="card space-y-2 text-sm">
          <h2 className="text-lg font-semibold text-white">Data source</h2>
          <dl className="grid grid-cols-[130px_1fr] gap-y-1">
            <dt className="text-slate-400">Source</dt><dd>{s.source.system}: {s.source.ledger}</dd>
            <dt className="text-slate-400">Model</dt><dd>{s.model}</dd>
            <dt className="text-slate-400">Range</dt><dd>{s.range.from ? `${fmtTime(s.range.from)} → ${fmtTime(s.range.to)}` : `All records → ${fmtTime(s.range.to)}`}</dd>
            <dt className="text-slate-400">Records span</dt><dd>{s.range.firstRecordAt ? `${fmtTime(s.range.firstRecordAt)} → ${fmtTime(s.range.lastRecordAt)}` : "no records"}</dd>
            <dt className="text-slate-400">Generated</dt><dd>{fmtTime(s.source.generatedAt)}</dd>
            <dt className="text-slate-400">Tokens</dt><dd className="text-xs text-slate-400">{s.tokens.source}</dd>
            <dt className="text-slate-400">Revenue</dt><dd className="text-xs text-slate-400">{s.revenue.note}</dd>
          </dl>
          <Link href="/simulator?source=live" className="btn-primary mt-2 w-full">
            Use this usage in the distribution simulator →
          </Link>
        </section>
      </div>
    </>
  );
}

function DayTip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload as UsageSummary["byDay"][number];
  return (
    <div className="rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-xs shadow-xl">
      <div className="text-slate-400">{label}</div>
      <div className="font-semibold tabular-nums text-white">{r.requests} requests</div>
      <div className="text-slate-400">{r.success} successful · {r.outputTokens.toLocaleString()} output tokens</div>
      <div className="text-slate-400">est. cost {usd(r.estimatedCostUsd)}</div>
    </div>
  );
}

function DailyChart({ rows }: { rows: UsageSummary["byDay"] }) {
  return (
    <div className="mt-3 h-56" role="img" aria-label="Requests per day">
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#1a2540" vertical={false} />
          <XAxis dataKey="date" stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(d: string) => d.slice(5)} />
          <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
          <Tooltip content={<DayTip />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
          <Bar dataKey="requests" fill="#3987e5" radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
