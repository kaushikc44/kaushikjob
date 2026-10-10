/** In-memory rate limiting (fixed one-minute windows per key) and non-queuing concurrency limits. */

export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Returns 0 when allowed, otherwise the number of seconds until the window resets. */
  take(keyId: string, limitPerMinute: number): number {
    const t = this.now();
    const w = this.windows.get(keyId);
    if (!w || t - w.start >= 60_000) {
      this.windows.set(keyId, { start: t, count: 1 });
      return 0;
    }
    if (w.count >= limitPerMinute) return Math.max(1, Math.ceil((w.start + 60_000 - t) / 1000));
    w.count += 1;
    return 0;
  }
}

export class ConcurrencyLimiter {
  private global = 0;
  private perKey = new Map<string, number>();
  constructor(
    private readonly globalMax: number,
    private readonly perKeyMax: number,
  ) {}

  /** Returns a release function, or the scope that is full. */
  acquire(keyId: string): { ok: true; release: () => void } | { ok: false; scope: "global" | "key" } {
    const k = this.perKey.get(keyId) ?? 0;
    if (k >= this.perKeyMax) return { ok: false, scope: "key" };
    if (this.global >= this.globalMax) return { ok: false, scope: "global" };
    this.global += 1;
    this.perKey.set(keyId, k + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.global -= 1;
        const n = (this.perKey.get(keyId) ?? 1) - 1;
        if (n <= 0) this.perKey.delete(keyId);
        else this.perKey.set(keyId, n);
      },
    };
  }

  get active() {
    return this.global;
  }
}
