"use client";

import { useCallback, useEffect, useState } from "react";
import type { InferenceStatus } from "./types";

export type RangeOption = "1" | "7" | "30" | "90" | "all";

/** Polls the dashboard's own /api/inference route (never the gateway directly). */
export function useInferenceStatus(days: RangeOption, pollMs = 15_000) {
  const [status, setStatus] = useState<InferenceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/inference?days=${days}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus((await r.json()) as InferenceStatus);
      setFetchError(null);
    } catch (e) {
      setFetchError(`Could not load inference status: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
    if (!pollMs) return;
    const t = setInterval(() => void load(), pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);

  return { status, loading, fetchError, reload: load };
}
