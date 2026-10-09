/** HA timestamps include microseconds; Date.parse alone collapses distinct transitions. */
export function compareTimestamps(left: string, right: string): number {
  const milliseconds = Date.parse(left) - Date.parse(right);
  if (milliseconds !== 0) return milliseconds;
  const fraction = (value: string): string => (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? '').padEnd(9, '0');
  const a = fraction(left); const b = fraction(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
