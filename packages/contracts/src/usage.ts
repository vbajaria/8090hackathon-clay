import { z } from 'zod';
import { AmountSchema, CapabilitySchema, CountSchema, IdSchema, ProviderKeySchema, RevisionSchema, TimestampSchema } from './common.js';

export const MoneySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unknown') }).strict(),
  z.object({ kind: z.literal('known'), amount: AmountSchema, currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
]);
export const UnitsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unknown') }).strict(),
  z.object({ kind: z.literal('known'), amount: AmountSchema, unitKind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }).strict(),
]);
const ObservationKeySchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9:_-]+$/);
const AttributionFields = {
  attributionKey: IdSchema, attemptId: IdSchema.nullable(), runId: IdSchema.nullable(),
  providerKey: ProviderKeySchema, capability: CapabilitySchema,
};
// Strict, lead-free public DTOs; observation history is NOT an aggregate total.
export const UsageObservationSchema = z.object({
  ...AttributionFields, id: IdSchema, observedAt: TimestampSchema,
  sourceObservationKey: ObservationKeySchema, sourceRevision: RevisionSchema.nullable(),
  semantics: z.enum(['cumulative', 'delta', 'estimate', 'unknown']),
  units: UnitsSchema, reportedMoney: MoneySchema, estimatedMoney: MoneySchema,
}).strict().superRefine((o, ctx) => {
  if ((o.semantics === 'estimate' || o.semantics === 'unknown') && (o.reportedMoney.kind !== 'unknown' || o.units.kind !== 'unknown')) {
    ctx.addIssue({ code: 'custom', message: 'Unconfirmed observations cannot assert confirmed consumption' });
  }
});
export const AttemptConsumptionSchema = z.object({
  ...AttributionFields, revision: RevisionSchema, units: UnitsSchema,
  reportedMoney: MoneySchema, estimatedMoney: MoneySchema,
  latestAuthoritativeObservationKey: ObservationKeySchema.nullable(), sourceRevision: RevisionSchema.nullable(),
}).strict().superRefine((o, ctx) => {
  if ((o.reportedMoney.kind === 'known' || o.units.kind === 'known') && o.latestAuthoritativeObservationKey === null) {
    ctx.addIssue({ code: 'custom', message: 'Confirmed totals require an authoritative observation' });
  }
});
export const UsageQuerySchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), runId: IdSchema.optional() }).strict();
export const UsageSummarySchema = z.object({
  periodStart: TimestampSchema, periodEnd: TimestampSchema, externalStarts: CountSchema,
  totals: z.array(z.object({ providerKey: ProviderKeySchema, units: UnitsSchema, reportedMoney: MoneySchema, estimatedMoney: MoneySchema, unknownAttempts: CountSchema }).strict()),
}).strict().refine(v => Date.parse(v.periodEnd) > Date.parse(v.periodStart), 'Invalid usage period');
export type UsageObservation = z.infer<typeof UsageObservationSchema>;
export type AttemptConsumption = z.infer<typeof AttemptConsumptionSchema>;
