// The clock every lens test injects. `advance(ms)` runs due timers in
// scheduling order, including timers scheduled from inside a timer, so a settle
// window can be stepped through without waiting for it.
// Lifted from BlackIce tests/fake-clock.ts.
import type { Clock } from '../src/lib/lens/core.ts';

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
}

export class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  #timers = new Set<Timer>();

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const timer: Timer = { at: this.#now + Math.max(0, ms), seq: ++this.#seq, fn };
    this.#timers.add(timer);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    if (handle) this.#timers.delete(handle as Timer);
  }

  /** Move to `now + ms`, firing every timer that comes due on the way. */
  advance(ms: number): void {
    const until = this.#now + ms;
    for (;;) {
      let next: Timer | undefined;
      for (const timer of this.#timers) {
        if (timer.at > until) continue;
        if (!next || timer.at < next.at || (timer.at === next.at && timer.seq < next.seq)) next = timer;
      }
      if (!next) break;
      this.#timers.delete(next);
      this.#now = Math.max(this.#now, next.at);
      next.fn();
    }
    this.#now = until;
  }

  /** Timers still scheduled: a leak check for anything that owns a timer. */
  pending(): number {
    return this.#timers.size;
  }
}
