import { emptyDocument, type StateDocument, type StateEvent, type EntityState } from '../src/model.js';
import { Repository } from '../src/repository.js';
export class MemoryStore {
  document: StateDocument | undefined;
  fail = false;
  async lookup(): Promise<StateDocument | undefined> { return this.document === undefined ? undefined : structuredClone(this.document); }
  async register(_key: string, value: StateDocument): Promise<void> {
    if (this.fail) throw new Error('disk failure');
    this.document = structuredClone(value);
  }
}
export function setup() {
  const store = new MemoryStore(); store.document = emptyDocument();
  return { store, repository: new Repository(store) };
}
export const time = Date.parse('2026-01-01T00:00:00Z');
export function state(value: string, at = time, entity = 'sensor.test', changed = at): EntityState {
  return { entity_id: entity, state: value, last_updated: new Date(at).toISOString(), last_changed: new Date(changed).toISOString() };
}
export function event(before: string | null, after: string | null, at = time, entity = 'sensor.test'): StateEvent {
  return { event_type: 'state_changed', time_fired: new Date(at).toISOString(), data: {
    entity_id: entity, old_state: before === null ? null : state(before, at - 1, entity), new_state: after === null ? null : state(after, at, entity),
  } };
}
