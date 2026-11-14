import { CellValueSchema, type CellValue } from '@leadwork/contracts';
import { DomainError } from './errors.js';
export type EditableType = CellValue['type'];
export function parseEditableValue(type: EditableType, text: string): CellValue {
  if (typeof text !== 'string') throw new DomainError('invalid_value');
  let value: string | boolean | null = text === '' ? null : text;
  if (type === 'boolean' && value !== null) {
    if (text !== 'true' && text !== 'false') throw new DomainError('invalid_boolean');
    value = text === 'true';
  }
  const parsed = CellValueSchema.safeParse({ type, value });
  if (!parsed.success) {
    if (type === 'number') throw new DomainError('invalid_number');
    if (type === 'date') throw new DomainError('invalid_date');
    throw new DomainError('invalid_value');
  }
  return parsed.data;
}
export function checkedValue(value: CellValue): CellValue {
  const parsed = CellValueSchema.safeParse(value);
  if (!parsed.success) throw new DomainError('invalid_value');
  return parsed.data;
}
export function valueText(value: CellValue): string {
  return value.value === null ? '' : String(value.value);
}
