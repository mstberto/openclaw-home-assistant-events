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
const activationProbe = process.argv.includes('--activation');
const temporary = await mkdtemp(join(tmpdir(), 'ha-events-gateway-smoke-'));
const captures = []; let stall = false;
const mock = createServer((request, response) => {
  let raw = ''; request.on('data', data => { raw += data; });
  request.on('end', () => {
    const input = JSON.parse(raw); captures.push(input);
    const lastUser = input.messages.findLastIndex(message => message.role === 'user' && JSON.stringify(message).includes('home_assistant_event'));
    const eventTurn = lastUser >= 0;
    if (eventTurn && stall) return;
    const content = eventTurn ? input.messages[lastUser].content : '';
    const eventText = typeof content === 'string' ? content : JSON.stringify(content);
    const eventId = eventText.match(/"eventId":"([^"]+)"/)?.[1] ?? eventText.match(/eventId\\":\\"([^\\"]+)/)?.[1];
    if (eventTurn) assert(eventId, 'Synthetic event ID must be readable');
    const send = eventTurn && !input.messages.slice(lastUser + 1).some(message => message.role === 'tool');
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: send ? { role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic_send', type: 'function', function: { name: 'message', arguments: JSON.stringify({ action: 'send', channel: 'ha-test', target: '123', message: `Synthetic church reminder: ${eventId}` }) } }] } : { role: 'assistant', content: 'Synthetic event received.' }, finish_reason: null }] })
      + '\n\ndata: ' + JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: send ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\ndata: [DONE]\n\n');
  });
});
mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
const port = mock.address().port;
const ws = new WebSocketServer({ server: mock, path: '/api/websocket' });
let haSocket; let currentState = 'off';
const entityState = (state, at) => ({ entity_id: 'sensor.mock', state, attributes: {}, last_changed: at, last_updated: at });
ws.on('connection', socket => {
  haSocket = socket; socket.send(JSON.stringify({ type: 'auth_required', ha_version: 'mock' }));
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'auth') { assert.equal(message.access_token, 'synthetic-ha-token'); socket.send(JSON.stringify({ type: 'auth_ok' })); }
    if (message.type === 'subscribe_events') socket.send(JSON.stringify({ id: message.id, type: 'result', success: true, result: null }));
    if (message.type === 'get_states') socket.send(JSON.stringify({ id: message.id, type: 'result', success: true, result: [entityState(currentState, new Date(Date.now() - 10000).toISOString())] }));
  });
});
const probe = createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening'); const gatewayPort = probe.address().port;
await new Promise(resolve => probe.close(resolve));
await mkdir(join(temporary, 'workspace'), { recursive: true });
await writeFile(join(temporary, 'openclaw.json'), JSON.stringify({
  update: { checkOnStart: false },
  gateway: { mode: 'local', port: gatewayPort, bind: 'loopback', auth: { mode: 'token', token: 'synthetic-gateway-token' } },
  agents: { defaults: { workspace: join(temporary,'workspace'), model: { primary: 'mock/mock' } }, entries: { main: {} } },
  models: { providers: { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'synthetic-model-key', api: 'openai-completions', models: [{ id: 'mock', name: 'Mock', input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
  tools: { profile: 'full', toolSearch: false },
  plugins: { allow: ['openclaw-home-assistant-events', 'ha-events-test-channel'], load: { paths: [root, join(root, 'scripts/fixtures/test-channel')] }, entries: { 'ha-events-test-channel': { enabled: true }, 'openclaw-home-assistant-events': { enabled: !activationProbe, config: {
    url: `http://127.0.0.1:${port}`, accessToken: { source: activationProbe ? 'store' : 'env', provider: 'default', id: 'HA_EVENTS_TEST_TOKEN' }, allowedAgents: ['main'], allowInsecureHttp: true,
  } } } },
}));
const startGateway = () => spawn(process.execPath, [join(root,'node_modules/openclaw/openclaw.mjs'), 'gateway', 'run', '--port', String(gatewayPort)], {
  env: { ...process.env, OPENCLAW_STATE_DIR: temporary, OPENCLAW_CONFIG_PATH: join(temporary,'openclaw.json'), OPENCLAW_NO_AUTO_UPDATE: '1', HA_EVENTS_TEST_TOKEN: 'synthetic-ha-token', HA_EVENTS_TEST_RECEIPTS: join(temporary,'receipts.jsonl') }, stdio: ['ignore','pipe','pipe'],
});
let child; let log = '';
const start = () => { child = startGateway(); child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; }); };
const stop = async (signal = 'SIGTERM') => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
};
start();
const invoke = async (tool, args = {}) => {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/tools/invoke`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-gateway-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, args, sessionKey: 'agent:main:main' }) });
  const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body;
};
const waitFor = async (operation, timeout = 45000) => {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Gateway exited: ${log.slice(-10000)}`);
    try { const result = await operation(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${last ?? 'Timed out'}\n${log.slice(-10000)}\nTool results: ${JSON.stringify(captures.flatMap(input=>input.messages.filter(message=>message.role==='tool')))}`);
};
try {
  const cli = async (args, input = '') => {
    const command = spawn(process.execPath, [join(root,'node_modules/openclaw/openclaw.mjs'), ...args], {
      env: { ...process.env, OPENCLAW_STATE_DIR: temporary, OPENCLAW_CONFIG_PATH: join(temporary,'openclaw.json') }, stdio: ['pipe','pipe','pipe'],
    });
    command.stdin.end(input);
    let output = ''; command.stdout.on('data', data => { output += data; }); command.stderr.on('data', data => { output += data; });
    await once(command,'exit'); assert.equal(command.exitCode, 0, output); return output;
  };
  if (activationProbe) {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${gatewayPort}/healthz`)).ok);
    await cli(['secrets','store','set','HA_EVENTS_TEST_TOKEN','--kind','secret','--value-file','-'], 'synthetic-ha-token');
    await cli(['plugins','enable','openclaw-home-assistant-events','--accept-capabilities']);
  }
  await waitFor(async () => { const result = await invoke('ha_events_status'); return result.result.details?.synchronized; });
  if (activationProbe) {
    console.log('PASS: protected store credential resolves during live activation and HA listener synchronizes.');
  } else {
    await cli(['agent','--agent','main','--message','CONTEXT_CHURCH_782: remind me about ProPresenter when I arrive at church. Use the synthetic ha-test channel for this test.','--json']);
    await invoke('ha_events_subscribe', { entityId: 'sensor.mock', trigger: { type: 'state', to: 'on' }, instruction: 'Remind me about ProPresenter.' });
    const emit = state => {
      const at = new Date().toISOString(); const before = currentState; currentState = state;
      haSocket.send(JSON.stringify({ id: 1, type: 'event', event: { event_type: 'state_changed', time_fired: at, data: { entity_id: 'sensor.mock', old_state: entityState(before, new Date(Date.now()-10000).toISOString()), new_state: entityState(state, at) } } }));
    };
    emit('on');
    await waitFor(async () => { const result = await invoke('ha_events_status'); return result.result.details.deliveries.some(delivery => delivery.status === 'delivered'); });
    assert(captures.some(input => JSON.stringify(input.messages).includes('CONTEXT_CHURCH_782') && JSON.stringify(input.messages).includes('home_assistant_event')));
    const receipts = () => readFile(join(temporary,'receipts.jsonl'),'utf8');
    await waitFor(async()=>{try{return (await receipts()).trim().split('\n').length === 1;}catch{return false;}});
    const history = await cli(['gateway','call','chat.history','--params',JSON.stringify({ sessionKey:'agent:main:main' }),'--json']);
    assert(history.includes('home_assistant_event')); assert(history.includes('CONTEXT_CHURCH_782'));
    console.log('PASS: matched event persisted in the original conversation; public chat.history exposes it; normal message tool sent once to the synthetic channel.');
    await invoke('ha_events_subscribe', { entityId:'sensor.mock', trigger:{type:'state',to:'off'}, instruction:'Second synthetic reminder.' });
    const priorCalls = captures.length; stall = true; emit('off');
    await waitFor(async () => { const result=await invoke('ha_events_status'); return captures.length > priorCalls && result.result.details.deliveries.some(delivery=>delivery.status==='running'); });
    const interrupted = (await invoke('ha_events_status')).result.details.deliveries.find(delivery=>delivery.status==='running');
    await stop('SIGKILL'); stall = false; start();
    await waitFor(async () => { const result=await invoke('ha_events_status'); return result.result.details.synchronized && result.result.details.deliveries.some(delivery=>delivery.status==='uncertain'); });
    const recovered = (await invoke('ha_events_status')).result.details.deliveries;
    assert.equal(recovered.filter(delivery=>delivery.status==='delivered').length,1);
    const uncertain = recovered.find(delivery=>delivery.status==='uncertain'); assert(uncertain);
    await new Promise(resolve=>setTimeout(resolve,1500));
    const sent = (await receipts()).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(sent.filter(receipt=>receipt.text.includes(recovered.find(delivery=>delivery.status==='delivered').id)).length,1);
    assert(sent.filter(receipt=>receipt.text.includes(uncertain.id)).length<=1, 'Host continuation must not be confused with a second plugin dispatch');
    assert.equal(uncertain.runId,interrupted.runId); assert.equal(uncertain.attempts,1);
    const rejected = await invoke('ha_events_resolve',{deliveryId:uncertain.id,resolution:'retry'}).catch(error=>error);
    assert(rejected instanceof Error || rejected.result?.isError, 'Unacknowledged retry must be rejected');
    await invoke('ha_events_resolve',{deliveryId:uncertain.id,resolution:'dismissed'});
    assert((await invoke('ha_events_status')).result.details.deliveries.some(delivery=>delivery.id===uncertain.id && delivery.status==='dismissed'));
    console.log('PASS: actual process crash recovered running as uncertain, retained delivered history, did not replay either event, and required explicit manual review.');
    if (process.env.HA_EVENTS_UI_PROBE === '1') {
      await writeFile('/private/tmp/ha-events-ui-probe.json', JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${gatewayPort}/#token=synthetic-gateway-token` }));
      console.log('UI probe ready: disposable Gateway held until SIGUSR1.');
      await once(process,'SIGUSR1');
    }

  }
} finally {
  await stop();
  for (const socket of ws.clients) socket.terminate();
  await new Promise(resolve => ws.close(resolve)); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
