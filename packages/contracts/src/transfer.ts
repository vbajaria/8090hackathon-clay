import { z } from 'zod';
import { apiError, CellTypeSchema, CountSchema, FingerprintSchema, IdempotencyKeySchema, IdSchema, LIMITS, NonblankSchema, RevisionSchema, TimestampSchema, uniqueIds } from './common.js';
import { RowScopeSchema } from './table.js';

export const ImportMappingSchema = z.object({
  sourceIndex: CountSchema,
  destination: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('existing'), columnId: IdSchema, valueType: CellTypeSchema }).strict(),
    z.object({ kind: z.literal('new'), name: NonblankSchema, valueType: CellTypeSchema }).strict(),
  ]),
}).strict();
const MappingsSchema = z.array(ImportMappingSchema).min(1).max(LIMITS.columns).superRefine((mappings, ctx) => {
  const sources = mappings.map(m => m.sourceIndex);
  const destinations = mappings.map(m => m.destination.kind === 'existing' ? m.destination.columnId : `new:${m.destination.name.trim().toLowerCase()}`);
  if (new Set(sources).size !== sources.length || new Set(destinations).size !== destinations.length) ctx.addIssue({ code: 'custom', message: 'Duplicate source or destination mapping' });
});
export const ImportPreviewRequestSchema = z.object({ tableId: IdSchema, uploadId: IdSchema, expectedTableRevision: RevisionSchema, mappings: MappingsSchema }).strict();
export const ImportIssueSchema = z.object({ rowIndex: CountSchema.nullable(), sourceIndex: CountSchema.nullable(), code: z.enum(['invalid_number', 'invalid_date', 'invalid_boolean', 'invalid_mapping', 'capacity_exceeded', 'malformed_csv', 'blank_header', 'duplicate_header']) }).strict();
export const ImportPlanSchema = z.object({
  id: IdSchema, revision: RevisionSchema, tableId: IdSchema, expectedTableRevision: RevisionSchema,
  sourceFingerprint: FingerprintSchema, expiresAt: TimestampSchema, sourceBytes: CountSchema.max(LIMITS.csvBytes),
  headers: z.array(z.string()).min(1), mappings: MappingsSchema,
  existingRows: CountSchema.max(LIMITS.rows), appendedRows: CountSchema.max(LIMITS.rows),
  existingColumns: CountSchema.max(LIMITS.columns), createdColumns: CountSchema.max(LIMITS.columns),
  state: z.enum(['needs_correction', 'ready']), issues: z.array(ImportIssueSchema),
  previewRows: z.array(z.array(z.string())).max(10),
}).strict().superRefine((plan, ctx) => {
  if (plan.existingRows + plan.appendedRows > LIMITS.rows || plan.existingColumns + plan.createdColumns > LIMITS.columns) ctx.addIssue({ code: 'custom', message: 'Import exceeds capacity' });
  if (plan.state === 'ready' && (plan.headers.some(h => !h.trim()) || new Set(plan.headers.map(h => h.trim().toLowerCase())).size !== plan.headers.length)) ctx.addIssue({ code: 'custom', message: 'Duplicate headers' });
  if (plan.mappings.some(m => m.sourceIndex >= plan.headers.length)) ctx.addIssue({ code: 'custom', message: 'Mapping references missing header' });
  if (plan.mappings.filter(m => m.destination.kind === 'new').length !== plan.createdColumns) ctx.addIssue({ code: 'custom', message: 'New column count does not match mappings' });
  if ((plan.state === 'ready') !== (plan.issues.length === 0)) ctx.addIssue({ code: 'custom', message: 'Import readiness must reflect all validation issues' });
  if (plan.previewRows.some(row => row.length !== plan.headers.length) || plan.previewRows.length > plan.appendedRows) ctx.addIssue({ code: 'custom', message: 'Invalid preview rows' });
});
export const ImportCorrectionRequestSchema = z.object({
  planId: IdSchema, expectedPlanRevision: RevisionSchema,
  corrections: z.array(z.object({ rowIndex: CountSchema, sourceIndex: CountSchema, replacementText: z.string() }).strict()).min(1),
}).strict();
export const ImportConfirmRequestSchema = z.object({ planId: IdSchema, expectedPlanRevision: RevisionSchema, idempotencyKey: IdempotencyKeySchema }).strict();
export function checkImportConfirmation(plan: z.infer<typeof ImportPlanSchema>, request: z.infer<typeof ImportConfirmRequestSchema>, now: Date) {
  if (!Number.isFinite(now.getTime())) return apiError('invalid_value');
  if (plan.id !== request.planId || plan.revision !== request.expectedPlanRevision) return apiError('version_conflict');
  if (Date.parse(plan.expiresAt) <= now.getTime()) return apiError('expired_plan', { expiresAt: plan.expiresAt });
  if (plan.state !== 'ready') return apiError('invalid_mapping');
  return null;
}
export const ImportCommitSchema = z.object({ planId: IdSchema, tableId: IdSchema, tableRevision: RevisionSchema, appendedRows: CountSchema.max(LIMITS.rows), createdColumnIds: uniqueIds() }).strict();
export const ExportRequestSchema = z.object({
  tableId: IdSchema, rowScope: RowScopeSchema, columnIds: uniqueIds().refine(ids => ids.length > 0, 'Choose an export column'),
  expectedViewRevision: RevisionSchema, acknowledgeStoredOutputWarnings: z.boolean(), neutralizeSpreadsheetText: z.literal(true),
}).strict();
export const ExportWarningSchema = z.enum(['pending', 'failed', 'stale', 'unknown']);
export type ImportPlan = z.infer<typeof ImportPlanSchema>;
export type ExportRequest = z.infer<typeof ExportRequestSchema>;
