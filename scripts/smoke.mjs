// Disposable Gateway + synthetic HA + synthetic model. No production config or credentials.
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'ha-events-gateway-smoke-'));
const mock = createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic event received.' }, finish_reason: null }] })
      + '\n\ndata: ' + JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\ndata: [DONE]\n\n');
  });
});
mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
const port = mock.address().port;
const ws = new WebSocketServer({ server: mock, path: '/api/websocket' });
let haSocket;
const entityState = (state, at) => ({ entity_id: 'sensor.mock', state, attributes: {}, last_changed: at, last_updated: at });
ws.on('connection', socket => {
  haSocket = socket; socket.send(JSON.stringify({ type: 'auth_required', ha_version: 'mock' }));
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'auth') { assert.equal(message.access_token, 'synthetic-ha-token'); socket.send(JSON.stringify({ type: 'auth_ok' })); }
    if (message.type === 'subscribe_events') socket.send(JSON.stringify({ id: message.id, type: 'result', success: true, result: null }));
    if (message.type === 'get_states') socket.send(JSON.stringify({ id: message.id, type: 'result', success: true, result: [entityState('off', new Date(Date.now() - 10000).toISOString())] }));
  });
});
const probe = createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening'); const gatewayPort = probe.address().port;
await new Promise(resolve => probe.close(resolve));
await mkdir(join(temporary, 'workspace'), { recursive: true });
await writeFile(join(temporary, 'openclaw.json'), JSON.stringify({
  update: { checkOnStart: false },
  gateway: { mode: 'local', port: gatewayPort, bind: 'loopback', auth: { mode: 'token', token: 'synthetic-gateway-token' } },
  agents: { defaults: { workspace: join(temporary,'workspace'), model: { primary: 'mock/mock' } }, entries: { main: {} } },
  models: { providers: { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'synthetic-model-key', api: 'openai-completions', models: [{ id: 'mock', name: 'Mock', input: ['text'], reasoning: false, contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
  plugins: { allow: ['openclaw-home-assistant-events'], load: { paths: [root] }, entries: { 'openclaw-home-assistant-events': { enabled: true, config: {
    url: `http://127.0.0.1:${port}`, accessToken: { source: 'env', provider: 'default', id: 'HA_EVENTS_TEST_TOKEN' }, allowedAgents: ['main'], allowInsecureHttp: true,
  } } } },
}));
const child = spawn(process.execPath, [join(root,'node_modules/openclaw/openclaw.mjs'), 'gateway', 'run', '--port', String(gatewayPort)], {
  env: { ...process.env, OPENCLAW_STATE_DIR: temporary, OPENCLAW_CONFIG_PATH: join(temporary,'openclaw.json'), OPENCLAW_NO_AUTO_UPDATE: '1', HA_EVENTS_TEST_TOKEN: 'synthetic-ha-token' }, stdio: ['ignore','pipe','pipe'],
});
let log = ''; child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
const invoke = async (tool, args = {}) => {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/tools/invoke`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-gateway-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, args, sessionKey: 'agent:main:main' }) });
  const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body;
};
const waitFor = async (operation, timeout = 45000) => {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Gateway exited: ${log.slice(-10000)}`);
    try { const result = await operation(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${last ?? 'Timed out'}\n${log.slice(-10000)}`);
};
try {
  await waitFor(async () => { const result = await invoke('ha_events_status'); return result.result.details?.synchronized; });
  await invoke('ha_events_subscribe', { entityId: 'sensor.mock', trigger: { type: 'state', to: 'on' }, instruction: 'Acknowledge this synthetic event.' });
  const at = new Date().toISOString();
  haSocket.send(JSON.stringify({ id: 1, type: 'event', event: { event_type: 'state_changed', time_fired: at, data: { entity_id: 'sensor.mock', old_state: entityState('off', new Date(Date.now()-10000).toISOString()), new_state: entityState('on', at) } } }));
  const saved = await waitFor(async () => {
    const document = JSON.parse(await readFile(join(temporary, 'plugins/openclaw-home-assistant-events/state.json'), 'utf8'));
    return document.deliveries.some(delivery => delivery.runId) ? document : undefined;
  });
  assert.equal(saved.subscriptions[0].consumed, true);
  console.log('PASS: published Gateway loaded third-party plugin, resolved SecretRef, connected to synthetic HA, persisted subscription, and accepted isolated agent dispatch.');
  await waitFor(async () => { const result = await invoke('ha_events_status'); return result.result.details.deliveries.length === 0; });
  console.log('PASS: synthetic model run completed and durable outbox settled.');
} finally {
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
  for (const socket of ws.clients) socket.terminate();
  await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => mock.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
