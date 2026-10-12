import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../src/engine.js';
import { DispatchPreflightError, Outbox } from '../src/outbox.js';
import { setup, state, event, time } from './helpers.js';
async function queued() {
  const fixture = setup(); const engine = new Engine(fixture.repository, ['main'], () => time);
  await engine.subscribe('main', { entityId: 'sensor.test', trigger: { type: 'state', to: 'on' }, instruction: 'Report event' }, undefined,
    { sessionKey: 'agent:main:main', sessionId: '11111111-1111-4111-8111-111111111111', senderIsOwner: false });
  await engine.snapshot([state('off', time - 1)]); await engine.event(event('off','on', time + 1));
  return { ...fixture, engine };
}
function dispatcher(action: () => Promise<{ persisted: boolean; failureReason?: string }> = async () => ({ persisted: true })) {
  const execute = vi.fn(action); return { prepare: vi.fn(() => ({ execute })), execute };
}
describe('handoff outbox', () => {
  it('wakes only for due allowed work and processes one event per admitted request', async () => {
    const { repository, engine } = await queued();
    await engine.subscribe('main', { entityId: 'sensor.test', trigger: { type: 'state', to: 'off' }, instruction: 'Second event' }, undefined,
      { sessionKey: 'agent:main:main', sessionId: '11111111-1111-4111-8111-111111111111', senderIsOwner: false });
    await engine.event(event('on', 'off', time + 2));
    const dispatch = dispatcher(); const outbox = new Outbox(repository, dispatch, ['main'], () => time);
    expect(await new Outbox(repository, dispatch, [], () => time).hasDueWork()).toBe(false);
    expect(await outbox.hasDueWork()).toBe(true);
    await outbox.drain(undefined, 1); expect(dispatch.execute).toHaveBeenCalledOnce();
    expect(await outbox.hasDueWork()).toBe(true);
    await outbox.drain(undefined, 1); expect(await outbox.hasDueWork()).toBe(false);
  });
  it('does not reserve an event when its wake request was already cancelled', async () => {
    const { repository } = await queued(); const dispatch = dispatcher(); const controller = new AbortController(); controller.abort();
    await new Outbox(repository, dispatch, ['main'], () => time).drain(controller.signal, 1);
    expect(dispatch.execute).not.toHaveBeenCalled(); expect((await repository.read()).deliveries[0]?.status).toBe('pending');
  });
  it('commits running before effects, retains delivered history, and never replays it', async () => {
    const { repository } = await queued();
    const dispatch = dispatcher(async () => { expect((await repository.read()).deliveries[0]?.status).toBe('running'); return { persisted: true }; });
    await new Outbox(repository, dispatch, ['main'], () => time).drain();
    const restarted = new Outbox(repository, dispatch, ['main'], () => time + 1000);
    await restarted.recover(); await restarted.drain();
    expect(dispatch.execute).toHaveBeenCalledTimes(1); expect((await repository.read()).deliveries[0]?.status).toBe('delivered');
  });
  it('retries only preflight failures and caps attempts', async () => {
    const { repository } = await queued(); let now = time;
    const dispatch = dispatcher(); dispatch.prepare.mockImplementation(() => { throw new DispatchPreflightError('offline'); });
    const outbox = new Outbox(repository, dispatch, ['main'], () => now);
    await outbox.drain(); await outbox.drain(); expect(dispatch.prepare).toHaveBeenCalledTimes(1);
    for (let i = 1; i < 12; i++) { now += 300001; await outbox.drain(); }
    expect((await repository.read()).deliveries[0]?.status).toBe('failed'); expect(dispatch.execute).not.toHaveBeenCalled();
  });
  it('marks a completed run without persistence evidence uncertain; no automatic replay', async () => {
    const { repository } = await queued(); const dispatch = dispatcher(async () => ({ persisted: false }));
    const outbox = new Outbox(repository, dispatch, ['main'], () => time);
    await outbox.drain(); await outbox.drain(); expect(dispatch.execute).toHaveBeenCalledTimes(1);
    expect((await repository.read()).deliveries[0]?.status).toBe('uncertain');
  });
  it('retains a dispatch diagnostic while keeping uncertain work out of automatic retries', async () => {
    const { repository } = await queued();
    const reason = 'Runtime failure: inactive runtime; manual review required';
    const dispatch = dispatcher(async () => ({ persisted: false, failureReason: reason }));
    const outbox = new Outbox(repository, dispatch, ['main'], () => time);
    await outbox.drain(); await outbox.recover(); await outbox.drain();
    expect((await repository.read()).deliveries[0]).toMatchObject({ status: 'uncertain', reason });
    expect(dispatch.execute).toHaveBeenCalledOnce();
  });
  it('converts interrupted running and legacy accepted records to uncertain on startup', async () => {
    const { repository } = await queued(); const dispatch = dispatcher();
    for (const status of ['running', 'accepted'] as const) {
      await repository.transact(doc => { doc.deliveries[0]!.status = status; });
      const outbox = new Outbox(repository, dispatch, ['main'], () => time);
      await outbox.recover(); await outbox.drain(); expect((await repository.read()).deliveries[0]?.status).toBe('uncertain');
    }
    expect(dispatch.execute).not.toHaveBeenCalled();
  });
  it('requires manual duplicate-risk acknowledgement and enforces review ownership', async () => {
    const { repository, engine } = await queued(); const dispatch = dispatcher(async () => ({ persisted: false }));
    const outbox = new Outbox(repository, dispatch, ['main'], () => time); await outbox.drain();
    const id = (await repository.read()).deliveries[0]!.id;
    await expect(engine.resolveDelivery('main', id, 'retry', false)).rejects.toThrow('acknowledgement');
    await expect(engine.resolveDelivery('other', id, 'dismissed', false)).rejects.toThrow('allowed');
    await engine.resolveDelivery('main', id, 'retry', true); await outbox.drain(); expect(dispatch.execute).toHaveBeenCalledTimes(2);
    await engine.resolveDelivery('main', id, 'delivered', false); await outbox.drain(); expect(dispatch.execute).toHaveBeenCalledTimes(2);
    expect((await repository.read()).deliveries[0]?.reviews).toBe(2);
  });
  it('never dispatches to an agent removed from the allowlist', async () => {
    const { repository } = await queued(); const dispatch = dispatcher();
    await new Outbox(repository, dispatch, [], () => time).drain(); expect(dispatch.execute).not.toHaveBeenCalled();
  });
  it('does not execute if the running reservation cannot be saved', async () => {
    const { repository, store } = await queued(); const dispatch = dispatcher(); store.fail = true;
    await expect(new Outbox(repository, dispatch, ['main'], () => time).drain()).rejects.toThrow('disk');
    expect(dispatch.execute).not.toHaveBeenCalled(); expect(store.document?.deliveries[0]?.status).toBe('pending');
  });
  it('leaves a failed final write running; restart marks uncertain and never repeats the effect', async () => {
    const { repository, store } = await queued(); const dispatch = dispatcher(async () => { store.fail = true; return { persisted: true }; });
    await expect(new Outbox(repository, dispatch, ['main'], () => time).drain()).rejects.toThrow('disk');
    expect(store.document?.deliveries[0]?.status).toBe('running'); store.fail = false;
    const restarted = new Outbox(repository, dispatch, ['main'], () => time); await restarted.recover(); await restarted.drain();
    expect((await repository.read()).deliveries[0]?.status).toBe('uncertain'); expect(dispatch.execute).toHaveBeenCalledTimes(1);
  });
  it('preserves uncertain work when its watcher is removed', async () => {
    const { repository, engine } = await queued(); const dispatch = dispatcher(async () => ({ persisted: false }));
    await new Outbox(repository, dispatch, ['main'], () => time).drain();
    await engine.remove('main', (await repository.read()).subscriptions[0]!.id);
    expect((await repository.read()).deliveries[0]?.status).toBe('uncertain');
  });
  it('rejects review from another allowed agent and while execution is running', async () => {
    const { repository } = await queued(); const engine = new Engine(repository, ['main', 'other'], () => time);
    const id = (await repository.read()).deliveries[0]!.id;
    await repository.transact(doc => { doc.deliveries[0]!.status = 'uncertain'; });
    await expect(engine.resolveDelivery('other', id, 'dismissed', false)).rejects.toThrow('owned');
    await repository.transact(doc => { doc.deliveries[0]!.status = 'running'; });
    await expect(engine.resolveDelivery('main', id, 'retry', true)).rejects.toThrow('Only');
  });
  it('does not invoke an event removed during preflight', async () => {
    const { repository, engine } = await queued(); const dispatch = dispatcher();
    const id = (await repository.read()).subscriptions[0]!.id;
    let removal: Promise<boolean> | undefined;
    dispatch.prepare.mockImplementation(() => { removal = engine.remove('main', id); return { execute: dispatch.execute }; });
    await new Outbox(repository, dispatch, ['main'], () => time).drain(); await removal;
    expect(dispatch.execute).not.toHaveBeenCalled(); expect((await repository.read()).deliveries).toHaveLength(0);
  });
});
