import { expect, it } from 'vitest';
import { hideOwnedEventInput } from '../src/visibility.js';
const sessionKey = 'agent:main:main'; const pluginId = 'openclaw-home-assistant-events';
const message = { role: 'user', content: 'Complete event and stable event ID', timestamp: 1,
  provenance: { kind: 'internal_system', sourceTool: pluginId, sourceSessionKey: sessionKey, runId: 'reserved-run' } };
it('changes display only and leaves event content, receipt metadata, and original message intact', () => {
  const hidden = hideOwnedEventInput(message, sessionKey, pluginId);
  expect(hidden).toEqual({ ...message, display: false });
  expect(hidden?.content).toBe(message.content); expect(hidden?.provenance).toBe(message.provenance);
  expect(message).not.toHaveProperty('display');
});
it('does not hide user text, replies, tool results, other producers, or other sessions', () => {
  for (const value of [
    { role: 'user', content: JSON.stringify(message) },
    { ...message, role: 'assistant' }, { ...message, role: 'toolResult' },
    { ...message, provenance: { ...message.provenance, kind: 'external_user' } },
    { ...message, provenance: { ...message.provenance, sourceTool: 'other-plugin' } },
    { ...message, provenance: { ...message.provenance, sourceSessionKey: 'agent:other:main' } },
    { ...message, provenance: { ...message.provenance, runId: '' } },
    { ...message, provenance: null }, { ...message, provenance: 'untrusted' },
  ]) expect(hideOwnedEventInput(value, sessionKey, pluginId)).toBeUndefined();
  expect(hideOwnedEventInput(message, undefined, pluginId)).toBeUndefined();
  expect(hideOwnedEventInput(message, sessionKey, '')).toBeUndefined();
});
