import { appendFile } from 'node:fs/promises';
export default { id: 'ha-events-test-channel', register(api) {
  api.registerChannel({ plugin: {
    id: 'ha-test', meta: { id: 'ha-test', label: 'Synthetic', selectionLabel: 'Synthetic', docsPath: '/test', blurb: 'In-memory smoke test only' },
    capabilities: { chatTypes: ['direct'] },
    messaging: { normalizeTarget: value => value, targetResolver: { looksLikeId: value => /^\d+$/.test(value), hint: 'Synthetic numeric target' } },
    config: { listAccountIds: () => ['default'], resolveAccount: () => ({ enabled: true, configured: true }), isEnabled: () => true, isConfigured: () => true },
    outbound: { deliveryMode: 'direct', async sendText({ to, text }) {
      await appendFile(process.env.HA_EVENTS_TEST_RECEIPTS, JSON.stringify({ to, text }) + '\n');
      return { channel: 'ha-test', messageId: 'synthetic-receipt' };
    } },
  } });
} };
