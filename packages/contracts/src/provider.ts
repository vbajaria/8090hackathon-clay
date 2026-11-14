import { z } from 'zod';
import { CapabilitySchema, ConnectionRefSchema, CountSchema, IdSchema, NonblankSchema, ProviderKeySchema, RevisionSchema, TextInputMappingSchema, TimestampSchema } from './common.js';

export const DomainSchema = z.string().max(253).refine(s => {
  const labels = s.split('.');
  return labels.length >= 2 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}, 'Expected a bare DNS domain, not a URL');
export const PersonNameSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('full_name'), fullName: NonblankSchema }).strict(),
  z.object({ mode: z.literal('mapped_parts'), givenName: NonblankSchema, familyName: NonblankSchema, source: z.enum(['owner_mapped', 'owner_confirmed']) }).strict(),
]);
export const EmailNameMappingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('full_name'), fullNameInput: TextInputMappingSchema }).strict(),
  z.object({ mode: z.literal('mapped_parts'), givenNameInput: TextInputMappingSchema, familyNameInput: TextInputMappingSchema, source: z.enum(['owner_mapped', 'owner_confirmed']) }).strict(),
]);
export const ProviderRequestSchema = z.discriminatedUnion('capability', [
  z.object({ capability: z.literal('company'), domain: DomainSchema, output: z.enum(['name', 'website']) }).strict(),
  z.object({ capability: z.literal('email'), domain: DomainSchema, personName: PersonNameSchema }).strict(),
  z.object({ capability: z.literal('ai'), model: NonblankSchema, resolvedInstructions: NonblankSchema, maxOutputTokens: z.number().int().positive(), tools: z.array(z.never()).length(0), store: z.literal(false) }).strict(),
]);
export const ProviderConnectionSchema = z.object({
  id: IdSchema, revision: RevisionSchema, providerKey: ProviderKeySchema,
  status: z.enum(['unvalidated', 'validating', 'ready', 'invalid', 'disconnected']),
  capabilities: z.array(CapabilitySchema).min(1), validatedAt: TimestampSchema.nullable(), validationEvidenceId: IdSchema.nullable(),
}).strict().superRefine((c, ctx) => {
  if (c.status === 'ready' && (!c.validatedAt || !c.validationEvidenceId)) ctx.addIssue({ code: 'custom', message: 'Ready connections require authorization evidence' });
});
export const ProviderCapabilitiesSchema = z.object({
  providerKey: ProviderKeySchema, capability: CapabilitySchema,
  credentialShape: z.enum(['api_key', 'client_credentials']),
  execution: z.enum(['synchronous', 'asynchronous', 'unverified']),
  nameModes: z.array(z.enum(['full_name', 'mapped_parts'])),
  evidence: z.enum(['unverified', 'documented', 'live_verified']),
  authorizationCheck: z.enum(['nonbillable_documented', 'requires_approval', 'unknown']),
  policy: z.object({ deadlineMs: z.number().int().positive().nullable(), maxConcurrent: z.number().int().positive().nullable(), requestsPerMinute: z.number().int().positive().nullable(), maxPolls: CountSchema.nullable(), pollingCost: z.enum(['not_applicable', 'known', 'unknown']) }).strict(),
  enabledForRealRequests: z.boolean(),
}).strict().superRefine((c, ctx) => {
  if (c.enabledForRealRequests && (c.evidence !== 'live_verified' || c.execution === 'unverified' || c.policy.deadlineMs === null || c.policy.maxConcurrent === null || c.policy.requestsPerMinute === null || (c.execution === 'asynchronous' && (c.policy.maxPolls === null || c.policy.pollingCost === 'unknown')) || (c.capability === 'email' && !c.nameModes.length))) {
    ctx.addIssue({ code: 'custom', message: 'Real requests require verified capability, name compatibility and bounded policy' });
  }
});
export function supportsName(capability: z.infer<typeof ProviderCapabilitiesSchema>, name: z.infer<typeof PersonNameSchema>): boolean {
  return capability.capability === 'email' && capability.nameModes.includes(name.mode);
}
const WebsiteSchema = z.string().url().refine(s => { try { const u = new URL(s); return ['http:', 'https:'].includes(u.protocol) && !!u.hostname && !u.username && !u.password; } catch { return false; } }, 'Expected an HTTP(S) website without credentials');
export const UsableEmailSchema = z.string().regex(/^[^\s@]+@[^\s@]+$/u, 'Expected one @, nonempty local/domain parts and no whitespace');
export const ProviderOutputSchema = z.discriminatedUnion('capability', [
  z.object({ capability: z.literal('company'), output: z.literal('name'), value: NonblankSchema }).strict(),
  z.object({ capability: z.literal('email'), value: UsableEmailSchema }).strict(),
  z.object({ capability: z.literal('ai'), value: NonblankSchema }).strict(),
]);
// Company website is separate because discriminated unions require unique tags.
export const SelectedProviderOutputSchema = z.union([
  ProviderOutputSchema,
  z.object({ capability: z.literal('company'), output: z.literal('website'), value: WebsiteSchema }).strict(),
]);
export const TaskHandleSchema = z.object({ providerKey: ProviderKeySchema, taskId: NonblankSchema }).strict();
export const NormalizedProviderResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('succeeded'), providerKey: ProviderKeySchema, retrievedAt: TimestampSchema, requestId: NonblankSchema.nullable(), output: SelectedProviderOutputSchema, verification: z.object({ providerLabel: NonblankSchema, source: ProviderKeySchema }).strict().nullable() }).strict(),
  z.object({ status: z.literal('no_result'), providerKey: ProviderKeySchema, capability: z.enum(['company', 'email']), retrievedAt: TimestampSchema, requestId: NonblankSchema.nullable() }).strict(),
  z.object({ status: z.literal('failed'), providerKey: ProviderKeySchema, reason: z.enum(['invalid_authorization', 'rate_limited', 'provider_error', 'invalid_output', 'refused', 'input_too_large']) }).strict(),
  z.object({ status: z.literal('unknown'), providerKey: ProviderKeySchema, reason: z.enum(['timeout', 'lost_acknowledgement', 'polling_stopped']) }).strict(),
  z.object({ status: z.literal('pending'), task: TaskHandleSchema }).strict(),
]);
export const ProviderAttemptSchema = z.object({
  id: IdSchema, executionStepId: IdSchema, connection: ConnectionRefSchema,
  waterfallPosition: CountSchema, dispatchState: z.enum(['prepared', 'dispatch_intent', 'awaiting_result', 'resolved', 'unknown']),
  requestId: NonblankSchema.nullable(), task: TaskHandleSchema.nullable(), dispatchedAt: TimestampSchema.nullable(), deadlineAt: TimestampSchema,
}).strict().superRefine((attempt, ctx) => {
  if (attempt.dispatchState === 'awaiting_result' && !attempt.task) ctx.addIssue({ code: 'custom', message: 'Async retrieval requires the existing task handle' });
});
export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;
export type NormalizedProviderResult = z.infer<typeof NormalizedProviderResultSchema>;
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const mayAdvanceWaterfall = (result: NormalizedProviderResult): boolean => result.status === 'no_result';
