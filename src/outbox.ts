import { randomUUID } from 'node:crypto';
import { pruneDeliveryHistory, type Delivery } from './model.js';
import type { Repository } from './repository.js';

export class DispatchPreflightError extends Error {
  constructor(message: string, readonly permanent = false) { super(message); }
}
export interface PreparedDispatch {
  execute(runId: string): Promise<{ persisted: boolean }>;
}
export interface Dispatcher {
  prepare(delivery: Delivery): PreparedDispatch;
}
/** Persist intent before effects. Never automatically replay an inconclusive attempt. */
export class Outbox {
  private draining = false;
  constructor(private readonly repository: Repository, private readonly dispatcher: Dispatcher,
    private readonly allowedAgents: readonly string[], private readonly now: () => number) {}
  async recover(): Promise<void> {
    await this.repository.transact(document => {
      for (const item of document.deliveries) {
        if (item.status === 'running' || item.status === 'accepted') {
          item.status = 'uncertain';
          item.reason = 'Interrupted execution or legacy admission: inspect the originating conversation before retrying';
        }
      }
    });
  }
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const document = await this.repository.read();
      for (const delivery of document.deliveries.filter(d => d.status === 'pending' && d.nextAttemptAt <= this.now()).slice(0, 20)) {
        if (!this.allowedAgents.includes(delivery.agentId)) continue;
        let prepared: PreparedDispatch;
        try { prepared = this.dispatcher.prepare(delivery); }
        catch (error) {
          // No runtime invocation occurred: only these failures are safe to retry automatically.
          await this.repository.transact(document => {
            const item = document.deliveries.find(d => d.id === delivery.id && d.status === 'pending');
            if (!item) return;
            item.attempts++;
            item.nextAttemptAt = this.now() + Math.min(300000, 1000 * 2 ** Math.min(item.attempts, 9));
            item.reason = error instanceof DispatchPreflightError ? error.message : 'Dispatch preflight unavailable';
            if ((error instanceof DispatchPreflightError && error.permanent) || item.attempts >= 12) item.status = 'failed';
          });
          continue;
        }
        const runId = randomUUID();
        const reserved = await this.repository.transact(document => {
          const item = document.deliveries.find(d => d.id === delivery.id && d.status === 'pending');
          if (!item) return false; // Removal or manual review raced preparation.
          item.status = 'running'; item.runId = runId; item.startedAt = this.now(); item.attempts++;
          delete item.reason;
          return true;
        });
        if (!reserved) continue;
        let persisted = false;
        let reason = 'Runtime did not confirm transcript persistence; manual review required';
        try { persisted = (await prepared.execute(runId)).persisted; }
        catch (error) {
          // A final pre-invocation guard may reject after reservation. It is still safe to retry.
          if (error instanceof DispatchPreflightError) {
            await this.repository.transact(document => {
              const item = document.deliveries.find(d => d.id === delivery.id && d.status === 'running');
              if (!item) return;
              item.status = error.permanent || item.attempts >= 12 ? 'failed' : 'pending';
              item.reason = error.message; item.nextAttemptAt = this.now() + 30000;
            });
            continue;
          }
          reason = 'Execution interrupted without a confirmed transcript receipt; manual review required';
        }
        // Failure of this write leaves running on disk. Startup conservatively marks it uncertain.
        await this.repository.transact(document => {
          const item = document.deliveries.find(d => d.id === delivery.id && d.status === 'running');
          if (!item) return;
          item.status = persisted ? 'delivered' : 'uncertain';
          if (persisted) { item.deliveredAt = this.now(); delete item.reason; }
          else item.reason = reason;
          // Keep bounded audit history without discarding unresolved events.
          pruneDeliveryHistory(document);
        });
      }
    } finally { this.draining = false; }
  }
}
