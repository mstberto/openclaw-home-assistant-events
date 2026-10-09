import { compareTimestamps } from './timestamps.js';
import WebSocket from 'ws';
import { z } from 'zod';
import { entityStateSchema, stateEventSchema, type StateEvent } from './model.js';
import type { Config } from './config.js';
import { websocketUrl } from './config.js';
import type { Engine } from './engine.js';

export interface Scheduler {
  now(): number;
  schedule(params: { id: string; delayMs: number; everyMs?: number; run(): void | Promise<unknown> }): { cancel(): void };
}
/** Auth → subscribe acknowledgment → snapshot → buffered live events. No model calls here. */
export class HaConnection {
  private socket: WebSocket | undefined;
  private stopped = false;
  private failures = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private buffer: StateEvent[] = [];
  private synchronized = false;
  private lastPong = 0;
  private phase: 'auth' | 'subscribe' | 'snapshot' | 'live' = 'auth';
  private phaseDeadline = 0;
  private retry: { cancel(): void } | undefined;
  private heartbeat: { cancel(): void } | undefined;
  status: 'disconnected' | 'connecting' | 'connected' | 'auth_failed' | 'processing_error' = 'disconnected';
  constructor(private readonly config: Config, private readonly engine: Engine,
    private readonly scheduler: Scheduler, private readonly report: (message: string) => void,
    private readonly createSocket: (url: string) => WebSocket = url => new WebSocket(url, { maxPayload: 8 * 1024 * 1024, handshakeTimeout: 15000 }),
    private readonly onConnected: () => void = () => {}) {}
  start(): void {
    this.stopped = false;
    this.heartbeat = this.scheduler.schedule({ id: 'ha-heartbeat', delayMs: 10000, everyMs: 10000, run: () => {
      const socket = this.socket;
      if (!socket) return;
      if ((!this.synchronized && this.scheduler.now() > this.phaseDeadline) || this.scheduler.now() - this.lastPong > 45000) {
        socket.terminate(); return;
      }
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    } });
    this.connect();
  }
  private connect(): void {
    if (this.stopped) return;
    this.status = 'connecting'; this.synchronized = false; this.buffer = []; this.phase = 'auth';
    this.lastPong = this.scheduler.now(); this.phaseDeadline = this.scheduler.now() + 30000;
    let socket: WebSocket;
    try { socket = this.createSocket(websocketUrl(this.config.url)); }
    catch { this.reconnect(); return; }
    this.socket = socket;
    socket.on('pong', () => { this.lastPong = this.scheduler.now(); });
    socket.on('error', () => { this.report('HA WebSocket connection failed'); socket.terminate(); });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      // Retire accepted messages before disconnect/reconnect; old work cannot cross generations.
      this.tail = this.tail.then(() => { this.engine.disconnect(); }).catch(() => { this.engine.disconnect(); });
      if (this.status !== 'auth_failed') this.status = 'disconnected';
      if (!this.stopped && this.status !== 'auth_failed') this.reconnect();
    });
    socket.on('message', raw => {
      this.tail = this.tail.then(async () => {
        if (this.stopped || this.socket !== socket) return;
        await this.message(socket, JSON.parse(raw.toString()) as unknown);
      }).catch(() => {
        this.status = 'processing_error';
        this.report('HA event processing failed; reconnecting with a fresh snapshot');
        socket.terminate();
      });
    });
  }
  private reconnect(): void {
    if (this.stopped) return;
    const ceiling = Math.min(60000, 1000 * 2 ** Math.min(this.failures++, 6));
    this.retry = this.scheduler.schedule({ id: 'ha-reconnect', delayMs: ceiling * (0.5 + Math.random() / 2),
      run: async () => { await this.tail; this.connect(); } });
  }
  private async message(socket: WebSocket, raw: unknown): Promise<void> {
    const message = z.object({ type: z.string(), id: z.number().optional(), success: z.boolean().optional(), result: z.unknown().optional(), event: z.unknown().optional() }).parse(raw);
    const send = (value: unknown): void => socket.send(JSON.stringify(value));
    if (message.type === 'auth_required' && this.phase === 'auth') { send({ type: 'auth', access_token: this.config.accessToken }); return; }
    if (message.type === 'auth_invalid') { this.status = 'auth_failed'; this.report('HA authentication failed; update credentials and restart the service'); socket.close(); return; }
    if (message.type === 'auth_ok' && this.phase === 'auth') {
      this.phase = 'subscribe'; this.phaseDeadline = this.scheduler.now() + 30000;
      send({ id: 1, type: 'subscribe_events', event_type: 'state_changed' }); return;
    }
    if (message.type === 'result' && message.id === 1 && this.phase === 'subscribe') {
      if (!message.success) throw new Error('HA subscription rejected');
      this.phase = 'snapshot'; this.phaseDeadline = this.scheduler.now() + 30000;
      send({ id: 2, type: 'get_states' }); return;
    }
    if (message.type === 'result' && message.id === 2 && this.phase === 'snapshot') {
      if (!message.success) throw new Error('HA snapshot rejected');
      const snapshot = z.array(entityStateSchema).parse(message.result);
      // Reconstruct the state immediately before the first observed buffered event.
      // Otherwise a snapshot that already includes that event would hide a real transition.
      const baseline = new Map(snapshot.map(state => [state.entity_id, state]));
      const reconciled = new Map(baseline);
      const touched = new Set<string>();
      for (const event of this.buffer) {
        const { entity_id: id, old_state: before, new_state: after } = event.data;
        if (!touched.has(id)) {
          touched.add(id);
          if (before) baseline.set(id, before); else baseline.delete(id);
        }
        const known = reconciled.get(id);
        if (!known || compareTimestamps(after?.last_updated ?? event.time_fired, known.last_updated) > 0) {
          if (after) reconciled.set(id, after); else reconciled.delete(id);
        }
      }
      await this.engine.snapshot([...baseline.values()], false);
      for (const event of this.buffer) await this.engine.event(event, true);
      await this.engine.snapshot([...reconciled.values()]);
      this.buffer = []; this.synchronized = true; this.phase = 'live'; this.status = 'connected'; this.failures = 0; this.onConnected();
      return;
    }
    if (message.type === 'event' && message.id === 1) {
      const event = stateEventSchema.parse(message.event);
      if (event.data.new_state && event.data.new_state.entity_id !== event.data.entity_id) throw new Error('Entity mismatch');
      if (this.synchronized) await this.engine.event(event);
      else {
        if (this.buffer.length >= 10000) throw new Error('HA synchronization buffer full');
        this.buffer.push(event);
      }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.retry?.cancel(); this.heartbeat?.cancel();
    this.socket?.terminate(); this.socket = undefined;
    await this.tail; this.engine.disconnect(); this.status = 'disconnected';
  }
}
