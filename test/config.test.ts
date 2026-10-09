import { expect, it } from 'vitest';
import { configSchema, parseRuntimeConfig, websocketUrl } from '../src/config.js';
it('uses prepared credentials for authored references and fails closed without them', () => {
  const input = { url: 'https://example.test', allowedAgents: ['main'], accessToken: { source: 'env', provider: 'default', id: 'HA_TOKEN' } };
  expect(parseRuntimeConfig(input, 'prepared-token').accessToken).toBe('prepared-token');
  expect(() => parseRuntimeConfig(input)).toThrow('unavailable');
  expect(parseRuntimeConfig({ ...input, accessToken: 'literal-token' }).accessToken).toBe('literal-token');
});
it('requires secure transport, rejects credential URLs, and preserves reverse-proxy base paths', () => {
  const base = { accessToken: 'mock', allowedAgents: ['main'] };
  expect(configSchema.parse({ ...base, url: 'https://example.test' }).allowInsecureHttp).toBe(false);
  expect(() => configSchema.parse({ ...base, url: 'http://example.test' })).toThrow();
  expect(() => configSchema.parse({ ...base, url: 'https://user:password@example.test' })).toThrow();
  expect(() => configSchema.parse({ ...base, url: 'https://example.test?token=secret' })).toThrow();
  expect(websocketUrl('https://example.test/ha/')).toBe('wss://example.test/ha/api/websocket');
  expect(configSchema.parse({ ...base, url: 'http://localhost', allowInsecureHttp: true }).url).toBe('http://localhost');
});
