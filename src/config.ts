import { z } from 'zod';
import { agentIdSchema } from './model.js';
export const configSchema = z.object({
  url: z.string().url(),
  accessToken: z.string().min(1),
  allowedAgents: z.array(agentIdSchema).min(1).max(100),
  allowInsecureHttp: z.boolean().default(false),
}).strict().superRefine((config, context) => {
  const url = new URL(config.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Use an HTTP(S) HA base URL without credentials, query, or fragment' });
  if (url.protocol === 'http:' && !config.allowInsecureHttp)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Use HTTPS or explicitly allow insecure HTTP for a trusted local network' });
});
export type Config = z.infer<typeof configSchema>;
export function websocketUrl(base: string): string {
  const url = new URL(base.endsWith('/') ? base : `${base}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/websocket`;
  return url.toString();
}
