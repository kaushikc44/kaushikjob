"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import type { AssetPool } from "@/lib/types";
import { createDemoMint, distributeDemoTokens, registerPool, requestDevnetAirdrop, type TxSigner } from "@/lib/solana/chain";
import { CLUSTER, RPC_ENDPOINT } from "@/lib/solana/config";
import { friendlyError } from "@/lib/solana/errors";
import { NO_RIGHTS_NOTICE, poolDataHash } from "@/lib/solana/records";
import { rememberMint, useClusterCheck, usePoolChainState } from "@/lib/solana/useChainState";
import { AddressLink, short, TxLink } from "./TxLink";

type Busy = null | "airdrop" | "register" | "mint" | "distribute";
interface RecipientRow {
  address: string;
  amount: string;
}

export function OnChainPanel({ pool }: { pool: AssetPool }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const cluster = useClusterCheck();
  const chain = usePoolChainState(pool.id);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<{ label: string; sig: string } | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<RecipientRow[]>([{ address: "", amount: "100000" }]);

  useEffect(() => {
    poolDataHash(pool).then(setHash).catch(() => setHash(null));
  }, [pool]);

  const pk = wallet.publicKey;
  useEffect(() => {
    if (!pk) return setBalance(null);
    let alive = true;
    connection
      .getBalance(pk, "confirmed")
      .then((b) => alive && setBalance(b / LAMPORTS_PER_SOL))
      .catch(() => alive && setBalance(null));
    return () => {
      alive = false;
    };
  }, [pk, connection, lastSig]);

  const signer: TxSigner | null = useMemo(() => {
    if (!wallet.publicKey || !wallet.signTransaction) return null;
    return { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction };
  }, [wallet.publicKey, wallet.signTransaction]);

  const registration = chain.records.find((r) => r.record.t === "pool-registration");
  const regHash = registration?.record.t === "pool-registration" ? registration.record.dataHash : null;
  const blocked = !!cluster.error;

  async function run(kind: Exclude<Busy, null>, label: string, fn: () => Promise<string>) {
    setBusy(kind);
    setError(null);
    try {
      const sig = await fn();
      setLastSig({ label, sig });
      await chain.refresh();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  const onAirdrop = () => pk && run("airdrop", "Airdrop", () => requestDevnetAirdrop(connection, pk, 1));
  const onRegister = () =>
    signer &&
    hash &&
    run("register", "Pool registration", () =>
      registerPool(connection, signer, { poolId: pool.id, gpuModel: pool.gpuModel, units: pool.units, dataHash: hash }),
    );
  const onMint = () =>
    signer &&
    run("mint", "Test token mint", async () => {
      const { signature, mint } = await createDemoMint(connection, signer, { poolId: pool.id, supply: BigInt(pool.tokenSupply) });
      rememberMint(pool.id, mint.toBase58());
      return signature;
    });
  const onDistribute = () =>
    signer &&
    chain.mint &&
    run("distribute", "Test token transfer", () => {
      const parsed = recipients
        .filter((r) => r.address.trim())
        .map((r) => {
          if (!/^\d+$/.test(r.amount.trim()) || BigInt(r.amount.trim()) <= 0n) throw new Error(`Invalid amount “${r.amount}” — use a positive whole number`);
          return { address: r.address.trim(), amount: BigInt(r.amount.trim()) };
        });
      return distributeDemoTokens(connection, signer, { poolId: pool.id, mint: new PublicKey(chain.mint!), recipients: parsed });
    });

  const mine = chain.mintState?.holders.find((h) => pk && h.owner === pk.toBase58());

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="badge bg-sky-500/15 text-sky-300">on-chain · {CLUSTER}</span>
        <span className="text-slate-400">RPC {RPC_ENDPOINT}</span>
        {cluster.loading && <span className="text-slate-400">checking cluster…</span>}
        {cluster.genesis && <span className="text-slate-500">genesis {short(cluster.genesis)}</span>}
      </div>
      {cluster.error && <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">{cluster.error}</div>}

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">{NO_RIGHTS_NOTICE} Never use mainnet funds.</div>

      {!pk ? (
        <div className="rounded-lg border border-dashed border-ink-600 p-5 text-center">
          <p className="text-sm text-slate-300">Connect a Solana wallet set to <strong>devnet</strong> to register this pool and mint test tokens.</p>
          <button className="btn-primary mt-3" onClick={() => setVisible(true)}>
            Connect wallet
          </button>
          <p className="mt-2 text-xs text-slate-500">Phantom: Settings → Developer settings → Testnet mode → Solana Devnet.</p>
        </div>
      ) : (
        <ol className="space-y-3">
          <Step n={1} title="Fund wallet with devnet SOL" done={(balance ?? 0) > 0.01}>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span>
                Balance: <strong className="tabular-nums">{balance === null ? "…" : `${balance.toFixed(4)} SOL`}</strong>
              </span>
              <button className="btn-ghost py-1" disabled={!!busy || blocked} onClick={onAirdrop}>
                {busy === "airdrop" ? "Requesting…" : "Airdrop 1 devnet SOL"}
              </button>
              <a className="text-xs text-accent hover:underline" href="https://faucet.solana.com" target="_blank" rel="noreferrer">
                web faucet
              </a>
            </div>
          </Step>
          <Step n={2} title="Register pool record on-chain" done={!!registration}>
            <p className="text-xs text-slate-400">
              Writes a Memo-program record committing to the SHA-256 of this pool&apos;s off-chain accounting data.
            </p>
            <div className="mono mt-1 text-slate-400">current data hash: {hash ?? "computing…"}</div>
            <button className="btn-ghost mt-2 py-1" disabled={!!busy || !hash || !signer || blocked} onClick={onRegister}>
              {busy === "register" ? "Waiting for signature…" : registration ? "Register again (new version)" : "Register pool"}
            </button>
          </Step>
          <Step n={3} title={`Create ${pool.tokenSupply.toLocaleString()} test tokens`} done={!!chain.mintState}>
            <p className="text-xs text-slate-400">
              New SPL mint (0 decimals), minted to your wallet, with a no-rights memo in the same transaction.
            </p>
            <button className="btn-ghost mt-2 py-1" disabled={!!busy || !signer || blocked} onClick={onMint}>
              {busy === "mint" ? "Waiting for signature…" : chain.mintState ? "Create a fresh mint" : "Create test token"}
            </button>
          </Step>
          <Step n={4} title="Distribute test tokens (optional)" done={(chain.mintState?.holders.length ?? 0) > 1}>
            {!chain.mint ? (
              <p className="text-xs text-slate-400">Create a test token first.</p>
            ) : (
              <div className="space-y-2">
                {recipients.map((r, i) => (
                  <div key={i} className="flex flex-col gap-2 sm:flex-row">
                    <input
                      className="input font-mono text-xs"
                      placeholder="Recipient devnet address"
                      value={r.address}
                      aria-label={`Recipient ${i + 1} address`}
                      onChange={(e) => setRecipients((rs) => rs.map((x, j) => (j === i ? { ...x, address: e.target.value } : x)))}
                    />
                    <input
                      className="input sm:w-36"
                      inputMode="numeric"
                      value={r.amount}
                      aria-label={`Recipient ${i + 1} amount`}
                      onChange={(e) => setRecipients((rs) => rs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                    />
                    {recipients.length > 1 && (
                      <button className="btn-ghost py-1" onClick={() => setRecipients((rs) => rs.filter((_, j) => j !== i))} aria-label="Remove recipient">
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  <button className="btn-ghost py-1" disabled={recipients.length >= 8} onClick={() => setRecipients((rs) => [...rs, { address: "", amount: "50000" }])}>
                    + Recipient
                  </button>
                  <button
                    className="btn-ghost py-1"
                    onClick={() =>
                      setRecipients((rs) => [...rs.filter((r) => r.address.trim()), ...demoRecipients()].slice(0, 8))
                    }
                    title="Generates random throwaway addresses (no keys are kept) so you can demo multiple holders"
                  >
                    + 2 random demo addresses
                  </button>
                  <button
                    className="btn-primary py-1"
                    disabled={!!busy || !signer || blocked || !recipients.some((r) => r.address.trim())}
                    onClick={onDistribute}
                  >
                    {busy === "distribute" ? "Waiting for signature…" : "Send test tokens"}
                  </button>
                </div>
              </div>
            )}
          </Step>
        </ol>
      )}

      {error && (
        <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </div>
      )}
      {lastSig && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
          {lastSig.label} confirmed: <TxLink sig={lastSig.sig} />
        </div>
      )}

      <OnChainFacts pool={pool} chain={chain} regHash={regHash} hash={hash} mine={mine?.balance} />
    </div>
  );
}

function demoRecipients(): RecipientRow[] {
  // Random 32-byte public keys — nobody holds their private keys; they only demonstrate multiple holders.
  const rand = () => new PublicKey(crypto.getRandomValues(new Uint8Array(32))).toBase58();
  return [
    { address: rand(), amount: "250000" },
    { address: rand(), amount: "100000" },
  ];
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <li className="rounded-lg border border-ink-700 bg-ink-950/50 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${done ? "bg-emerald-400 text-ink-950" : "bg-ink-700 text-slate-300"}`}>
          {done ? "✓" : n}
        </span>
        <span className="font-semibold text-white">{title}</span>
      </div>
      {children}
    </li>
  );
}

function OnChainFacts({
  pool,
  chain,
  regHash,
  hash,
  mine,
}: {
  pool: AssetPool;
  chain: ReturnType<typeof usePoolChainState>;
  regHash: string | null;
  hash: string | null;
  mine?: bigint;
}) {
  const [manual, setManual] = useState("");
  const ms = chain.mintState;
  return (
    <div className="space-y-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold text-white">On-chain facts (read from {CLUSTER})</h4>
        <button className="btn-ghost py-1 text-xs" onClick={() => chain.refresh()} disabled={chain.loading}>
          {chain.loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      {chain.error && <p className="text-sm text-rose-300">{chain.error}</p>}
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[180px_1fr]">
        <dt className="text-slate-400">Pool registration</dt>
        <dd>
          {chain.records.filter((r) => r.record.t === "pool-registration").length ? (
            <ul className="space-y-1">
              {chain.records
                .filter((r) => r.record.t === "pool-registration")
                .map((r) => (
                  <li key={r.signature} className="flex flex-wrap items-center gap-2">
                    <TxLink sig={r.signature} /> <span className="text-xs text-slate-500">slot {r.slot}</span>
                    {r.blockTime && <span className="text-xs text-slate-500">{new Date(r.blockTime * 1000).toLocaleString()}</span>}
                  </li>
                ))}
            </ul>
          ) : (
            <span className="text-slate-500">None found for the connected wallet.</span>
          )}
        </dd>
        <dt className="text-slate-400">Committed data hash</dt>
        <dd>
          {regHash ? (
            <>
              <span className="mono text-slate-300">{regHash}</span>{" "}
              {hash &&
                (regHash === hash ? (
                  <span className="badge bg-emerald-500/15 text-emerald-300">matches current off-chain record</span>
                ) : (
                  <span className="badge bg-amber-500/15 text-amber-300">off-chain record changed since registration</span>
                ))}
            </>
          ) : (
            <span className="text-slate-500">—</span>
          )}
        </dd>
        <dt className="text-slate-400">Token mint</dt>
        <dd>{chain.mint ? <AddressLink address={chain.mint} full /> : <span className="text-slate-500">Not created yet.</span>}</dd>
        {ms && (
          <>
            <dt className="text-slate-400">Supply / decimals</dt>
            <dd className="tabular-nums">
              {ms.supply.toLocaleString()} {pool.tokenSymbol} (test) · {ms.decimals} decimals
            </dd>
            <dt className="text-slate-400">Mint authority</dt>
            <dd>{ms.mintAuthority ? <AddressLink address={ms.mintAuthority} /> : "none (fixed supply)"}</dd>
            <dt className="text-slate-400">Holders</dt>
            <dd>
              <ul className="space-y-0.5">
                {ms.holders.map((h) => (
                  <li key={h.tokenAccount} className="flex flex-wrap gap-2">
                    <AddressLink address={h.owner} />
                    <span className="tabular-nums">{h.balance.toLocaleString()}</span>
                    <span className="text-xs text-slate-500">({Number((h.balance * 10000n) / (ms.supply || 1n)) / 100}%)</span>
                  </li>
                ))}
              </ul>
              {mine !== undefined && <p className="mt-1 text-xs text-slate-400">Your balance: {mine.toLocaleString()}</p>}
            </dd>
            <dt className="text-slate-400">Read at</dt>
            <dd className="text-xs text-slate-400">
              slot {ms.slot} · {new Date(ms.fetchedAt).toLocaleString()}
            </dd>
          </>
        )}
        <dt className="text-slate-400">Transaction signatures</dt>
        <dd>
          {chain.records.length ? (
            <ul className="space-y-0.5">
              {chain.records.map((r) => (
                <li key={r.signature + r.record.t} className="flex flex-wrap gap-2 text-xs">
                  <span className="w-36 text-slate-400">{r.record.t}</span>
                  <TxLink sig={r.signature} />
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-slate-500">—</span>
          )}
        </dd>
        <dt className="text-slate-400">Last updated</dt>
        <dd className="text-xs text-slate-400">{chain.updatedAt ? new Date(chain.updatedAt).toLocaleString() : "—"}</dd>
      </dl>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          const v = manual.trim();
          try {
            new PublicKey(v);
          } catch {
            return;
          }
          rememberMint(pool.id, v);
          chain.refresh();
        }}
      >
        <input className="input font-mono text-xs" placeholder="Inspect an existing test mint address…" value={manual} onChange={(e) => setManual(e.target.value)} />
        <button className="btn-ghost py-1" type="submit">
          Load mint
        </button>
        {chain.mint && (
          <button
            className="btn-ghost py-1"
            type="button"
            onClick={() => {
              rememberMint(pool.id, null);
              chain.refresh();
            }}
          >
            Forget cached mint
          </button>
        )}
      </form>
    </div>
  );
}
