/** Hide only this plugin's provenance-tagged event input, never its agent reply. */
export function hideOwnedEventInput<T extends { role: string }>(
  message: T, sessionKey: string | undefined, pluginId: string,
): T | undefined {
  if (message.role !== 'user' || !sessionKey || !pluginId) return undefined;
  const provenance: unknown = Reflect.get(message, 'provenance');
  if (!provenance || typeof provenance !== 'object') return undefined;
  const source = provenance as Record<string, unknown>;
  if (source.kind !== 'internal_system' || source.sourceTool !== pluginId
    || source.sourceSessionKey !== sessionKey || typeof source.runId !== 'string' || !source.runId) return undefined;
  // Keep content, identity, receipt metadata, and replay history intact.
  return { ...message, display: false };
}
