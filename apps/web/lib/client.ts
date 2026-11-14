import type { CellValue, Column, TableView, RowScope, RunPreview } from '@leadwork/contracts';
import { CellValueSchema, ColumnDefinitionSchema, LIMITS } from '@leadwork/contracts';
import { parseEditableValue, validateColumnConfiguration } from '@leadwork/engine';
export type { Column, TableView, RowScope, RunPreview };
export type Cell = { value: CellValue; version: string; stale: boolean; outcome: string | null };
export type Row = { id: string; insertionSequence: string; cells: Record<string, Cell> };
export type TableMeta = { id: string; name: string; revision: string; createdAt: string; updatedAt?: string; rowCount: number; columnCount: number };
export type TableData = { table: TableMeta; columns: Column[]; rows: Row[]; view: TableView; nextCursor: string | null };
export type Session = { user: { id: string; email: string } | null; mode: 'supabase' | 'development' | 'unconfigured' };
export type Connection = { id: string; revision: string; providerKey: string; status: string; capabilities: string[]; validatedAt: string | null };
export type CatalogEntry = { providerKey: string; name: string; capability: string; nameModes: string[]; authorizationCheck: string; enabledForRealRequests: boolean; gateReason?: string };
export type Connections = { connections: Connection[]; catalog: CatalogEntry[] };
export class RequestError extends Error {
  code: string; status: number; body: Record<string, unknown>;
  constructor(message: string, code: string, status: number, body: Record<string, unknown> = {}) {
    super(message); this.code = code; this.status = status; this.body = body;
  }
}
export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal }); }
  catch (e) { if ((e as Error).name === 'AbortError') throw e; throw new RequestError('Connection interrupted. Reload saved state before retrying a mutation; its outcome may be uncertain.', 'network', 0); }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new RequestError(data.error?.message ?? `Request failed (${response.status}). Please retry.`, data.error?.code ?? 'request_failed', response.status, data);
  }
  if (response.headers.get('content-type')?.includes('text/csv')) return await response.blob() as T;
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const message = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.';
export const text = (cell?: Cell) => cell?.value.value == null ? '' : String(cell.value.value);
export function valueType(column: Column): CellValue['type'] {
  return column.definition.kind === 'editable' ? column.definition.valueType : column.definition.kind === 'formula' ? column.definition.returnType : 'text';
}
export function typedValue(type: CellValue['type'], input: string): CellValue {
  return CellValueSchema.parse(parseEditableValue(type, input));
}
export function scope(kind: string, selected: string[], view: TableView): RowScope {
  if (kind === 'selected') { if (!selected.length) throw new Error('Select rows or explicitly choose filtered/all rows.'); return { kind, rowIds: selected }; }
  if (kind === 'filtered') return { kind, viewRevision: view.revision, filters: view.filters };
  if (kind === 'all') return { kind };
  throw new Error('Explicitly choose a row scope.');
}
export function validateColumn(name: string, definition: unknown, columns: Column[], existing?: Column) {
  if (!name.trim()) throw new Error('Enter a column name.');
  if (columns.some(c => c.id !== existing?.id && c.name.trim().toLowerCase() === name.trim().toLowerCase())) throw new Error('Column names must be unique.');
  if (!existing && columns.length >= LIMITS.columns) throw new Error('A table supports at most 50 columns.');
  const parsed = ColumnDefinitionSchema.parse(definition);
  const candidate = { id: existing?.id ?? crypto.randomUUID(), revision: existing?.revision ?? '0', name: name.trim(), definition: parsed };
  validateColumnConfiguration([...columns.filter(c => c.id !== existing?.id), candidate]);
  return parsed;
}
export const freshConsent = () => ({ overwritePopulated: false, refreshStale: false, unknownPrice: false, possibleDuplicateCharge: false });
export function canConfirm(preview: RunPreview, consent: ReturnType<typeof freshConsent>, now = Date.now()) {
  return Date.parse(preview.expiresAt) > now && !preview.blockers.length && (Object.keys(consent) as (keyof typeof consent)[]).every(k => !preview.requiredConsent[k] || consent[k]);
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
