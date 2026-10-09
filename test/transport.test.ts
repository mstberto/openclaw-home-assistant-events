import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { describe, it, expect, vi } from 'vitest';
import { HaConnection, type Scheduler } from '../src/transport.js';
import { Engine } from '../src/engine.js';
import { setup, state, event, time } from './helpers.js';
class FakeSocket extends EventEmitter {
  readyState = 1; sent: Record<string, unknown>[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw) as Record<string, unknown>); }
  ping() { this.emit('pong'); }
  close() { this.emit('close'); }
  terminate() { this.emit('close'); }
  message(raw: unknown) { this.emit('message', Buffer.from(JSON.stringify(raw))); }
}
class FakeScheduler implements Scheduler {
  clock = time;
  jobs = new Map<string, Parameters<Scheduler['schedule']>[0]>();
  now = () => this.clock;
  schedule(params: Parameters<Scheduler['schedule']>[0]) { this.jobs.set(params.id, params); return { cancel: () => { this.jobs.delete(params.id); } }; }
  async run(id: string) { await this.jobs.get(id)?.run(); }
}
// Flush the async repository and message chain without relying on wall-clock delays.
async function settle() { for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
async function fixture() {
  const { repository } = setup(); const scheduler = new FakeScheduler(); const sockets: FakeSocket[] = [];
  const engine = new Engine(repository, ['main'], scheduler.now);
  await engine.subscribe('main', { entityId: 'sensor.test', instruction: 'Report event', trigger: { type: 'state', to: 'on' }, oneShot: false });
  const report = vi.fn();
  const connection = new HaConnection({ url: 'https://example.test', accessToken: 'secret-token', allowedAgents: ['main'], allowInsecureHttp: false }, engine, scheduler, report,
    () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; });
  connection.start(); return { repository, scheduler, sockets, engine, connection, report };
}
async function authenticate(socket: FakeSocket) {
  socket.message({ type: 'auth_required' }); socket.message({ type: 'auth_ok' }); await settle();
  socket.message({ type: 'result', id: 1, success: true }); await settle();
}
describe('HA WebSocket protocol and recovery', () => {
  it('authenticates, waits for subscription acknowledgment, snapshots, then drains buffered events', async () => {
    const { connection, sockets, repository } = await fixture(); const socket = sockets[0]!;
    try {
      await authenticate(socket);
      expect(socket.sent.map(message => message.type)).toEqual(['auth', 'subscribe_events', 'get_states']);
      socket.message({ type: 'event', id: 1, event: event('off','on', time + 1) });
      socket.message({ type: 'result', id: 2, success: true, result: [state('off', time - 1)] }); await settle();
      expect(connection.status).toBe('connected'); expect((await repository.read()).deliveries).toHaveLength(1);
    } finally { await connection.stop(); }
  });
  it('reconnects with a new auth/subscribe/snapshot cycle and ignores the retired socket', async () => {
    const { connection, sockets, scheduler, repository } = await fixture(); const first = sockets[0]!;
    try {
      await authenticate(first); first.message({ type: 'result', id: 2, success: true, result: [state('off', time - 1)] }); await settle();
      first.close(); await settle(); await scheduler.run('ha-reconnect'); const second = sockets[1]!;
      first.message({ type: 'event', id: 1, event: event('off', 'on', time + 1) });
      await authenticate(second); second.message({ type: 'result', id: 2, success: true, result: [state('off', time + 2)] }); await settle();
      expect(connection.status).toBe('connected'); expect((await repository.read()).deliveries).toHaveLength(0);
    } finally { await connection.stop(); }
  });
  it('stops retrying invalid credentials and never reports the token', async () => {
    const { connection, sockets, scheduler, report } = await fixture();
    try {
      sockets[0]!.message({ type: 'auth_invalid', message: 'secret-token' }); await settle();
      expect(connection.status).toBe('auth_failed'); expect(scheduler.jobs.has('ha-reconnect')).toBe(false);
      expect(JSON.stringify(report.mock.calls)).not.toContain('secret-token');
    } finally { await connection.stop(); }
  });
  it('rejects a failed subscription acknowledgment instead of accepting a snapshot', async () => {
    const { connection, sockets, scheduler } = await fixture(); const socket = sockets[0]!;
    try {
      socket.message({ type: 'auth_ok' }); await settle(); socket.message({ type: 'result', id: 1, success: false }); await settle();
      expect(connection.status).not.toBe('connected'); expect(scheduler.jobs.has('ha-reconnect')).toBe(true);
      expect(socket.sent.some(message => message.type === 'get_states')).toBe(false);
    } finally { await connection.stop(); }
  });
  it('terminates silent connections after a deadline and cancels reconnect on shutdown', async () => {
    const { connection, scheduler, sockets } = await fixture(); scheduler.clock += 46000;
    await scheduler.run('ha-heartbeat'); await settle(); expect(connection.status).toBe('disconnected');
    await connection.stop(); expect(scheduler.jobs.has('ha-reconnect')).toBe(false);
    await scheduler.run('ha-reconnect'); expect(sockets).toHaveLength(1);
  });
});
it('matches observed buffered transitions even when the snapshot already contains their final state', async () => {
  const { connection, sockets, repository } = await fixture(); const socket = sockets[0]!;
  try {
    await authenticate(socket);
    socket.message({ type: 'event', id: 1, event: event('off','on', time + 1) });
    socket.message({ type: 'result', id: 2, success: true, result: [state('on', time + 1)] }); await settle();
    expect((await repository.read()).deliveries).toHaveLength(1);
  } finally { await connection.stop(); }
});
