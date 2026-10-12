import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { expect, it, vi } from 'vitest';
import { createDispatcher } from '../src/dispatch.js';
import type { Delivery } from '../src/model.js';
const source = { sessionKey: 'agent:main:telegram:direct:123', sessionId: '11111111-1111-4111-8111-111111111111', senderId: '123', senderIsOwner: false, channel: 'telegram', accountId: 'personal', target: '123', threadId: 9 };
const delivery: Delivery = { id: 'stable-id', subscriptionId: 'subscription', agentId: 'main', entityId: 'sensor.test', instruction: 'Report the event',
  previousState: 'off', currentState: 'on', occurredAt: 0, oneShot: true, attempts: 0, nextAttemptAt: 0, status: 'pending', source };
type Params = Parameters<OpenClawPluginApi['runtime']['agent']['runEmbeddedAgent']>[0];
function fixture(action: (params: Params) => void | Promise<void> = () => {}) {
  const run = vi.fn(async (params: Params) => { await action(params); return { meta: {} }; });
  const entry = { sessionId: source.sessionId };
  const api = { id: 'openclaw-home-assistant-events', config: {}, runtime: { agent: { runEmbeddedAgent: run,
    resolveAgentWorkspaceDir: () => '/tmp/synthetic', resolveAgentTimeoutMs: () => 10000,
    session: { getSessionEntry: vi.fn(() => entry) } } } } as unknown as OpenClawPluginApi;
  const controller = new AbortController();
  return { run, api, entry, controller, dispatcher: createDispatcher(api, controller.signal) };
}
const receipt = (params: Params) => params.onUserMessagePersisted?.({ role: 'user', content: params.prompt, timestamp: 0 });
it('continues the exact originating session with captured sender policy and no elevated grants', async () => {
  const { dispatcher, run } = fixture(receipt);
  expect(await dispatcher.prepare(delivery).execute('run')).toEqual({ persisted: true });
  const params = run.mock.calls[0]![0];
  expect(params.sessionKey).toBe(source.sessionKey); expect(params.sessionId).toBe(source.sessionId);
  expect(params.inputProvenance).toEqual({ kind: 'internal_system', sourceTool: 'openclaw-home-assistant-events', runId: 'run', sourceSessionKey: source.sessionKey });
  expect(params.senderId).toBe('123'); expect(params.senderIsOwner).toBe(false); expect(params.agentAccountId).toBe('personal');
  expect(params.messageTo).toBe('123'); expect(params.messageThreadId).toBe(9);
  expect(params).not.toHaveProperty('forceMessageTool'); expect(params).not.toHaveProperty('runtimePluginToolGrant');
  expect(params.prompt).toContain('"subscription":'); expect(params.prompt).toContain('"event":');
});
it('does not confuse model completion with transcript delivery', async () => {
  const { dispatcher } = fixture();
  expect(await dispatcher.prepare(delivery).execute('run')).toEqual({ persisted: false });
});
it('retains a safe failure category and SDK location without exception text or credentials', async () => {
  const { dispatcher } = fixture(() => {
    const error = new Error('Provider auth failed: Bearer synthetic-secret at https://secret.example');
    error.stack = `${error.message}\n    at run (/private/work/openclaw/dist/auth-runtime.mjs:123:4)`;
    throw error;
  });
  const result = await dispatcher.prepare(delivery).execute('run');
  expect(result.persisted).toBe(false);
  expect(result.failureReason).toBe('Runtime failure: model authentication at auth-runtime.mjs:123:4; manual review required');
  expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  expect(JSON.stringify(result)).not.toContain('secret.example');
  expect(JSON.stringify(result)).not.toContain('/private/work');
});
it('preserves the originating Codex session model and runtime, including its lock', async () => {
  const { dispatcher, api, run } = fixture(params => {
    // A locked native session rejects a request that omits or changes its runtime.
    expect(params.config).toBe(api.config);
    expect(params.agentHarnessId).toBe('codex');
    expect(params.modelSelectionLocked).toBe(true);
    expect(params.provider).toBe('openai');
    expect(params.model).toBe('gpt-6-sol');
    receipt(params);
  });
  vi.mocked(api.runtime.agent.session.getSessionEntry).mockReturnValue({
    sessionId: source.sessionId, updatedAt: 0, agentHarnessId: 'codex', modelSelectionLocked: true,
    modelProvider: 'openai', model: 'gpt-6-sol',
  });
  expect(await dispatcher.prepare(delivery).execute('run')).toEqual({ persisted: true });
  expect(run).toHaveBeenCalledOnce();
});
it('recognizes persistence even if the agent fails later, but honors invalidation', async () => {
  const success = fixture(params => { receipt(params); throw new Error('model failed'); });
  expect(await success.dispatcher.prepare(delivery).execute('run')).toEqual({ persisted: true });
  const invalidated = fixture(params => { receipt(params); params.onUserMessagePersistenceInvalidated?.(); });
  expect(await invalidated.dispatcher.prepare(delivery).execute('run')).toEqual({ persisted: false });
});
it('rejects legacy, cross-agent, reset, or cancelled sessions before invocation', async () => {
  const { dispatcher, entry, controller, run } = fixture();
  const legacy = { ...delivery }; delete legacy.source;
  expect(() => dispatcher.prepare(legacy)).toThrow('Legacy');
  expect(() => dispatcher.prepare({ ...delivery, agentId: 'other' })).toThrow('mismatch');
  const prepared = dispatcher.prepare(delivery);
  entry.sessionId = '22222222-2222-4222-8222-222222222222';
  await expect(prepared.execute('run')).rejects.toThrow('reset or deleted');
  controller.abort(); expect(() => dispatcher.prepare(delivery)).toThrow('stopping');
  expect(run).not.toHaveBeenCalled();
});
