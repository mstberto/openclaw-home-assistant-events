import { expect, it } from 'vitest';
import { configSchema, websocketUrl } from '../src/config.js';
it('requires secure transport, rejects credential URLs, and preserves reverse-proxy base paths', () => {
  const base = { accessToken: 'mock', allowedAgents: ['main'] };
  expect(configSchema.parse({ ...base, url: 'https://example.test' }).allowInsecureHttp).toBe(false);
  expect(() => configSchema.parse({ ...base, url: 'http://example.test' })).toThrow();
  expect(() => configSchema.parse({ ...base, url: 'https://user:password@example.test' })).toThrow();
  expect(() => configSchema.parse({ ...base, url: 'https://example.test?token=secret' })).toThrow();
  expect(websocketUrl('https://example.test/ha/')).toBe('wss://example.test/ha/api/websocket');
  expect(configSchema.parse({ ...base, url: 'http://localhost', allowInsecureHttp: true }).url).toBe('http://localhost');
});
