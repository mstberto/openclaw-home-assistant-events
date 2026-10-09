import { randomUUID, createHash } from 'node:crypto';
import { compareTimestamps } from './timestamps.js';
import { EntityIndex, matchesTransition, updateDuration } from './matcher.js';
import { subscriptionInputSchema, sourceSessionSchema, pruneDeliveryHistory, type SourceSession, type Delivery, type EntityState, type StateDocument, type StateEvent, type Subscription } from './model.js';
import type { Repository } from './repository.js';

const fingerprint = (text: string): string => createHash('sha256').update(text).digest('hex');
export class Engine {
  private readonly index = new EntityIndex();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly states = new Map<string, EntityState>();
  private ready = false;
  constructor(readonly repository: Repository, private readonly allowedAgents: readonly string[], private readonly now: () => number) {}
  private authorize(agentId: string): void {
    if (!this.allowedAgents.includes(agentId)) throw new Error('Agent is not allowed to use Home Assistant Events');
  }
  private refresh(document: StateDocument): void {
    this.index.rebuild(document.subscriptions.filter(subscription => this.allowedAgents.includes(subscription.agentId)));
    this.subscriptions.clear();
    for (const subscription of document.subscriptions) this.subscriptions.set(subscription.id, subscription);
  }
  isAllowed(agentId: string): boolean { return this.allowedAgents.includes(agentId); }
  async load(): Promise<void> { this.refresh(await this.repository.read()); }
  disconnect(): void { this.ready = false; this.states.clear(); }
  async subscribe(agentId: string, input: unknown, assertCurrent: () => void = () => {}, source?: SourceSession): Promise<Subscription> {
    this.authorize(agentId);
    if (source && !source.sessionKey.startsWith(`agent:${agentId}:`)) throw new Error('Source session does not belong to this agent');
    const subscription: Subscription = {
      id: randomUUID(), agentId, input: subscriptionInputSchema.parse(input), createdAt: this.now(), consumed: false,
      ...(source ? { source: sourceSessionSchema.parse(source) } : {}),
    };
    const document = await this.repository.transact(document => {
      assertCurrent();
      if (document.subscriptions.length >= 1000) throw new Error('Subscription limit reached; remove unused subscriptions');
      if (this.ready) updateDuration(subscription, this.states.get(subscription.input.entityId), this.now());
      document.subscriptions.push(subscription);
      return document;
    });
    this.refresh(document);
    return subscription;
  }
  async list(agentId: string): Promise<Subscription[]> {
    this.authorize(agentId);
    return (await this.repository.read()).subscriptions.filter(subscription => subscription.agentId === agentId);
  }
  async remove(agentId: string, id: string, assertCurrent: () => void = () => {}): Promise<boolean> {
    this.authorize(agentId);
    const { removed, document } = await this.repository.transact(document => {
      assertCurrent();
      const owned = document.subscriptions.find(subscription => subscription.id === id && subscription.agentId === agentId);
      if (!owned) return { removed: false, document };
      document.subscriptions = document.subscriptions.filter(subscription => subscription !== owned);
      // Accepted work is already host-owned and cannot safely be recalled here.
      document.deliveries = document.deliveries.filter(delivery => delivery.subscriptionId !== id || ['accepted', 'running', 'uncertain'].includes(delivery.status));
      return { removed: true, document };
    });
    this.refresh(document);
    return removed;
  }
  async snapshot(states: EntityState[], markReady = true): Promise<void> {
    this.states.clear();
    for (const state of states) this.states.set(state.entity_id, state);
    const document = await this.repository.transact(document => {
      for (const subscription of document.subscriptions) {
        if (!subscription.consumed && this.allowedAgents.includes(subscription.agentId)) updateDuration(subscription, this.states.get(subscription.input.entityId), this.now());
      }
      return document;
    });
    this.refresh(document);
    this.ready = markReady;
  }
  async event(event: StateEvent, duringSynchronization = false): Promise<void> {
    if (!this.ready && !duringSynchronization) throw new Error('Cannot process events before snapshot');
    const entityId = event.data.entity_id;
    const current = event.data.new_state;
    const prior = this.states.get(entityId);
    // Ignore late events and duplicate snapshot-covered events, including attributes-only updates.
    if (prior && compareTimestamps(current?.last_updated ?? event.time_fired, prior.last_updated) <= 0) return;
    const ids = new Set(this.index.ids(entityId));
    if (ids.size > 0) {
      const document = await this.repository.transact(document => {
        for (const subscription of document.subscriptions) {
          if (!ids.has(subscription.id) || subscription.consumed) continue;
          updateDuration(subscription, current ?? undefined, this.now());
          if (matchesTransition(subscription, event) && current)
            this.enqueue(document, subscription, current, event.data.old_state?.state ?? null, event.time_fired);
        }
        return document;
      });
      this.refresh(document);
    }
    if (current) this.states.set(entityId, current); else this.states.delete(entityId);
  }
  async tick(): Promise<void> {
    if (!this.ready) return;
    const due = [...this.subscriptions.values()].filter(subscription => subscription.armed
      && subscription.input.trigger.type === 'state_for' && !subscription.consumed && this.allowedAgents.includes(subscription.agentId)
      && subscription.armed.transitionId !== subscription.firedTransition
      && subscription.armed.since + subscription.input.trigger.durationMs <= this.now());
    if (due.length === 0) return;
    const ids = new Set(due.map(subscription => subscription.id));
    const document = await this.repository.transact(document => {
      for (const subscription of document.subscriptions) {
        if (!ids.has(subscription.id) || subscription.consumed || !subscription.armed) continue;
        const current = this.states.get(subscription.input.entityId);
        if (!current || current.last_changed !== subscription.armed.transitionId) continue;
        this.enqueue(document, subscription, current, null, current.last_changed);
        subscription.firedTransition = current.last_changed;
      }
      return document;
    });
    this.refresh(document);
  }
  private enqueue(document: StateDocument, subscription: Subscription, current: EntityState, previousState: string | null, transition: string): void {
    const id = fingerprint(`${subscription.id}:${transition}:${current.state}`);
    if (document.seen.includes(id)) return;
    if (document.deliveries.length >= 5000) throw new Error('Delivery queue full; processing is paused until capacity is available');
    const delivery: Delivery = {
      id, subscriptionId: subscription.id, agentId: subscription.agentId,
      entityId: subscription.input.entityId, instruction: subscription.input.instruction,
      previousState, currentState: current.state, occurredAt: subscription.input.trigger.type === 'state_for' ? this.now() : Date.parse(transition), oneShot: subscription.input.oneShot,
      attempts: 0, nextAttemptAt: this.now(), status: 'pending',
      ...(subscription.source ? { source: subscription.source } : {}),
    };
    document.deliveries.push(delivery);
    document.seen.push(id);
    if (document.seen.length > 10000) document.seen.shift();
    if (subscription.input.oneShot) subscription.consumed = true;
  }
  async status(agentId: string): Promise<unknown> {
    this.authorize(agentId);
    const document = await this.repository.read();
    return { synchronized: this.ready, subscriptions: document.subscriptions.filter(s => s.agentId === agentId).length,
      deliveries: document.deliveries.filter(d => d.agentId === agentId) };
  }
  async resolveDelivery(agentId: string, id: string, resolution: 'delivered' | 'dismissed' | 'retry', acknowledgeDuplicateRisk: boolean,
    assertCurrent: () => void = () => {}): Promise<Delivery> {
    this.authorize(agentId);
    return this.repository.transact(document => {
      assertCurrent();
      const item = document.deliveries.find(d => d.id === id && d.agentId === agentId);
      if (!item || !['uncertain', 'failed'].includes(item.status)) throw new Error('Only an owned uncertain or failed delivery can be reviewed');
      if (resolution === 'retry' && !acknowledgeDuplicateRisk) throw new Error('Retry requires explicit acknowledgement of duplicate-action risk');
      if (resolution === 'retry' && !item.source) throw new Error('Legacy event has no originating session; create a new subscription');
      item.reviews = (item.reviews ?? 0) + 1;
      item.status = resolution === 'retry' ? 'pending' : resolution;
      item.reason = resolution === 'retry' ? 'Manual retry authorized; duplicate risk acknowledged' : 'Resolved by explicit manual review';
      if (resolution === 'retry') { item.attempts = 0; item.nextAttemptAt = this.now(); delete item.runId; delete item.startedAt; }
      if (resolution === 'delivered') item.deliveredAt = this.now();
      pruneDeliveryHistory(document);
      return item;
    });
  }
}
