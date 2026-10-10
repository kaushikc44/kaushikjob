"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { assertNotMainnet, findRecords, type FoundRecord, type MintState, readMintState } from "./chain";
import { CLUSTER } from "./config";

const mintKey = (poolId: string) => `computerwa:${CLUSTER}:mint:${poolId}`;

export function rememberMint(poolId: string, mint: string | null) {
  try {
    if (mint) localStorage.setItem(mintKey(poolId), mint);
    else localStorage.removeItem(mintKey(poolId));
  } catch {
    // storage unavailable — on-chain discovery still works
  }
}

function recallMint(poolId: string): string | null {
  try {
    return localStorage.getItem(mintKey(poolId));
  } catch {
    return null;
  }
}

/** Cluster sanity check: resolves the genesis hash and refuses mainnet. */
export function useClusterCheck() {
  const { connection } = useConnection();
  const [state, setState] = useState<{ genesis?: string; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let alive = true;
    assertNotMainnet(connection)
      .then((genesis) => alive && setState({ genesis, loading: false }))
      .catch((e: Error) => alive && setState({ error: e.message, loading: false }));
    return () => {
      alive = false;
    };
  }, [connection]);
  return state;
}

/**
 * Loads on-chain state for one pool: ComputeRWA memo records from the
 * connected wallet's history, and the demo mint (from an explicit address,
 * local cache, or the most recent mint record found on chain).
 */
export function usePoolChainState(poolId: string, explicitMint?: string | null) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [records, setRecords] = useState<FoundRecord[]>([]);
  const [mint, setMint] = useState<string | null>(null);
  const [mintState, setMintState] = useState<MintState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let recs: FoundRecord[] = [];
      if (publicKey) {
        recs = (await findRecords(connection, publicKey)).filter((r) => r.record.pool === poolId);
      }
      setRecords(recs);
      const fromChain = recs.find((r) => r.record.t === "demo-token-mint");
      const chosen =
        explicitMint ||
        recallMint(poolId) ||
        (fromChain && fromChain.record.t === "demo-token-mint" ? fromChain.record.mint : null);
      setMint(chosen);
      if (chosen) {
        try {
          setMintState(await readMintState(connection, chosen));
        } catch (e) {
          setMintState(null);
          setError(`Could not read mint ${chosen.slice(0, 8)}… on ${CLUSTER}: ${(e as Error).message}`);
        }
      } else {
        setMintState(null);
      }
      setUpdatedAt(new Date().toISOString());
    } catch (e) {
      setError(`RPC error: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey, poolId, explicitMint]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { records, mint, mintState, loading, error, updatedAt, refresh, setMint };
}
