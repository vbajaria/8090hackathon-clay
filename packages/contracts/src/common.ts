import { z } from 'zod';

export const CONTRACT_VERSION = '1' as const;
export const LIMITS = Object.freeze({ rows: 5_000, columns: 50, csvBytes: 10_000_000, aiTemplateCharacters: 2_000, pageSize: 250 });
export const IdSchema = z.string().uuid();
// JSON-safe Postgres bigint and decimal representations; never coerce or round.
export const RevisionSchema = z.string().regex(/^(0|[1-9]\d*)$/);
export const DecimalSchema = z.string().regex(/^[+-]?\d+(?:\.\d+)?$/);
export const AmountSchema = z.string().regex(/^\d+(?:\.\d+)?$/);
export const TimestampSchema = z.string().datetime({ offset: true });
export const CountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const NonblankSchema = z.string().refine(s => s.trim().length > 0, 'Must not be blank');
export const IdempotencyKeySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/);
export const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ProviderKeySchema = z.enum(['pdl', 'hunter', 'snov', 'openai', 'tomba']);
export const CapabilitySchema = z.enum(['company', 'email', 'ai']);
export const CellTypeSchema = z.enum(['text', 'number', 'date', 'boolean']);
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return value.slice(0, 4) !== '0000' && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Invalid calendar date');
export const CellValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string().nullable() }).strict(),
  z.object({ type: z.literal('number'), value: DecimalSchema.nullable() }).strict(),
  z.object({ type: z.literal('date'), value: DateSchema.nullable() }).strict(),
  z.object({ type: z.literal('boolean'), value: z.boolean().nullable() }).strict(),
]);
export type CellValue = z.infer<typeof CellValueSchema>;
export const uniqueIds = (max = LIMITS.columns) => z.array(IdSchema).max(max).refine(ids => new Set(ids).size === ids.length, 'Duplicate IDs');
export const ConnectionRefSchema = z.object({ id: IdSchema, revision: RevisionSchema }).strict();

export const ERROR_DEFINITIONS = {
  unauthenticated: [401, 'Sign in to continue.'],
  not_found: [404, 'The resource is unavailable.'],
  version_conflict: [409, 'Saved data changed. Refresh and review again.'],
  idempotency_conflict: [409, 'This confirmation key was used for different content.'],
  expired_plan: [409, 'This preview expired. Create a new preview.'],
  active_work: [409, 'Active work must finish or time out before this change.'],
  invalid_value: [422, 'One or more values are invalid.'],
  invalid_mapping: [422, 'Correct the column mappings before confirming.'],
  capacity_exceeded: [422, 'The operation exceeds the table capacity.'],
  consent_required: [422, 'Review and acknowledge the required consent.'],
  provider_not_ready: [422, 'A required provider connection or policy is not ready.'],
  internal_error: [500, 'The operation could not be completed.'],
} as const;
export type ErrorCode = keyof typeof ERROR_DEFINITIONS;
const ErrorCodeSchema = z.enum(Object.keys(ERROR_DEFINITIONS) as [ErrorCode, ...ErrorCode[]]);
export const ErrorContextSchema = z.object({
  tableId: IdSchema.optional(), rowId: IdSchema.optional(), columnId: IdSchema.optional(),
  expectedVersion: RevisionSchema.optional(), actualVersion: RevisionSchema.optional(), expiresAt: TimestampSchema.optional(),
}).strict();
export const ApiErrorSchema = z.object({ code: ErrorCodeSchema, status: z.number().int(), message: z.string(), context: ErrorContextSchema.optional() }).strict().superRefine((error, ctx) => {
  const [status, message] = ERROR_DEFINITIONS[error.code];
  if (error.status !== status || error.message !== message) ctx.addIssue({ code: 'custom', message: 'Use the safe error definition' });
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
export function apiError(code: ErrorCode, context?: z.infer<typeof ErrorContextSchema>): ApiError {
  const [status, message] = ERROR_DEFINITIONS[code];
  return ApiErrorSchema.parse({ code, status, message, ...(context ? { context } : {}) });
}
