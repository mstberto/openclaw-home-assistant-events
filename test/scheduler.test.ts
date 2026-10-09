import { it, expect, vi } from 'vitest';
import { ServiceScheduler } from '../src/scheduler.js';
it('owns timers, waits for running callbacks, and never overlaps repeating work', async () => {
  vi.useFakeTimers(); const scheduler = new ServiceScheduler(); let release: (() => void) | undefined;
  const run = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  scheduler.schedule({ id: 'job', delayMs: 1, everyMs: 1, run });
  await vi.advanceTimersByTimeAsync(100); expect(run).toHaveBeenCalledTimes(1);
  const stopped = scheduler.stop(); expect(scheduler.signal.aborted).toBe(true); release?.(); await stopped;
  await vi.advanceTimersByTimeAsync(100); expect(run).toHaveBeenCalledTimes(1); vi.useRealTimers();
});
