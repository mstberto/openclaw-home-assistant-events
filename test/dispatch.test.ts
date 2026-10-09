import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { expect, it, vi } from 'vitest';
import { createDispatcher } from '../src/dispatch.js';
import type { Delivery } from '../src/model.js';
const delivery: Delivery = { id: 'stable-id', subscriptionId: 'subscription', agentId: 'main', entityId: 'sensor.test', instruction: 'Report the event',
  previousState: 'off', currentState: 'on', occurredAt: 0, oneShot: true, attempts: 0, nextAttemptAt: 0, status: 'pending' };
it('uses only public isolated dispatch with stable dedup and no automatic destination', async () => {
  const run = vi.fn(async () => ({ runId: 'run' }));
  const waitForRun = vi.fn(async () => ({ status: 'timeout' }));
  const api = { runtime: { subagent: { run, waitForRun } } } as unknown as OpenClawPluginApi;
  const controller = new AbortController(); const dispatcher = createDispatcher(api, controller.signal);
  await dispatcher.submit(delivery);
  const params = (run.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
  expect(params.deliver).toBe(false); expect(params.sessionKey).toBe('agent:main:subagent:ha-events-stable-id');
  expect(params.idempotencyKey).toBe('ha-events:stable-id'); expect(params).not.toHaveProperty('completionDelivery');
  expect(params.message).toContain('"subscription":'); expect(params.message).toContain('"event":');
  expect(await dispatcher.observe('run')).toBe('pending');
  controller.abort(); await expect(dispatcher.submit(delivery)).rejects.toThrow(); expect(run).toHaveBeenCalledTimes(1);
});
