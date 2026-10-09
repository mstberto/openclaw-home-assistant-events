import type { EntityState, Subscription, StateEvent } from './model.js';

/** HA unavailable/unknown and non-numeric strings never satisfy numeric triggers. */
export function inRange(state: string | undefined, trigger: Extract<Subscription['input']['trigger'], { type: 'numeric' }>): boolean {
  if (state === undefined || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(state.trim())) return false;
  const number = Number(state);
  return Number.isFinite(number) && (trigger.above === undefined || number > trigger.above)
    && (trigger.below === undefined || number < trigger.below);
}
export function matchesTransition(subscription: Subscription, event: StateEvent): boolean {
  const oldState = event.data.old_state?.state;
  const newState = event.data.new_state?.state;
  if (newState === undefined || newState === oldState) return false;
  const trigger = subscription.input.trigger;
  if (trigger.type === 'numeric') return inRange(newState, trigger) && !inRange(oldState, trigger);
  return trigger.type === 'state' && newState === trigger.to && (trigger.from === undefined || oldState === trigger.from);
}
export function updateDuration(subscription: Subscription, current: EntityState | undefined, now: number): void {
  const trigger = subscription.input.trigger;
  if (trigger.type !== 'state_for') return;
  if (!current || current.state !== trigger.state) { delete subscription.armed; return; }
  const changed = Date.parse(current.last_changed);
  // A watcher starts counting at subscription creation, never retroactively.
  const since = Math.max(changed, subscription.createdAt);
  if (!Number.isFinite(since) || since > now) { delete subscription.armed; return; }
  subscription.armed = { since, transitionId: current.last_changed };
}

export class EntityIndex {
  private readonly byEntity = new Map<string, string[]>();
  rebuild(subscriptions: Subscription[]): void {
    this.byEntity.clear();
    for (const subscription of subscriptions) {
      if (subscription.consumed) continue;
      const ids = this.byEntity.get(subscription.input.entityId) ?? [];
      ids.push(subscription.id);
      this.byEntity.set(subscription.input.entityId, ids);
    }
  }
  ids(entityId: string): readonly string[] { return this.byEntity.get(entityId) ?? []; }
}
