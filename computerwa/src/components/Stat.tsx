export function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" | "good" }) {
  const color = tone === "warn" ? "text-amber-300" : tone === "good" ? "text-emerald-300" : "text-white";
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-950/60 p-3">
      <div className="label">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
    </div>
  );
}
