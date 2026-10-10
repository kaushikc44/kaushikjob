"use client";

import { useMemo, useState } from "react";
import { formatUsd } from "@/lib/finance";
import type { LedgerEntry, LedgerKind } from "@/lib/types";

const KINDS: (LedgerKind | "all")[] = ["all", "revenue", "expense", "reserve", "maintenance", "acquisition", "note"];
const KIND_STYLE: Record<LedgerKind, string> = {
  revenue: "bg-emerald-500/15 text-emerald-300",
  expense: "bg-rose-500/15 text-rose-300",
  reserve: "bg-orange-500/15 text-orange-300",
  maintenance: "bg-sky-500/15 text-sky-300",
  acquisition: "bg-violet-500/15 text-violet-300",
  note: "bg-slate-500/20 text-slate-300",
};
const PAGE = 15;

export function LedgerTable({ entries }: { entries: LedgerEntry[] }) {
  const [kind, setKind] = useState<LedgerKind | "all">("all");
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => (kind === "all" ? entries : entries.filter((e) => e.kind === kind)), [entries, kind]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const rows = filtered.slice(page * PAGE, page * PAGE + PAGE);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {KINDS.map((k) => (
          <button
            key={k}
            onClick={() => {
              setKind(k);
              setPage(0);
            }}
            className={`rounded-lg px-3 py-1 text-xs capitalize ${kind === k ? "bg-ink-700 text-white" : "text-slate-400 hover:text-white"}`}
          >
            {k}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">No entries of this type.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs uppercase text-slate-400">
              <tr>
                <th className="py-2 pr-3 font-medium">Date</th>
                <th className="py-2 pr-3 font-medium">Type</th>
                <th className="py-2 pr-3 font-medium">Description</th>
                <th className="py-2 pr-3 font-medium">Reference</th>
                <th className="py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-t border-ink-700/60">
                  <td className="py-2 pr-3 tabular-nums text-slate-400">{e.date}</td>
                  <td className="py-2 pr-3">
                    <span className={`badge capitalize ${KIND_STYLE[e.kind]}`}>{e.kind}</span>
                  </td>
                  <td className="py-2 pr-3">{e.description}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-slate-400">{e.reference}</td>
                  <td className={`py-2 text-right tabular-nums ${e.amount < 0 ? "text-rose-300" : e.amount > 0 ? "text-emerald-300" : "text-slate-400"}`}>
                    {e.amount === 0 ? "—" : formatUsd(Math.round(e.amount * 100))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>
          {filtered.length} entries · off-chain accounting records (demo)
        </span>
        <div className="flex items-center gap-2">
          <button className="btn-ghost px-2 py-1" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Prev
          </button>
          <span>
            {page + 1} / {pages}
          </span>
          <button className="btn-ghost px-2 py-1" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
