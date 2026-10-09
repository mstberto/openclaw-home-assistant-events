import { z } from 'zod';

export const agentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const entityIdSchema = z.string().regex(/^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/).max(255);
export const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), to: z.string().min(1).max(255), from: z.string().max(255).optional() }).strict(),
  z.object({ type: z.literal('numeric'), above: z.number().finite().optional(), below: z.number().finite().optional() }).strict(),
  z.object({ type: z.literal('state_for'), state: z.string().min(1).max(255), durationMs: z.number().int().min(1000).max(30 * 86400000) }).strict(),
]);
export const subscriptionInputSchema = z.object({
  entityId: entityIdSchema,
  trigger: triggerSchema,
  instruction: z.string().trim().min(1).max(2000),
  oneShot: z.boolean().default(true),
}).strict().superRefine((value, ctx) => {
  if (value.trigger.type !== 'numeric') return;
  const { above, below } = value.trigger;
  if (above === undefined && below === undefined)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A numeric trigger needs above or below' });
  if (above !== undefined && below !== undefined && above >= below)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'above must be less than below' });
});
export type SubscriptionInput = z.infer<typeof subscriptionInputSchema>;
// Captured from trusted tool context, never from subscription arguments.
export const sourceSessionSchema = z.object({
  sessionKey: z.string().min(1).max(512), sessionId: z.string().uuid(),
  channel: z.string().max(128).optional(), accountId: z.string().max(128).optional(),
  senderId: z.string().max(512).optional(), senderIsOwner: z.boolean(),
  nativeChannelId: z.string().max(512).optional(), target: z.string().max(512).optional(),
  threadId: z.union([z.string().max(512), z.number()]).optional(),
}).strict();
export type SourceSession = z.infer<typeof sourceSessionSchema>;
export const subscriptionSchema = z.object({
  id: z.string().uuid(), agentId: agentIdSchema, input: subscriptionInputSchema,
  source: sourceSessionSchema.optional(),
  createdAt: z.number(), consumed: z.boolean().default(false),
  // Armed transitions survive restart but must be confirmed by a fresh HA snapshot.
  armed: z.object({ since: z.number(), transitionId: z.string() }).optional(),
  firedTransition: z.string().optional(),
}).strict();
export type Subscription = z.infer<typeof subscriptionSchema>;
export const entityStateSchema = z.object({
  entity_id: entityIdSchema, state: z.string().max(255),
  last_changed: z.string().max(64).datetime({ offset: true }), last_updated: z.string().max(64).datetime({ offset: true }),
});
export type EntityState = z.infer<typeof entityStateSchema>;
export const stateEventSchema = z.object({
  event_type: z.literal('state_changed'), time_fired: z.string().max(64).datetime({ offset: true }),
  data: z.object({ entity_id: entityIdSchema, old_state: entityStateSchema.nullable(), new_state: entityStateSchema.nullable() }),
});
export type StateEvent = z.infer<typeof stateEventSchema>;
export const deliverySchema = z.object({
  id: z.string(), subscriptionId: z.string(), agentId: agentIdSchema,
  entityId: entityIdSchema, instruction: z.string(), previousState: z.string().nullable(),
  currentState: z.string(), occurredAt: z.number(), oneShot: z.boolean(),
  attempts: z.number().int().nonnegative(), nextAttemptAt: z.number(),
  source: sourceSessionSchema.optional(),
  status: z.enum(['pending', 'accepted', 'running', 'delivered', 'uncertain', 'failed', 'dismissed']),
  runId: z.string().optional(), startedAt: z.number().optional(), deliveredAt: z.number().optional(),
  reason: z.string().max(512).optional(), reviews: z.number().int().nonnegative().optional(),
}).strict();
export type Delivery = z.infer<typeof deliverySchema>;
export const documentSchema = z.object({
  version: z.literal(1), subscriptions: z.array(subscriptionSchema).max(1000),
  deliveries: z.array(deliverySchema).max(5000), seen: z.array(z.string()).max(10000),
}).strict();
export type StateDocument = z.infer<typeof documentSchema>;
export const emptyDocument = (): StateDocument => ({ version: 1, subscriptions: [], deliveries: [], seen: [] });

/** Keep audit history bounded while retaining every unresolved handoff. */
export function pruneDeliveryHistory(document: StateDocument): void {
  const completed = document.deliveries.filter(d => d.status === 'delivered' || d.status === 'dismissed');
  const prune = new Set(completed.slice(0, Math.max(0, completed.length - 1000)).map(d => d.id));
  document.deliveries = document.deliveries.filter(d => !prune.has(d.id));
}
