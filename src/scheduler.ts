import type { Scheduler } from './transport.js';

/** Lifecycle-owned timers for the published v1 service contract. Jobs never overlap themselves. */
export class ServiceScheduler implements Scheduler {
  private readonly controller = new AbortController();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly cancellations = new Map<string, () => void>();
  private readonly running = new Set<Promise<unknown>>();
  readonly signal = this.controller.signal;
  now = (): number => Date.now();
  schedule(params: Parameters<Scheduler['schedule']>[0]): { cancel(): void } {
    this.cancellations.get(params.id)?.();
    let cancelled = false;
    const cancel = (): void => {
      cancelled = true;
      const timer = this.timers.get(params.id);
      if (timer) clearTimeout(timer);
      this.timers.delete(params.id);
      this.cancellations.delete(params.id);
    };
    this.cancellations.set(params.id, cancel);
    const arm = (delay: number): void => {
      if (this.signal.aborted || cancelled) return;
      this.timers.set(params.id, setTimeout(() => {
        this.timers.delete(params.id);
        const work = Promise.resolve().then(() => {
          if (!this.signal.aborted && !cancelled) return params.run();
        });
        this.running.add(work);
        void work.finally(() => {
          this.running.delete(work);
          if (params.everyMs !== undefined) arm(params.everyMs);
        }).catch(() => undefined);
      }, delay));
    };
    arm(params.delayMs);
    return { cancel };
  }
  beginClose(): void {
    this.controller.abort();
    for (const cancel of [...this.cancellations.values()]) cancel();
    this.timers.clear();
  }
  async stop(): Promise<void> {
    this.beginClose();
    await Promise.allSettled([...this.running]);
  }
}
