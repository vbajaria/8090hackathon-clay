import { IdSchema, LIMITS, type CellValue } from '@leadwork/contracts';
import { DomainError } from './errors.js';
import { checkedValue, valueText } from './values.js';
interface Reference { id: string; start: number; end: number }
function references(template: string): Reference[] {
  if (typeof template !== 'string' || !template.trim() || Array.from(template).length > LIMITS.aiTemplateCharacters) throw new DomainError('invalid_template');
  const result: Reference[] = [];
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf('{{', cursor);
    const strayEnd = template.indexOf('}}', cursor);
    if (start < 0) {
      if (strayEnd >= 0) throw new DomainError('invalid_template');
      break;
    }
    if (strayEnd >= 0 && strayEnd < start) throw new DomainError('invalid_template');
    const end = template.indexOf('}}', start + 2);
    if (end < 0) throw new DomainError('invalid_template');
    const id = template.slice(start + 2, end);
    if (!IdSchema.safeParse(id).success) throw new DomainError('invalid_reference');
    result.push({ id, start, end: end + 2 }); cursor = end + 2;
  }
  return result;
}
export function instructionReferences(template: string): string[] {
  return [...new Set(references(template).map(ref => ref.id))];
}
export function resolveInstructions(template: string, valuesByColumnId: Record<string, CellValue>): { resolvedInstructions: string; missingColumnIds: string[] } {
  const refs = references(template), missing = new Set<string>();
  const parts: string[] = []; let cursor = 0;
  for (const ref of refs) {
    parts.push(template.slice(cursor, ref.start));
    const value = Object.hasOwn(valuesByColumnId, ref.id) ? checkedValue(valuesByColumnId[ref.id]!) : null;
    if (value === null || value.value === null) { missing.add(ref.id); parts.push(''); }
    else parts.push(valueText(value));
    cursor = ref.end;
  }
  parts.push(template.slice(cursor));
  return { resolvedInstructions: parts.join(''), missingColumnIds: [...missing] };
}
