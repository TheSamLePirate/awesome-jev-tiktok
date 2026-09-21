/** Fixed-window counter per key (an IP), pure and clock-injected, bounded in memory. */
export class RateLimiter {
  private hits = new Map<string, { count: number; start: number }>();
  constructor(readonly limit: number, readonly windowMs: number) {}
  /** Count one hit; `ok` is false once the window's limit is exceeded. */
  hit(key: string, now = Date.now()): { ok: boolean; remaining: number; retryAfterSec: number } {
    if (this.hits.size > 10_000) this.sweep(now);
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) { this.hits.set(key, { count: 1, start: now }); return { ok: true, remaining: this.limit - 1, retryAfterSec: 0 }; }
    h.count++;
    const ok = h.count <= this.limit;
    return { ok, remaining: Math.max(0, this.limit - h.count), retryAfterSec: ok ? 0 : Math.max(1, Math.ceil((h.start + this.windowMs - now) / 1000)) };
  }
  /** Is the key already over its limit (without counting a hit)? */
  blocked(key: string, now = Date.now()): { blocked: boolean; retryAfterSec: number } {
    const h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs || h.count < this.limit) return { blocked: false, retryAfterSec: 0 };
    return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((h.start + this.windowMs - now) / 1000)) };
  }
  reset(key: string) { this.hits.delete(key); }
  private sweep(now: number) { for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k); }
}
