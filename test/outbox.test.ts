import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../src/engine.js';
import { Outbox } from '../src/outbox.js';
import { setup, state, event, time } from './helpers.js';
async function queued() {
  const fixture = setup(); const engine = new Engine(fixture.repository, ['main'], () => time);
  await engine.subscribe('main', { entityId: 'sensor.test', trigger: { type: 'state', to: 'on' }, instruction: 'Report event' });
  await engine.snapshot([state('off', time - 1)]); await engine.event(event('off','on', time + 1));
  return fixture;
}
describe('durable outbox', () => {
  it('persists accepted run IDs, observes completion after restart, and does not submit twice', async () => {
    const { repository } = await queued(); let now = time;
    const dispatcher = { submit: vi.fn(async () => ({ runId: 'run-1' })), observe: vi.fn(async () => 'ok' as const) };
    await new Outbox(repository, dispatcher, ['main'], () => now).drain();
    expect((await repository.read()).deliveries[0]?.runId).toBe('run-1'); now += 1000;
    await new Outbox(repository, dispatcher, ['main'], () => now).drain();
    expect(dispatcher.submit).toHaveBeenCalledTimes(1); expect((await repository.read()).deliveries).toHaveLength(0);
  });
  it('retries failed admission with the same event ID and caps attempts', async () => {
    const { repository } = await queued(); let now = time;
    const dispatcher = { submit: vi.fn(async () => { throw new Error('offline'); }), observe: vi.fn(async () => 'pending' as const) };
    const outbox = new Outbox(repository, dispatcher, ['main'], () => now);
    await outbox.drain(); await outbox.drain(); expect(dispatcher.submit).toHaveBeenCalledTimes(1);
    for (let i = 1; i < 12; i++) { now += 300001; await outbox.drain(); }
    expect((await repository.read()).deliveries[0]?.status).toBe('failed');
    const ids = dispatcher.submit.mock.calls as unknown as Array<[{ id: string }]>;
    expect(new Set(ids.map(call => call[0].id)).size).toBe(1);
  });
  it('does not resubmit accepted runs on observation timeout or terminal failure', async () => {
    const { repository } = await queued(); let now = time;
    const dispatcher = { submit: vi.fn(async () => ({ runId: 'run' })), observe: vi.fn(async () => 'pending' as 'pending' | 'error') };
    const outbox = new Outbox(repository, dispatcher, ['main'], () => now);
    await outbox.drain(); now += 1000; await outbox.drain();
    expect((await repository.read()).deliveries[0]?.status).toBe('accepted');
    dispatcher.observe.mockResolvedValue('error'); now += 30000; await outbox.drain();
    expect((await repository.read()).deliveries[0]?.status).toBe('failed'); expect(dispatcher.submit).toHaveBeenCalledTimes(1);
  });
  it('never dispatches to an agent removed from the allowlist', async () => {
    const { repository } = await queued(); const dispatcher = { submit: vi.fn(async () => ({ runId: 'run' })), observe: vi.fn(async () => 'ok' as const) };
    await new Outbox(repository, dispatcher, [], () => time).drain(); expect(dispatcher.submit).not.toHaveBeenCalled();
  });
  it('does not mark admission as rejected when receipt persistence fails', async () => {
    const { repository, store } = await queued();
    const dispatcher = { submit: vi.fn(async () => { store.fail = true; return { runId: 'run' }; }), observe: vi.fn(async () => 'ok' as const) };
    await expect(new Outbox(repository, dispatcher, ['main'], () => time).drain()).rejects.toThrow('disk');
    expect(store.document?.deliveries[0]?.attempts).toBe(0);
  });
});
