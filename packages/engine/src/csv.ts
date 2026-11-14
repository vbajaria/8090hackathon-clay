import { LIMITS, type CellValue } from '@leadwork/contracts';
import { DomainError } from './errors.js';
import { checkedValue, valueText } from './values.js';
export interface CsvData { headers: string[]; rows: string[][] }
export interface CsvHeaderIssue { sourceIndex: number; code: 'blank_header' | 'duplicate_header' }
/** Preserve the source headers, including invalid ones, for the caller's correction UI. */
export function csvHeaderIssues(headers: string[]): CsvHeaderIssue[] {
  const names = headers.map(h => h.trim().toLocaleLowerCase('en-US'));
  return names.flatMap<CsvHeaderIssue>((name, sourceIndex) => !name
    ? [{ sourceIndex, code: 'blank_header' as const }]
    : names.indexOf(name) !== names.lastIndexOf(name)
      ? [{ sourceIndex, code: 'duplicate_header' as const }] : []);
}
export function parseCsv(text: string): CsvData {
  if (typeof text !== 'string') throw new DomainError('malformed_csv');
  if (new TextEncoder().encode(text).byteLength > LIMITS.csvBytes) throw new DomainError('csv_too_large');
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  if (text === '') return { headers: [], rows: [] };
  const records: string[][] = [];
  let row: string[] = [], field = '', state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  let endedRecord = false;
  const fail = (): never => { throw new DomainError('malformed_csv', [{ code: 'malformed_csv', ...(records.length > 0 ? { rowIndex: records.length - 1 } : {}), sourceIndex: row.length }]); };
  const endField = () => { row.push(field); field = ''; state = 'start'; };
  const endRecord = () => { endField(); records.push(row); row = []; endedRecord = true; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    endedRecord = false;
    if (state === 'quoted') {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else state = 'closed';
      } else field += c;
    } else if (c === ',') endField();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
    } else if (state === 'closed') fail();
    else if (c === '"') {
      if (state !== 'start') fail();
      state = 'quoted';
    } else { field += c; state = 'plain'; }
  }
  if (state === 'quoted') fail();
  if (!endedRecord) endRecord();
  const headers = records.shift()!;
  records.forEach((record, rowIndex) => {
    if (record.length !== headers.length) throw new DomainError('malformed_csv', [{ code: 'malformed_csv', rowIndex }]);
  });
  return { headers, rows: records };
}
function neutralize(text: string): string {
  // Spreadsheet engines may ignore leading Unicode whitespace and ASCII controls.
  return /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text) ? `'${text}` : text;
}
function quote(text: string): string {
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
export function exportCsv(headers: string[], typedRows: CellValue[][]): string {
  if (headers.some(h => typeof h !== 'string')) throw new DomainError('invalid_value');
  const records = [headers.map(h => quote(neutralize(h))).join(',')];
  typedRows.forEach((row, rowIndex) => {
    if (row.length !== headers.length) throw new DomainError('invalid_value', [{ code: 'invalid_value', rowIndex }]);
    records.push(row.map(raw => {
      const value = checkedValue(raw), text = valueText(value);
      return quote(value.type === 'text' ? neutralize(text) : text);
    }).join(','));
  });
  return records.join('\r\n') + '\r\n';
}
