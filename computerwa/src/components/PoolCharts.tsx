"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import { formatUsd } from "@/lib/finance";
import { monthLabel, type MonthSummary } from "@/lib/pools";

// Validated dark-mode categorical slots (blue, orange, aqua) on the ink-900 surface.
const C = { opex: "#3987e5", reserve: "#d95926", dist: "#199e70", util: "#3987e5", grid: "#1a2540", axis: "#94a3b8" };
const SERIES = [
  { key: "opex", name: "Operating expenses", color: C.opex },
  { key: "reserve", name: "Maintenance reserve", color: C.reserve },
  { key: "dist", name: "Distributable cash", color: C.dist },
] as const;

type Row = { label: string; revenue: number; opex: number; reserve: number; dist: number; shortfall: number; util: number };

function toRows(months: MonthSummary[]): Row[] {
  return months.map((m) => ({
    label: monthLabel(m.month),
    revenue: m.revenueCents,
    opex: m.operatingExpensesCents,
    reserve: m.reserveCents,
    dist: m.distributableCashCents,
    shortfall: m.shortfallCents,
    util: m.utilizationPct,
  }));
}

function MoneyTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload as Row;
  return (
    <div className="rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-xs shadow-xl">
      <div className="mb-1 text-slate-400">{label}</div>
      <div className="mb-1 flex justify-between gap-6">
        <span className="font-semibold tabular-nums text-white">{formatUsd(row.revenue)}</span>
        <span className="text-slate-400">Revenue</span>
      </div>
      {SERIES.map((s) => (
        <div key={s.key} className="flex items-center justify-between gap-6">
          <span className="flex items-center gap-2">
            <span className="inline-block h-0.5 w-3" style={{ background: s.color }} />
            <span className="font-semibold tabular-nums text-white">{formatUsd(row[s.key])}</span>
          </span>
          <span className="text-slate-400">{s.name}</span>
        </div>
      ))}
      {row.shortfall > 0 && <div className="mt-1 text-amber-300">Shortfall {formatUsd(row.shortfall)} — no distribution</div>}
    </div>
  );
}

const axisProps = { stroke: C.axis, fontSize: 11, tickLine: false, axisLine: false } as const;

export function RevenueChart({ months }: { months: MonthSummary[] }) {
  if (!months.length) return <EmptyChart />;
  const rows = toRows(months);
  return (
    <div className="h-72" role="img" aria-label="Monthly revenue split into operating expenses, reserve and distributable cash">
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
          <CartesianGrid stroke={C.grid} vertical={false} />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis {...axisProps} width={56} tickFormatter={(v: number) => formatUsd(v, { compact: true })} />
          <Tooltip content={<MoneyTooltip />} cursor={{ fill: "rgba(148,163,184,0.08)" }} />
          <Legend wrapperStyle={{ fontSize: 12, color: "#cbd5e1" }} iconType="rect" />
          {SERIES.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.name}
              stackId="a"
              fill={s.color}
              stroke="#0b1220"
              strokeWidth={1}
              radius={i === SERIES.length - 1 ? [4, 4, 0, 0] : 0}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function UtilTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload as Row;
  return (
    <div className="rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-xs shadow-xl">
      <div className="text-slate-400">{label}</div>
      <div className="font-semibold tabular-nums text-white">{row.util.toFixed(1)}% utilisation</div>
    </div>
  );
}

export function UtilizationChart({ months }: { months: MonthSummary[] }) {
  if (!months.length) return <EmptyChart />;
  const rows = toRows(months);
  return (
    <div className="h-72" role="img" aria-label="Monthly GPU utilisation percentage">
      <ResponsiveContainer>
        <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="utilFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.util} stopOpacity={0.35} />
              <stop offset="100%" stopColor={C.util} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={C.grid} vertical={false} />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis {...axisProps} width={40} domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
          <Tooltip content={<UtilTooltip />} cursor={{ stroke: C.axis, strokeDasharray: "3 3" }} />
          <Area type="monotone" dataKey="util" stroke={C.util} strokeWidth={2} fill="url(#utilFill)" isAnimationActive={false} activeDot={{ r: 5, stroke: "#0b1220", strokeWidth: 2 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function EmptyChart() {
  return <div className="grid h-72 place-items-center text-sm text-slate-400">No operating history yet.</div>;
}
