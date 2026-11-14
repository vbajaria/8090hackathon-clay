import { ColumnSchema, LIMITS, type Column, type CellValue } from '@leadwork/contracts';
import { DomainError } from './errors.js';
import { formulaReferences } from './formula.js';
import { instructionReferences } from './instructions.js';

type Mapping = { kind: 'column'; columnId: string } | { kind: 'fixed'; value: string };
function inputMappings(column: Column): Mapping[] {
  const d = column.definition;
  if (d.kind === 'company') return [d.domainInput];
  if (d.kind !== 'email') return [];
  return [d.domainInput, ...d.providers.flatMap<Mapping>(p => p.nameMapping.mode === 'full_name'
    ? [p.nameMapping.fullNameInput] : [p.nameMapping.givenNameInput, p.nameMapping.familyNameInput])];
}
function checkedColumn(column: Column): Column {
  const parsed = ColumnSchema.safeParse(column);
  if (!parsed.success) throw new DomainError('invalid_configuration');
  return parsed.data;
}
export function columnDependencies(column: Column): string[] {
  const parsed = checkedColumn(column), d = parsed.definition;
  if (d.kind === 'formula') return formulaReferences(d.expression);
  if (d.kind === 'ai') return instructionReferences(d.instructionTemplate);
  return [...new Set(inputMappings(parsed).flatMap(m => m.kind === 'column' ? [m.columnId] : []))];
}
const outputType = (column: Column): CellValue['type'] => {
  const d = column.definition;
  return d.kind === 'editable' ? d.valueType : d.kind === 'formula' ? d.returnType : 'text';
};
function sameIds(actual: string[], selected: string[]): boolean {
  return actual.length === selected.length && actual.every(id => selected.includes(id));
}
/** Syntax/capability validation only. Connection ownership and readiness belong to the caller. */
export function validateColumnConfiguration(columns: Column[]): void {
  if (!Array.isArray(columns) || columns.length > LIMITS.columns) throw new DomainError('invalid_configuration');
  const checked = columns.map(checkedColumn), byId = new Map<string, Column>(), names = new Set<string>();
  for (const column of checked) {
    const name = column.name.trim().toLocaleLowerCase('en-US');
    if (byId.has(column.id) || names.has(name)) throw new DomainError('duplicate_column', [{ code: 'duplicate_column', columnId: column.id }]);
    byId.set(column.id, column); names.add(name);
  }
  const graph = new Map<string, string[]>();
  for (const column of checked) {
    const d = column.definition, dependencies = columnDependencies(column);
    graph.set(column.id, dependencies);
    if ((d.kind === 'formula' || d.kind === 'ai') && !sameIds(dependencies, d.referencedColumnIds)) {
      throw new DomainError('reference_mismatch', [{ code: 'reference_mismatch', columnId: column.id }]);
    }
    for (const id of dependencies) {
      if (!byId.has(id)) throw new DomainError('invalid_reference', [{ code: 'invalid_reference', columnId: id }]);
    }
    for (const mapping of inputMappings(column)) {
      if (mapping.kind === 'column' && outputType(byId.get(mapping.columnId)!) !== 'text') {
        throw new DomainError('invalid_configuration', [{ code: 'invalid_configuration', columnId: mapping.columnId }]);
      }
    }
    if (d.kind === 'email') {
      for (const provider of d.providers) {
        // Documented compatibility, not execution certification. Never decompose a full name.
        if (provider.providerKey === 'tomba' || (provider.providerKey === 'snov' && provider.nameMapping.mode !== 'mapped_parts')) {
          throw new DomainError('incompatible_provider', [{ code: 'incompatible_provider', columnId: column.id }]);
        }
      }
    }
  }
  const done = new Set<string>(), active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) throw new DomainError('dependency_cycle', [{ code: 'dependency_cycle', columnId: id }]);
    if (done.has(id)) return;
    active.add(id); graph.get(id)!.forEach(visit); active.delete(id); done.add(id);
  };
  checked.forEach(column => visit(column.id));
}
export function topologicalColumns(columns: Column[], selectedIds: string[]): Column[] {
  validateColumnConfiguration(columns);
  const byId = new Map(columns.map(column => [column.id, column])), selected = new Set(selectedIds);
  for (const id of selected) {
    if (!byId.has(id)) throw new DomainError('invalid_reference');
  }
  const done = new Set<string>(), result: Column[] = [];
  const visit = (column: Column) => {
    if (done.has(column.id)) return;
    columnDependencies(column).forEach(id => visit(byId.get(id)!));
    done.add(column.id);
    if (column.definition.kind !== 'editable') result.push(column);
  };
  // Table order is the deterministic tie-breaker, independent of selectedIds order.
  columns.filter(column => selected.has(column.id)).forEach(visit);
  return result;
}
