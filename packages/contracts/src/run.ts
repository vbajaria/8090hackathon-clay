import { z } from 'zod';
import { apiError, CapabilitySchema, CellValueSchema, ConnectionRefSchema, CountSchema, FingerprintSchema, IdempotencyKeySchema, IdSchema, LIMITS, NonblankSchema, ProviderKeySchema, RevisionSchema, TimestampSchema, uniqueIds } from './common.js';
import { ColumnSchema, RowScopeSchema, StepOutcomeSchema } from './table.js';

export const RunStatusSchema = z.enum(['queued', 'running', 'cancel_requested', 'completed', 'canceled']);
export const ConsentSchema = z.object({ overwritePopulated: z.boolean(), refreshStale: z.boolean(), unknownPrice: z.boolean(), possibleDuplicateCharge: z.boolean() }).strict();
export const RunPreviewRequestSchema = z.object({ tableId: IdSchema, expectedTableRevision: RevisionSchema, rowScope: RowScopeSchema, selectedColumnIds: uniqueIds().refine(ids => ids.length > 0, 'Choose an output'), parentRunId: IdSchema.optional() }).strict();
export const CostEstimateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unknown') }).strict(),
  z.object({ kind: z.literal('range'), currency: z.string().regex(/^[A-Z]{3}$/), minimum: z.number().finite().nonnegative(), maximum: z.number().finite().nonnegative() }).strict(),
]);
export const RunPreviewSchema = z.object({
  id: IdSchema, revision: RevisionSchema, tableId: IdSchema, expectedTableRevision: RevisionSchema,
  expiresAt: TimestampSchema, inputFingerprint: FingerprintSchema, parentRunId: IdSchema.nullable(),
  rowIds: uniqueIds(LIMITS.rows).refine(ids => ids.length > 0, 'Run requires rows'),
  selectedColumnIds: uniqueIds().refine(ids => ids.length > 0, 'Run requires outputs'), prerequisiteColumnIds: uniqueIds(),
  cells: z.object({ eligible: CountSchema, reused: CountSchema, skipped: CountSchema }).strict(),
  providers: z.array(z.object({ providerKey: ProviderKeySchema, capability: CapabilitySchema, connection: ConnectionRefSchema, eligibleRows: CountSchema.max(LIMITS.rows), lookupStarts: CountSchema, chargeablePolls: CountSchema.nullable(), cost: CostEstimateSchema }).strict()),
  maximumExternalRequests: CountSchema.nullable(), requiredConsent: ConsentSchema,
  blockers: z.array(z.enum(['provider_not_ready', 'unverified_provider_policy', 'invalid_configuration', 'active_work'])),
}).strict().superRefine((p, ctx) => {
  const columns = [...p.selectedColumnIds, ...p.prerequisiteColumnIds];
  if (new Set(columns).size !== columns.length || columns.length > LIMITS.columns) ctx.addIssue({ code: 'custom', message: 'Invalid dependency closure' });
  if (p.cells.eligible + p.cells.reused + p.cells.skipped !== p.rowIds.length * columns.length) ctx.addIssue({ code: 'custom', message: 'Cell counts must cover the complete row/column scope' });
  if (p.providers.some(v => v.eligibleRows > p.rowIds.length)) ctx.addIssue({ code: 'custom', message: 'Provider eligibility exceeds row scope' });
  if (p.providers.some(v => v.cost.kind === 'range' && v.cost.maximum < v.cost.minimum)) ctx.addIssue({ code: 'custom', message: 'Invalid price range' });
  if (p.providers.some(v => v.cost.kind === 'unknown') && !p.requiredConsent.unknownPrice) ctx.addIssue({ code: 'custom', message: 'Unknown prices require acknowledgement' });
  const unknownBound = p.providers.some(v => v.chargeablePolls === null);
  if (unknownBound) {
    if (p.maximumExternalRequests !== null || !p.blockers.includes('unverified_provider_policy')) ctx.addIssue({ code: 'custom', message: 'Unbounded polling must block confirmation' });
  } else {
    const bound = p.providers.reduce((n, v) => n + v.lookupStarts + (v.chargeablePolls ?? 0), 0);
    if (!Number.isSafeInteger(bound) || p.maximumExternalRequests !== bound) ctx.addIssue({ code: 'custom', message: 'External attempt bound must include polling' });
  }
});
export const RunConfirmRequestSchema = z.object({ previewId: IdSchema, expectedPreviewRevision: RevisionSchema, idempotencyKey: IdempotencyKeySchema, consent: ConsentSchema }).strict();
export function checkRunConfirmation(preview: z.infer<typeof RunPreviewSchema>, request: z.infer<typeof RunConfirmRequestSchema>, now: Date) {
  if (!Number.isFinite(now.getTime())) return apiError('invalid_value');
  if (preview.id !== request.previewId || preview.revision !== request.expectedPreviewRevision) return apiError('version_conflict');
  if (Date.parse(preview.expiresAt) <= now.getTime()) return apiError('expired_plan', { expiresAt: preview.expiresAt });
  if (preview.blockers.length) return apiError('provider_not_ready');
  const consentKeys = ['overwritePopulated', 'refreshStale', 'unknownPrice', 'possibleDuplicateCharge'] as const;
  if (consentKeys.some(key => preview.requiredConsent[key] && !request.consent[key])) return apiError('consent_required');
  return null;
}
export const OutcomeCountsSchema = z.object({ queued: CountSchema, running: CountSchema, succeeded: CountSchema, reused: CountSchema, no_result: CountSchema, failed: CountSchema, skipped: CountSchema, canceled: CountSchema, unknown: CountSchema }).strict();
export const RunProgressSchema = z.object({ id: IdSchema, tableId: IdSchema, parentRunId: IdSchema.nullable(), status: RunStatusSchema, total: CountSchema, terminal: CountSchema, counts: OutcomeCountsSchema }).strict().superRefine((run, ctx) => {
  const sum = Object.values(run.counts).reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(sum) || sum !== run.total || run.terminal !== sum - run.counts.queued - run.counts.running) ctx.addIssue({ code: 'custom', message: 'Inconsistent progress counters' });
  if (['completed', 'canceled'].includes(run.status) && run.terminal !== run.total) ctx.addIssue({ code: 'custom', message: 'Terminal runs cannot contain active work' });
});
export const RetryPreviewRequestSchema = z.object({
  parentRunId: IdSchema,
  targets: z.array(z.object({ rowId: IdSchema, columnId: IdSchema }).strict()).min(1).max(LIMITS.rows * LIMITS.columns).refine(t => new Set(t.map(v => `${v.rowId}:${v.columnId}`)).size === t.length, 'Duplicate retry cells'),
  includeOutcomes: z.array(z.enum(['failed', 'skipped', 'no_result', 'canceled', 'unknown'])).min(1).default(['failed']),
}).strict();
export const RunRowSnapshotSchema = z.object({
  rowId: IdSchema, baseInputs: z.record(IdSchema, CellValueSchema),
  reusedOutputs: z.record(IdSchema, z.object({ value: CellValueSchema, inputFingerprint: FingerprintSchema }).strict()),
  sourceVersions: z.record(IdSchema, RevisionSchema),
}).strict().refine(r => [...Object.keys(r.baseInputs), ...Object.keys(r.reusedOutputs)].every(id => Object.hasOwn(r.sourceVersions, id)), 'Snapshots require source versions');
export const RunPlanSchema = z.object({
  id: IdSchema, tableId: IdSchema, parentRunId: IdSchema.nullable(), status: RunStatusSchema,
  idempotencyKey: IdempotencyKeySchema, requestFingerprint: FingerprintSchema, confirmedAt: TimestampSchema, consent: ConsentSchema,
  configSnapshot: z.array(ColumnSchema).min(1).max(LIMITS.columns).refine(columns => new Set(columns.map(c => c.id)).size === columns.length, 'Duplicate snapshot columns'),
  rowSnapshots: z.array(RunRowSnapshotSchema).min(1).max(LIMITS.rows).refine(rows => new Set(rows.map(r => r.rowId)).size === rows.length, 'Duplicate snapshot rows'),
}).strict();
export type RunPlan = z.infer<typeof RunPlanSchema>;
export const ExecutionStepSchema = z.object({ id: IdSchema, runId: IdSchema, rowId: IdSchema, columnId: IdSchema, prerequisiteStepIds: uniqueIds(LIMITS.rows * LIMITS.columns), outcome: StepOutcomeSchema, stale: z.boolean(), inputFingerprint: FingerprintSchema }).strict();
export const RunResultSchema = z.object({
  stepId: IdSchema, runId: IdSchema, rowId: IdSchema, columnId: IdSchema, outcome: StepOutcomeSchema,
  storedValue: CellValueSchema.nullable(), stale: z.boolean(), explanation: z.enum(['fresh_output', 'fresh_reuse', 'no_match', 'missing_input', 'dependency_unavailable', 'provider_error', 'uncertain_outcome', 'canceled_before_dispatch']).nullable(),
  provenance: z.object({ providerKey: ProviderKeySchema, retrievedAt: TimestampSchema, verificationLabel: NonblankSchema.nullable(), attemptIds: uniqueIds(LIMITS.rows * LIMITS.columns) }).strict().nullable(),
}).strict();
export type RunPreview = z.infer<typeof RunPreviewSchema>;
export type RunProgress = z.infer<typeof RunProgressSchema>;
