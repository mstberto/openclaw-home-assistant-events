import type { Delivery } from './model.js';
import type { Repository } from './repository.js';

export interface Dispatcher {
  submit(delivery: Delivery): Promise<{ runId: string }>;
  observe(runId: string): Promise<'ok' | 'error' | 'pending'>;
}
/** Durable at-least-once admission. Accepted runs are observed, never blindly rerun. */
export class Outbox {
  private draining = false;
  constructor(private readonly repository: Repository, private readonly dispatcher: Dispatcher,
    private readonly allowedAgents: readonly string[], private readonly now: () => number) {}
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const document = await this.repository.read();
      // Limit each pass so shutdown and new events do not wait for the entire queue.
      for (const delivery of document.deliveries.filter(d => d.status !== 'failed' && d.nextAttemptAt <= this.now()).slice(0, 20)) {
        if (!this.allowedAgents.includes(delivery.agentId)) continue;
        if (delivery.status === 'accepted' && delivery.runId) {
          const status = await this.dispatcher.observe(delivery.runId);
          await this.repository.transact(document => {
            const item = document.deliveries.find(d => d.id === delivery.id);
            if (!item) return;
            if (status === 'ok') document.deliveries = document.deliveries.filter(d => d.id !== item.id);
            else if (status === 'error') item.status = 'failed';
            else item.nextAttemptAt = this.now() + 30000;
          });
          continue;
        }
        // Re-read immediately before submission: removal may have cancelled a pending event.
        const live = (await this.repository.read()).deliveries.find(d => d.id === delivery.id && d.status === 'pending');
        if (!live) continue;
        let accepted: { runId: string };
        try { accepted = await this.dispatcher.submit(live); }
        catch {
          await this.repository.transact(document => {
            const item = document.deliveries.find(d => d.id === delivery.id);
            if (!item) return;
            item.attempts++;
            item.nextAttemptAt = this.now() + Math.min(300000, 1000 * 2 ** Math.min(item.attempts, 9));
            if (item.attempts >= 12) item.status = 'failed';
          });
          continue;
        }
        // Do not treat a persistence failure after admission as a rejected dispatch.
        // Replay uses the same host idempotency key; ambiguity remains documented.
        await this.repository.transact(document => {
          const item = document.deliveries.find(d => d.id === delivery.id);
          if (!item) return;
          item.status = 'accepted'; item.runId = accepted.runId; item.nextAttemptAt = this.now() + 1000;
        });
      }
    } finally { this.draining = false; }
  }
}
