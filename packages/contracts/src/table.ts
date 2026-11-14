import { z } from 'zod';
import { ApiErrorSchema, apiError, CellTypeSchema, CellValueSchema, ConnectionRefSchema, CountSchema, IdSchema, LIMITS, NonblankSchema, RevisionSchema, TimestampSchema, uniqueIds } from './common.js';
import { EmailNameMappingSchema } from './provider.js';

export const ColumnDefinitionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('editable'), valueType: CellTypeSchema }).strict(),
  z.object({ kind: z.literal('formula'), returnType: CellTypeSchema, expression: NonblankSchema, referencedColumnIds: uniqueIds() }).strict(),
  z.object({ kind: z.literal('company'), connection: ConnectionRefSchema, domainColumnId: IdSchema, output: z.enum(['name', 'website']) }).strict(),
  z.object({ kind: z.literal('email'), domainColumnId: IdSchema, providers: z.array(z.object({ providerKey: z.enum(['hunter', 'snov', 'tomba']), connection: ConnectionRefSchema, nameMapping: EmailNameMappingSchema }).strict()).min(2).max(10).refine(p => new Set(p.map(v => v.providerKey)).size === p.length, 'Waterfall requires distinct providers') }).strict(),
  z.object({ kind: z.literal('ai'), connection: ConnectionRefSchema, model: NonblankSchema, instructionTemplate: NonblankSchema.refine(s => Array.from(s).length <= LIMITS.aiTemplateCharacters, 'Template exceeds 2,000 characters'), referencedColumnIds: uniqueIds() }).strict(),
]);
export const ColumnSchema = z.object({ id: IdSchema, revision: RevisionSchema, name: NonblankSchema, definition: ColumnDefinitionSchema }).strict();
export const StepOutcomeSchema = z.enum(['queued', 'running', 'succeeded', 'reused', 'no_result', 'failed', 'skipped', 'canceled', 'unknown']);
export const CellSchema = z.object({ value: CellValueSchema, version: RevisionSchema, stale: z.boolean(), outcome: StepOutcomeSchema.nullable() }).strict();
export const RowSchema = z.object({ id: IdSchema, insertionSequence: RevisionSchema, cells: z.record(IdSchema, CellSchema) }).strict();
export const TableSchema = z.object({ id: IdSchema, name: NonblankSchema, revision: RevisionSchema, createdAt: TimestampSchema, rowCount: CountSchema.max(LIMITS.rows), columnCount: CountSchema.max(LIMITS.columns) }).strict();
export const CreateTableRequestSchema = z.object({ name: NonblankSchema }).strict();
export const CellPatchSchema = z.object({ rowId: IdSchema, columnId: IdSchema, expectedVersion: RevisionSchema, value: CellValueSchema }).strict();
export const CellConflictSchema = z.object({ error: ApiErrorSchema.refine(e => e.code === 'version_conflict'), current: CellSchema }).strict();
export function checkCellPatch(column: z.infer<typeof ColumnSchema>, patch: z.infer<typeof CellPatchSchema>) {
  if (column.id !== patch.columnId || column.definition.kind !== 'editable' || column.definition.valueType !== patch.value.type) return apiError('invalid_value', { columnId: patch.columnId });
  return null;
}
const EqualityFilter = (operator: 'equals' | 'not_equals') => z.object({ operator: z.literal(operator), columnId: IdSchema, value: CellValueSchema }).strict();
const OrderedValue = z.union([
  z.object({ type: z.literal('number'), value: CellValueSchema.options[1].shape.value.unwrap() }).strict(),
  z.object({ type: z.literal('date'), value: CellValueSchema.options[2].shape.value.unwrap() }).strict(),
]);
export const FilterSchema = z.discriminatedUnion('operator', [
  EqualityFilter('equals'), EqualityFilter('not_equals'),
  z.object({ operator: z.literal('contains'), columnId: IdSchema, value: z.string() }).strict(),
  z.object({ operator: z.literal('greater_than'), columnId: IdSchema, value: OrderedValue }).strict(),
  z.object({ operator: z.literal('less_than'), columnId: IdSchema, value: OrderedValue }).strict(),
  z.object({ operator: z.literal('is_blank'), columnId: IdSchema }).strict(),
  z.object({ operator: z.literal('is_not_blank'), columnId: IdSchema }).strict(),
]);
export const TableViewSchema = z.object({
  revision: RevisionSchema, filters: z.array(FilterSchema).max(LIMITS.columns),
  sort: z.array(z.object({ columnId: IdSchema, direction: z.enum(['asc', 'desc']) }).strict()).max(LIMITS.columns).refine(s => new Set(s.map(v => v.columnId)).size === s.length, 'Duplicate sort columns'),
  visibleColumnIds: uniqueIds(),
}).strict();
export const RowScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('selected'), rowIds: uniqueIds(LIMITS.rows).refine(ids => ids.length > 0, 'Select at least one row') }).strict(),
  z.object({ kind: z.literal('filtered'), viewRevision: RevisionSchema, filters: z.array(FilterSchema).max(LIMITS.columns) }).strict(),
]);
export const PageRequestSchema = z.object({ cursor: NonblankSchema.optional(), limit: z.number().int().min(1).max(LIMITS.pageSize).default(100) }).strict();
export const RowPageSchema = z.object({ items: z.array(RowSchema).max(LIMITS.pageSize), nextCursor: NonblankSchema.nullable(), tableRevision: RevisionSchema }).strict();
export type Column = z.infer<typeof ColumnSchema>;
export type CellPatch = z.infer<typeof CellPatchSchema>;
export type TableView = z.infer<typeof TableViewSchema>;
export type RowScope = z.infer<typeof RowScopeSchema>;
