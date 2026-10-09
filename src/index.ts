import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { readFileSync } from 'node:fs';
import { definePluginEntry, buildJsonPluginConfigSchema } from 'openclaw/plugin-sdk/plugin-entry';
import { z } from 'zod';
import { sourceSessionSchema, type SourceSession } from './model.js';
import { configSchema } from './config.js';
import { createDispatcher } from './dispatch.js';
import { Engine } from './engine.js';
import { Outbox } from './outbox.js';
import { Repository } from './repository.js';
import { FileStore } from './file-store.js';
import { ServiceScheduler } from './scheduler.js';
import { HaConnection } from './transport.js';

const emptyParameters = { type: 'object', properties: {}, additionalProperties: false };
const subscriptionParameters = {
  type: 'object', additionalProperties: false, required: ['entityId', 'trigger', 'instruction'], properties: {
    entityId: { type: 'string', description: 'Exact HA entity ID, discovered through official HA MCP' },
    instruction: { type: 'string', maxLength: 2000, description: 'Authorized task for the owning agent when matched' },
    oneShot: { type: 'boolean', default: true },
    trigger: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['type', 'to'], properties: { type: { const: 'state' }, to: { type: 'string' }, from: { type: 'string' } } },
      { type: 'object', additionalProperties: false, required: ['type'], properties: { type: { const: 'numeric' }, above: { type: 'number' }, below: { type: 'number' } } },
      { type: 'object', additionalProperties: false, required: ['type', 'state', 'durationMs'], properties: { type: { const: 'state_for' }, state: { type: 'string' }, durationMs: { type: 'integer', minimum: 1000 } } },
    ] },
  },
};
function register(api: OpenClawPluginApi): void {
  let engine: Engine | undefined;
  let connection: HaConnection | undefined;
  let scheduler: ServiceScheduler | undefined;
  let fileStore: FileStore | undefined;
  const requireEngine = (): Engine => {
    if (!engine) throw new Error('Home Assistant Events service is not running; configure and enable the plugin');
    return engine;
  };
  const tools = [
    { name: 'ha_events_subscribe', description: 'Persist a smart-home event watcher. Wake only this agent when a state, numeric crossing, or sustained state matches. Supplements official HA MCP.', parameters: subscriptionParameters,
      run: (owner: string, input: unknown, guard: () => void, source?: SourceSession) => requireEngine().subscribe(owner, input, guard, source) },
    { name: 'ha_events_list', description: 'List this agent\'s persistent Home Assistant event subscriptions.', parameters: emptyParameters,
      run: (owner: string) => requireEngine().list(owner) },
    { name: 'ha_events_remove', description: 'Remove this agent\'s watcher and cancel its unsubmitted events. Work already submitted to the host may complete.',
      parameters: { type: 'object', additionalProperties: false, required: ['subscriptionId'], properties: { subscriptionId: { type: 'string' } } },
      run: (owner: string, input: unknown, guard: () => void) => requireEngine().remove(owner, z.object({ subscriptionId: z.string().uuid() }).strict().parse(input).subscriptionId, guard) },
    { name: 'ha_events_status', description: 'Check listener health and this agent\'s pending, running, delivered, uncertain, and failed events; inspect uncertain events before manual resolution.', parameters: emptyParameters,
      run: async (owner: string) => ({ connection: connection?.status ?? 'stopped', ...(await requireEngine().status(owner) as Record<string, unknown>) }) },
    { name: 'ha_events_resolve', description: 'After explicit user review, resolve an uncertain or failed event. Mark delivered only after verifying the conversation; dismiss to stop; retry only with explicit duplicate-risk acknowledgement. Never automatically retry uncertain events.',
      parameters: { type: 'object', additionalProperties: false, required: ['deliveryId', 'resolution'], properties: {
        deliveryId: { type: 'string' }, resolution: { enum: ['delivered', 'dismissed', 'retry'] }, acknowledgeDuplicateRisk: { type: 'boolean', default: false },
      } },
      run: (owner: string, input: unknown, guard: () => void) => {
        const args = z.object({ deliveryId: z.string(), resolution: z.enum(['delivered', 'dismissed', 'retry']), acknowledgeDuplicateRisk: z.boolean().default(false) }).strict().parse(input);
        return requireEngine().resolveDelivery(owner, args.deliveryId, args.resolution, args.acknowledgeDuplicateRisk, guard);
      } },
  ];
  for (const tool of tools) api.registerTool(context => {
    if (!context.agentId) return null;
    const configured = api.pluginConfig?.allowedAgents;
    if (!(engine?.isAllowed(context.agentId) ?? (Array.isArray(configured) && configured.includes(context.agentId)))) return null;
    const owner = context.agentId;
    return { name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
      async execute(_callId: string, input: unknown) {
        const guard = (): void => { context.assertInvocationCurrent?.(); context.assertInputCommitAllowed?.(); };
        guard();
        let source: SourceSession | undefined;
        if (tool.name === 'ha_events_subscribe') {
          if (!context.sessionKey?.startsWith(`agent:${owner}:`) || context.sessionKey.includes(':subagent:')) throw new Error('Create subscriptions in a normal owning-agent conversation');
          const entry = api.runtime.agent.session.getSessionEntry({ agentId: owner, sessionKey: context.sessionKey });
          if (!entry || (context.sessionId && entry.sessionId !== context.sessionId)) throw new Error('Originating conversation is unavailable or changed');
          source = sourceSessionSchema.parse({ sessionKey: context.sessionKey, sessionId: entry.sessionId,
            senderIsOwner: context.senderIsOwner ?? false,
            ...(context.messageChannel ? { channel: context.messageChannel } : {}),
            ...(context.agentAccountId ? { accountId: context.agentAccountId } : {}),
            ...(context.requesterSenderId ? { senderId: context.requesterSenderId } : {}),
            ...(context.nativeChannelId ? { nativeChannelId: context.nativeChannelId } : {}),
            ...(context.deliveryContext?.to ? { target: context.deliveryContext.to } : {}),
            ...(context.deliveryContext?.threadId !== undefined ? { threadId: context.deliveryContext.threadId } : {}),
          });
        }
        const result = await tool.run(owner, input, guard, source);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
      },
    };
  }, { names: [tool.name] });
  api.registerService({ id: 'home-assistant-events',
    reload: { configPrefixes: ['plugins.entries.openclaw-home-assistant-events.config'] },
    async start(context) {
      // Host materializes declared SecretRefs before handing runtime config to the plugin.
      const config = configSchema.parse(context.config.plugins?.entries?.['openclaw-home-assistant-events']?.config ?? api.pluginConfig);
      scheduler = new ServiceScheduler();
      const configuredAgents = new Set(Object.keys(context.config.agents?.entries ?? {}));
      // The implicit default agent is main when no explicit list is configured.
      if (!configuredAgents.size) configuredAgents.add('main');
      if (config.allowedAgents.some(id => !configuredAgents.has(id))) throw new Error('allowedAgents contains an unconfigured agent');
      fileStore = await FileStore.open(context.stateDir);
      const repository = new Repository(fileStore);
      engine = new Engine(repository, config.allowedAgents, scheduler.now);
      try { await engine.load(); } catch (error) { await fileStore.close(); fileStore = undefined; engine = undefined; throw error; }
      const outbox = new Outbox(repository, createDispatcher(api, scheduler.signal), config.allowedAgents, scheduler.now);
      try { await outbox.recover(); } catch (error) { await fileStore.close(); fileStore = undefined; engine = undefined; throw error; }
      const report = (message: string): void => { api.logger.error(message); context.serviceHealth?.reportFailure(new Error(message)); };
      connection = new HaConnection(config, engine, scheduler, report, undefined, () => context.serviceHealth?.clearFailure());
      const activeEngine = engine;
      scheduler.schedule({ id: 'ha-duration', delayMs: 1000, everyMs: 1000, run: async () => {
        try { await activeEngine.tick(); } catch { report('HA duration processing failed'); }
      } });
      scheduler.schedule({ id: 'ha-outbox', delayMs: 1000, everyMs: 1000, run: async () => {
        try { await outbox.drain(); } catch { report('HA delivery processing failed'); }
      } });
      connection.start();
    },
    async stop() { scheduler?.beginClose(); await connection?.stop(); await scheduler?.stop(); await engine?.repository.settled(); await fileStore?.close(); fileStore = undefined; engine = undefined; connection = undefined; },
  });
}
const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8')) as { configSchema: Record<string, unknown> };
export default definePluginEntry({ configSchema: buildJsonPluginConfigSchema(manifest.configSchema), id: 'openclaw-home-assistant-events', name: 'Home Assistant Events',
  description: 'Persistent, deterministic smart-home event watchers that wake only their owning agent', register });
