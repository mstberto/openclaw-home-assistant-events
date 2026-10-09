import { describe, it, expect } from 'vitest';
import { Engine } from '../src/engine.js';
import { setup, state, event, time } from './helpers.js';
const input = { entityId: 'sensor.test', instruction: 'Report the matched event', trigger: { type: 'state', to: 'on' } };
describe('persistent subscriptions and deterministic matching', () => {
  it('matches only the indexed entity and consumes one-shot watchers atomically', async () => {
    const { repository } = setup(); const engine = new Engine(repository, ['main'], () => time);
    await engine.load(); await engine.subscribe('main', input); await engine.snapshot([state('off', time - 10)]);
    await engine.event(event('off', 'on', time + 1, 'sensor.other'));
    expect((await repository.read()).deliveries).toHaveLength(0);
    await engine.event(event('off', 'on', time + 1));
    await engine.event(event('on', 'off', time + 2)); await engine.event(event('off', 'on', time + 3));
    const saved = await repository.read(); expect(saved.deliveries).toHaveLength(1); expect(saved.subscriptions[0]?.consumed).toBe(true);
  });
  it('rejects owner spoofing and hides other agents subscriptions', async () => {
    const { repository } = setup(); const engine = new Engine(repository, ['a', 'b'], () => time);
    const subscription = await engine.subscribe('a', input);
    expect(await engine.list('b')).toEqual([]); expect(await engine.remove('b', subscription.id)).toBe(false);
    await expect(engine.subscribe('unknown', input)).rejects.toThrow('not allowed');
    await expect(engine.subscribe('a', { ...input, agentId: 'b' })).rejects.toThrow();
  });
  it('recurring watchers fire once per transition and ignore attribute-only changes and duplicates', async () => {
    const { repository } = setup(); const engine = new Engine(repository, ['main'], () => time);
    await engine.subscribe('main', { ...input, oneShot: false }); await engine.snapshot([state('off', time - 1)]);
    await engine.event(event('off', 'on', time + 1)); await engine.event(event('off', 'on', time + 1));
    await engine.event(event('on', 'on', time + 2)); await engine.event(event('on', 'off', time + 3));
    await engine.event(event('off', 'on', time + 4)); expect((await repository.read()).deliveries).toHaveLength(2);
  });
  it('numeric ranges use strict boundaries and entry crossings', async () => {
    const { repository } = setup(); const engine = new Engine(repository, ['main'], () => time);
    await engine.subscribe('main', { ...input, oneShot: false, trigger: { type: 'numeric', above: 10, below: 20 } });
    await engine.snapshot([state('10', time - 1)]);
    for (const [i, values] of [['10','11'], ['11','15'], ['15','20'], ['20','19'], ['19','unknown'], ['unknown','unavailable']].entries())
      await engine.event(event(values[0]!, values[1]!, time + i + 1));
    expect((await repository.read()).deliveries).toHaveLength(2);
    await expect(engine.subscribe('main', { ...input, trigger: { type: 'numeric' } })).rejects.toThrow();
    await expect(engine.subscribe('main', { ...input, trigger: { type: 'numeric', above: 20, below: 10 } })).rejects.toThrow();
  });
  it('from filters suppress nonmatching transitions and late events', async () => {
    const { repository } = setup(); const engine = new Engine(repository, ['main'], () => time);
    await engine.subscribe('main', { ...input, trigger: { type: 'state', from: 'off', to: 'on' } });
    await engine.snapshot([state('off', time + 10)]); await engine.event(event('off', 'on', time));
    await engine.event(event('unknown', 'on', time + 20)); expect((await repository.read()).deliveries).toHaveLength(0);
  });
  it('removal cancels queued events, and revoked invocation cannot mutate state', async () => {
    const { repository } = setup(); const engine = new Engine(repository, ['main'], () => time);
    const subscription = await engine.subscribe('main', input); await engine.snapshot([state('off', time - 1)]);
    await engine.event(event('off', 'on', time + 1));
    await expect(engine.remove('main', subscription.id, () => { throw new Error('revoked'); })).rejects.toThrow('revoked');
    expect(await engine.remove('main', subscription.id)).toBe(true); expect((await repository.read()).deliveries).toEqual([]);
  });
  it('persistence failure leaves one-shot active and event can be retried', async () => {
    const { repository, store } = setup(); const engine = new Engine(repository, ['main'], () => time);
    await engine.subscribe('main', input); await engine.snapshot([state('off', time - 1)]);
    store.fail = true; await expect(engine.event(event('off', 'on', time + 1))).rejects.toThrow('disk');
    expect(store.document?.subscriptions[0]?.consumed).toBe(false);
    store.fail = false; await engine.event(event('off', 'on', time + 1)); expect((await repository.read()).deliveries).toHaveLength(1);
  });
  it('serializes concurrent watcher creation and refuses corrupt documents', async () => {
    const { repository, store } = setup(); const engine = new Engine(repository, ['main'], () => time);
    await Promise.all(Array.from({ length: 10 }, () => engine.subscribe('main', input)));
    expect(await engine.list('main')).toHaveLength(10);
    store.document = { version: 99 } as unknown as typeof store.document;
    await expect(repository.read()).rejects.toThrow();
  });
});
describe('state_for restart and reconnect', () => {
  it('waits for fresh synchronization after restart, preserves confirmed duration, and fires once', async () => {
    const { repository } = setup(); let now = time;
    const inputFor = { ...input, oneShot: false, trigger: { type: 'state_for', state: 'on', durationMs: 1000 } };
    const first = new Engine(repository, ['main'], () => now); await first.subscribe('main', inputFor);
    await first.snapshot([state('on', time - 5000)]); now += 500; await first.tick(); expect((await repository.read()).deliveries).toHaveLength(0);
    const second = new Engine(repository, ['main'], () => now); await second.load(); now += 1500;
    await second.tick(); expect((await repository.read()).deliveries).toHaveLength(0);
    await second.snapshot([state('on', time - 5000)]); await second.tick(); await second.tick();
    expect((await repository.read()).deliveries).toHaveLength(1);
    const third = new Engine(repository, ['main'], () => now); await third.load(); await third.snapshot([state('on', time - 5000)]); await third.tick();
    expect((await repository.read()).deliveries).toHaveLength(1);
  });
  it('cancels duration when state exits or entity is removed and rearms on a new transition', async () => {
    const { repository } = setup(); let now = time;
    const engine = new Engine(repository, ['main'], () => now);
    await engine.subscribe('main', { ...input, oneShot: false, trigger: { type: 'state_for', state: 'on', durationMs: 1000 } });
    await engine.snapshot([state('on')]); now += 500; await engine.event(event('on', null, now)); now += 2000;
    await engine.tick(); expect((await repository.read()).deliveries).toHaveLength(0);
    await engine.event(event(null, 'on', now)); now += 1000; await engine.tick(); expect((await repository.read()).deliveries).toHaveLength(1);
  });
  it('restarts duration if HA reports a later transition across a connection gap', async () => {
    const { repository } = setup(); let now = time; const engine = new Engine(repository, ['main'], () => now);
    await engine.subscribe('main', { ...input, trigger: { type: 'state_for', state: 'on', durationMs: 1000 } });
    await engine.snapshot([state('on')]); engine.disconnect(); now += 5000;
    await engine.snapshot([state('on', now)]); await engine.tick(); expect((await repository.read()).deliveries).toHaveLength(0);
    now += 1000; await engine.tick(); expect((await repository.read()).deliveries).toHaveLength(1);
  });
});
it('suspends disallowed owners without consuming their watchers after a reload', async () => {
  const { repository } = setup(); const first = new Engine(repository, ['main'], () => time);
  await first.subscribe('main', input);
  const second = new Engine(repository, ['other'], () => time); await second.load();
  await second.snapshot([state('off', time - 1)]); await second.event(event('off', 'on', time + 1));
  expect((await repository.read()).deliveries).toHaveLength(0);
  expect((await repository.read()).subscriptions[0]?.consumed).toBe(false);
});
it('preserves separate HA transitions within one millisecond', async () => {
  const { repository } = setup(); const engine = new Engine(repository, ['main'], () => time);
  await engine.subscribe('main', { ...input, oneShot: false }); await engine.snapshot([state('off', time - 1)]);
  for (const [index, pair] of [['off', 'on'], ['on', 'off'], ['off', 'on']].entries()) {
    const next = event(pair[0]!, pair[1]!, time);
    const timestamp = `2026-01-01T00:00:00.00000${index + 1}Z`;
    next.time_fired = timestamp; next.data.new_state!.last_changed = timestamp; next.data.new_state!.last_updated = timestamp;
    await engine.event(next);
  }
  expect((await repository.read()).deliveries).toHaveLength(2);
});
