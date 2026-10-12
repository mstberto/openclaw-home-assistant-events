import { randomBytes, timingSafeEqual } from 'node:crypto';
import { request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const LOCAL_WAKE_PATH = '/plugins/openclaw-home-assistant-events/internal-wake';
const loopbackPeers = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
interface Ticket {
  credential: Buffer;
  consumed: boolean;
  controller: AbortController;
}
interface Binding {
  url: URL;
  signal: AbortSignal;
  timeoutMs: number;
  run: (signal: AbortSignal) => Promise<void>;
}

/** A one-use loopback request obtains fresh host admission without core imports. */
export class LocalWake {
  private binding: Binding | undefined;
  private ticket: Ticket | undefined;
  private failures = 0;
  private retryAt = 0;
  private readonly handlers = new Set<Promise<void>>();

  start(binding: Binding): void {
    if (this.binding) throw new Error('Internal wake is already running');
    if (binding.url.protocol !== 'http:' || binding.url.hostname !== '127.0.0.1' || binding.url.pathname !== LOCAL_WAKE_PATH || binding.url.username || binding.url.password) {
      throw new Error('Internal wake requires the Gateway HTTP listener on 127.0.0.1');
    }
    if (!Number.isSafeInteger(binding.timeoutMs) || binding.timeoutMs < 1) throw new Error('Invalid internal wake timeout');
    this.binding = binding;
    this.failures = 0;
    this.retryAt = 0;
  }

  async wake(): Promise<void> {
    const binding = this.binding;
    if (!binding || binding.signal.aborted || this.ticket || Date.now() < this.retryAt) return;
    const ticket: Ticket = { credential: Buffer.from('Bearer ' + randomBytes(32).toString('hex')), consumed: false, controller: new AbortController() };
    this.ticket = ticket;
    const signal = AbortSignal.any([binding.signal, ticket.controller.signal]);
    try {
      await new Promise<void>((resolve, reject) => {
        // Node HTTP follows no redirects and has no implicit five-minute fetch deadline.
        const req = request(binding.url, { method: 'POST', agent: false, signal, maxHeaderSize: 4096,
          headers: { Authorization: ticket.credential.toString(), 'Content-Length': '0' } }, res => {
          res.resume();
          if (res.statusCode !== 204) { req.destroy(); reject(new Error('Internal wake request was refused')); return; }
          res.once('end', resolve);
          res.once('error', () => reject(new Error('Internal wake response failed')));
        });
        const deadline = setTimeout(() => {
          ticket.controller.abort();
          req.destroy(new Error('Internal wake deadline exceeded'));
        }, binding.timeoutMs);
        deadline.unref();
        req.once('close', () => clearTimeout(deadline));
        req.once('error', () => reject(new Error('Internal wake transport failed')));
        req.end();
      });
      if (this.binding === binding) { this.failures = 0; this.retryAt = 0; }
    } catch (error) {
      // No queue entry is re-submitted here. The handler's durable state owns retries.
      if (this.binding === binding && !binding.signal.aborted) {
        this.failures++;
        this.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(this.failures - 1, 5));
      }
      throw error;
    } finally {
      // A lost response cannot issue another request while the handler is executing.
      if (!ticket.consumed && this.ticket === ticket) this.ticket = undefined;
    }
  }

  readonly handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const binding = this.binding;
    const ticket = this.ticket;
    const header = req.headers.authorization;
    const supplied = Buffer.from(typeof header === 'string' && header.length <= 128 ? header : '');
    if (!binding || binding.signal.aborted || !ticket || ticket.consumed || ticket.controller.signal.aborted || req.method !== 'POST'
      || !loopbackPeers.has(req.socket.remoteAddress ?? '') || supplied.length !== ticket.credential.length
      || !timingSafeEqual(supplied, ticket.credential)) {
      res.writeHead(403); res.end(); return;
    }
    if (req.headers['transfer-encoding'] || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
      res.writeHead(400); res.end(); return;
    }
    ticket.consumed = true;
    const disconnect = (): void => { if (!res.writableFinished) ticket.controller.abort(); };
    res.once('close', disconnect);
    const work = (async () => {
      try {
        await binding.run(AbortSignal.any([binding.signal, ticket.controller.signal]));
        if (!res.destroyed) { res.writeHead(204); res.end(); }
      } catch {
        if (!res.destroyed) { res.writeHead(503); res.end(); }
      } finally {
        res.removeListener('close', disconnect);
        if (this.ticket === ticket) this.ticket = undefined;
      }
    })();
    this.handlers.add(work);
    try { await work; } finally { this.handlers.delete(work); }
  };

  async stop(): Promise<void> {
    this.binding = undefined;
    this.ticket?.controller.abort();
    await Promise.allSettled([...this.handlers]);
    this.ticket = undefined;
  }
}
