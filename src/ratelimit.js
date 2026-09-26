// ratelimit.js — Politeness engine.
//
// This scraper is intentionally conservative. It paces itself like a human
// reader, caps total work per run, and backs off the moment X signals
// pressure. There is deliberately NO proxy rotation, NO account pooling and
// NO retry-storming: if X says stop, we stop.

export class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.minDelayMs  minimum pause between page actions
   * @param {number} opts.maxDelayMs  maximum pause (jitter upper bound)
   * @param {number} opts.maxItems    hard cap on collected items per run
   */
  constructor({ minDelayMs = 2500, maxDelayMs = 6000, maxItems = 200 } = {}) {
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.maxItems = maxItems;
    this.count = 0;
    this.backoffMs = 0;
  }

  /** Randomized human-like pause between actions. */
  async pause() {
    const jitter =
      this.minDelayMs + Math.random() * (this.maxDelayMs - this.minDelayMs);
    const wait = jitter + this.backoffMs;
    await new Promise((r) => setTimeout(r, wait));
  }

  /** Register one collected item. Returns false when the cap is reached. */
  tick(n = 1) {
    this.count += n;
    return this.count < this.maxItems;
  }

  /** Exponential backoff when X responds with 429/503 style pressure. */
  async onPressure() {
    this.backoffMs = this.backoffMs === 0 ? 10_000 : Math.min(this.backoffMs * 2, 120_000);
    console.warn(`  ! Rate-limit pressure detected. Cooling down ${this.backoffMs / 1000}s...`);
    await new Promise((r) => setTimeout(r, this.backoffMs));
  }

  resetBackoff() {
    this.backoffMs = 0;
  }
}
