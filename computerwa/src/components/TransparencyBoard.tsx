"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { formatUsd } from "@/lib/finance";
import { getPools, monthLabel, SEED_GENERATED_AT, summarizePool } from "@/lib/pools";
import { CLUSTER } from "@/lib/solana/config";
import { poolDataHash } from "@/lib/solana/records";
import { usePoolChainState } from "@/lib/solana/useChainState";
import type { AssetPool } from "@/lib/types";
import { AddressLink, TxLink } from "./TxLink";

export function TransparencyBoard() {
  const { publicKey } = useWallet();
  return (
    <div className="space-y-4">
      {!publicKey && (
        <p className="rounded-lg border border-dashed border-ink-600 p-3 text-sm text-slate-400">
          Connect the wallet that registered pools to rediscover its records from {CLUSTER} transaction history. Cached
          mints (from this browser) are still read without a wallet.
        </p>
      )}
      {getPools().map((p) => (
        <PoolRow key={p.id} pool={p} />
      ))}
    </div>
  );
}

function PoolRow({ pool }: { pool: AssetPool }) {
  const chain = usePoolChainState(pool.id);
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    poolDataHash(pool).then(setHash);
  }, [pool]);
  const s = summarizePool(pool);
  const reg = chain.records.find((r) => r.record.t === "pool-registration");
  const regHash = reg?.record.t === "pool-registration" ? reg.record.dataHash : null;

  return (
    <section className="card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Link href={`/pools/${pool.id}`} className="text-lg font-semibold text-white hover:text-accent">
          {pool.name}
        </Link>
        <span className="text-xs text-slate-400">
          {chain.loading ? "reading chain…" : chain.updatedAt ? `chain read ${new Date(chain.updatedAt).toLocaleTimeString()}` : ""}
        </span>
      </div>
      {chain.error && <p className="mb-2 text-sm text-rose-300">{chain.error}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="badge bg-sky-500/15 text-sky-300">on-chain facts</span>
            <span className="text-xs text-slate-400">{CLUSTER}</span>
          </div>
          <dl className="grid grid-cols-[130px_1fr] gap-y-1.5 text-sm">
            <dt className="text-slate-400">Registration tx</dt>
            <dd>{reg ? <TxLink sig={reg.signature} /> : <span className="text-slate-500">none found</span>}</dd>
            <dt className="text-slate-400">Committed hash</dt>
            <dd className="mono text-slate-300">{regHash ? `${regHash.slice(0, 20)}…` : "—"}</dd>
            <dt className="text-slate-400">Token mint</dt>
            <dd>{chain.mint ? <AddressLink address={chain.mint} /> : <span className="text-slate-500">not created</span>}</dd>
            <dt className="text-slate-400">Supply</dt>
            <dd className="tabular-nums">{chain.mintState ? `${chain.mintState.supply.toLocaleString()} (test)` : "—"}</dd>
            <dt className="text-slate-400">Holders</dt>
            <dd className="tabular-nums">{chain.mintState ? chain.mintState.holders.length : "—"}</dd>
            <dt className="text-slate-400">Signatures</dt>
            <dd className="space-y-0.5">
              {chain.records.length ? chain.records.map((r) => <div key={r.signature + r.record.t} className="text-xs"><TxLink sig={r.signature} /> <span className="text-slate-500">{r.record.t}</span></div>) : "—"}
            </dd>
          </dl>
        </div>
        <div className="rounded-lg border border-ink-600 bg-ink-950/50 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="badge bg-slate-500/20 text-slate-300">off-chain inputs</span>
            <span className="text-xs text-slate-400">operator-reported · fictional · unverified</span>
          </div>
          <dl className="grid grid-cols-[130px_1fr] gap-y-1.5 text-sm">
            <dt className="text-slate-400">Current hash</dt>
            <dd className="mono text-slate-300">{hash ? `${hash.slice(0, 20)}…` : "…"}</dd>
            <dt className="text-slate-400">Hash check</dt>
            <dd>
              {!regHash ? (
                <span className="text-slate-500">not registered</span>
              ) : regHash === hash ? (
                <span className="badge bg-emerald-500/15 text-emerald-300">matches</span>
              ) : (
                <span className="badge bg-amber-500/15 text-amber-300">changed since registration</span>
              )}
            </dd>
            <dt className="text-slate-400">Months reported</dt>
            <dd>
              {s.months.length}
              {s.latest ? ` (to ${monthLabel(s.latest.month)})` : ""}
            </dd>
            <dt className="text-slate-400">Revenue (total)</dt>
            <dd className="tabular-nums">{formatUsd(s.totals.revenueCents)}</dd>
            <dt className="text-slate-400">Distributable</dt>
            <dd className="tabular-nums">{formatUsd(s.totals.distributableCashCents)}</dd>
            <dt className="text-slate-400">Data updated</dt>
            <dd className="text-xs text-slate-400">{new Date(SEED_GENERATED_AT).toUTCString()}</dd>
          </dl>
        </div>
      </div>
    </section>
  );
}
