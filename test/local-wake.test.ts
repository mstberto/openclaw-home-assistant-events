import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalWake, LOCAL_WAKE_PATH } from '../src/local-wake.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function fixture(run: (signal: AbortSignal) => Promise<void> = async () => {}, timeoutMs = 1000, inspect?: (req: IncomingMessage) => Promise<void>) {
  const wake = new LocalWake(); const controller = new AbortController();
  let credential = ''; let arrivals = 0;
  const server = createServer((req, res) => {
    arrivals++; credential = req.headers.authorization ?? '';
    void (async () => { await inspect?.(req); await wake.handle(req, res); })().catch(() => { res.writeHead(500); res.end(); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test listener');
  const url = new URL(`http://127.0.0.1:${address.port}${LOCAL_WAKE_PATH}`);
  const binding = { url, signal: controller.signal, timeoutMs, run };
  wake.start(binding);
  cleanups.push(async () => { await wake.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { wake, controller, server, url, binding, credential: () => credential, arrivals: () => arrivals };
}
const post = (url: URL, authorization?: string): Promise<number> => new Promise((resolve, reject) => {
  const req = request(url, { method: 'POST', agent: false, ...(authorization ? { headers: { Authorization: authorization } } : {}) }, res => { res.resume(); resolve(res.statusCode ?? 0); });
  req.once('error', reject); req.end();
});
it('runs once, rejects unauthenticated requests, and refuses a replayed credential', async () => {
  const run = vi.fn(async () => {}); const f = await fixture(run);
  expect(await post(f.url)).toBe(403);
  await f.wake.wake(); const old = f.credential();
  expect(run).toHaveBeenCalledOnce();
  expect(await post(f.url, old)).toBe(403);
  await f.wake.wake(); expect(run).toHaveBeenCalledTimes(2);
  expect(f.credential()).not.toBe(old);
});
it('coalesces concurrent wake calls and rejects credential replay while dispatch is running', async () => {
  let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
  let release!: () => void; const run = vi.fn(async () => { entered(); await new Promise<void>(r => { release = r; }); });
  const f = await fixture(run); const first = f.wake.wake(); await started;
  const credential = f.credential(); await f.wake.wake(); expect(f.arrivals()).toBe(1);
  expect(await post(f.url, credential)).toBe(403);
  release(); await first; expect(run).toHaveBeenCalledOnce();
});
it('abort on a deadline reaches the handler and does not start another handler during cleanup', async () => {
  let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
  let release!: () => void; let signal!: AbortSignal;
  const f = await fixture(async s => { signal = s; entered(); await new Promise<void>(r => { release = r; }); }, 1000);
  const failed = expect(f.wake.wake()).rejects.toThrow('transport failed'); await started; await failed;
  if (!signal.aborted) await once(signal, 'abort');
  expect(signal.aborted).toBe(true);
  await f.wake.wake(); expect(f.arrivals()).toBe(1);
  release();
});
it('stop cancels execution and waits for handler cleanup before allowing a new generation', async () => {
  let entered!: () => void; const started = new Promise<void>(r => { entered = r; });
  let release!: () => void; let signal!: AbortSignal;
  const f = await fixture(async s => { signal = s; entered(); await new Promise<void>(r => { release = r; }); });
  const client = f.wake.wake().catch(() => {}); await started; const old = f.credential();
  let stopped = false; const stop = f.wake.stop().then(() => { stopped = true; });
  await new Promise(r => setTimeout(r, 10)); expect(signal.aborted).toBe(true); expect(stopped).toBe(false);
  release(); await stop; await client;
  f.wake.start({ ...f.binding, run: async () => {} });
  expect(await post(f.url, old)).toBe(403); await f.wake.wake();
});
it('refuses remote peers, methods, and bodies before consuming a valid ticket', async () => {
  const run = vi.fn(async () => {});
  let wake!: LocalWake;
  const f = await fixture(run, 1000, async req => {
    for (const [peer, method, headers, status] of [
      ['192.0.2.1', 'POST', {}, 403],
      ['127.0.0.1', 'GET', {}, 403],
      ['127.0.0.1', 'POST', { 'content-length': '100' }, 400],
      ['127.0.0.1', 'POST', { 'transfer-encoding': 'chunked' }, 400],
    ] as const) {
      const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
      await wake.handle({ socket: { remoteAddress: peer }, method,
        headers: { authorization: req.headers.authorization, ...headers } } as unknown as IncomingMessage, res);
      expect(res.writeHead).toHaveBeenCalledWith(status);
      expect(run).not.toHaveBeenCalled();
    }
  });
  wake = f.wake; await wake.wake(); expect(run).toHaveBeenCalledOnce();
});
it('rejects non-loopback URLs and TLS rather than weakening certificate validation', () => {
  const wake = new LocalWake(); const signal = new AbortController().signal;
  for (const url of ['http://example.com', 'https://127.0.0.1', 'http://name:password@127.0.0.1']) {
    expect(() => wake.start({ url: new URL(url + LOCAL_WAKE_PATH), signal, timeoutMs: 1000, run: async () => {} })).toThrow('HTTP');
  }
});
it('does not follow a redirect or forward its credential to another endpoint', async () => {
  const wake = new LocalWake(); let redirected = 0; let attempts = 0;
  const server = createServer((req, res) => {
    if (req.url === LOCAL_WAKE_PATH) { attempts++; res.writeHead(302, { Location: '/other' }); res.end(); }
    else { redirected++; res.writeHead(204); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test listener');
  wake.start({ url: new URL(`http://127.0.0.1:${address.port}${LOCAL_WAKE_PATH}`), signal: new AbortController().signal, timeoutMs: 1000, run: async () => {} });
  cleanups.push(async () => { await wake.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await expect(wake.wake()).rejects.toThrow('refused'); expect(redirected).toBe(0);
  await expect(wake.wake()).resolves.toBeUndefined(); expect(attempts).toBe(1);
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 1100);
  await expect(wake.wake()).rejects.toThrow('refused'); expect(attempts).toBe(2); expect(redirected).toBe(0);
});
