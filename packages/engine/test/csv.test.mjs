import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, csvHeaderIssues, exportCsv, parseEditableValue, DomainError } from '../dist/index.js';
const cell = (type, value) => ({ type, value });
const code = expected => error => error instanceof DomainError && error.code === expected;
test('CSV handles BOM, Unicode, escaped quotes, multiline fields, all record endings, duplicates', () => {
  assert.deepEqual(parseCsv('\uFEFFName,Notes\r\nZoë,"line1\r\nline2, ""yes"""\rA,b\nA,b\n'), {
    headers: ['Name', 'Notes'], rows: [['Zoë', 'line1\r\nline2, "yes"'], ['A', 'b'], ['A', 'b']]
  });
  assert.deepEqual(parseCsv(''), { headers: [], rows: [] });
  assert.deepEqual(parseCsv('A,B\n,'), { headers: ['A', 'B'], rows: [['', '']] });
});
test('blank and duplicate headers stay correctable without discarding rows', () => {
  const parsed = parseCsv(',Name,name\n1,2,3');
  assert.deepEqual(parsed.headers, ['', 'Name', 'name']);
  assert.deepEqual(csvHeaderIssues(parsed.headers), [{sourceIndex:0,code:'blank_header'}, {sourceIndex:1,code:'duplicate_header'}, {sourceIndex:2,code:'duplicate_header'}]);
  assert.equal(parsed.rows.length, 1);
});
test('malformed quoting and ragged records produce safe errors', () => {
  for (const text of ['a\n"secret', 'a\nsecret"', 'a\n"secret"suffix', 'a,b\nsecret']) {
    assert.throws(() => parseCsv(text), error => code('malformed_csv')(error) && !JSON.stringify(error).includes('secret') && !error.message.includes('secret'));
  }
});
test('CSV byte limit counts Unicode UTF-8 bytes and includes BOM', () => {
  assert.throws(() => parseCsv('é'.repeat(5_000_001)), code('csv_too_large'));
  assert.equal(parseCsv('a'.repeat(10_000_000)).headers[0].length, 10_000_000);
});
test('typed editable parsing preserves exact decimals, null, dates and booleans', () => {
  for (const type of ['text','number','date','boolean']) assert.deepEqual(parseEditableValue(type,''), cell(type,null));
  for (const n of ['+001.2300', '-9007199254740993.00001', '0']) assert.deepEqual(parseEditableValue('number',n), cell('number',n));
  assert.deepEqual(parseEditableValue('boolean','false'), cell('boolean',false));
  assert.deepEqual(parseEditableValue('date','2024-02-29'), cell('date','2024-02-29'));
  for (const n of ['1e3', '.2', '2.', ' 2', '1,000', 'NaN']) assert.throws(() => parseEditableValue('number',n), code('invalid_number'));
  for (const d of ['2023-02-29','0000-01-01','2024-04-31','2024-1-01']) assert.throws(() => parseEditableValue('date',d), code('invalid_date'));
  for (const b of ['False','TRUE','0',' true']) assert.throws(() => parseEditableValue('boolean',b), code('invalid_boolean'));
});
test('CSV export RFC escaping and spreadsheet neutralization distinguish typed numbers', () => {
  const texts = ['=1+1', ' \t\u0000@SUM(1)', '\u00a0-2', '+cmd', '\rmalicious', 'hello,"Zoë"\nnext'];
  const csv = exportCsv(['=header', 'amount', 'flag'], texts.map(text => [cell('text',text), cell('number','-2.30'),cell('boolean',false)]));
  const parsed = parseCsv(csv);
  assert.equal(parsed.headers[0], "'=header");
  assert.equal(parsed.rows[0][0], "'=1+1");
  assert.equal(parsed.rows[1][0], "' \t\u0000@SUM(1)");
  assert.equal(parsed.rows[2][0], "'\u00a0-2");
  assert.equal(parsed.rows[4][0], "'\rmalicious");
  assert.equal(parsed.rows[5][0], texts[5]);
  assert.equal(parsed.rows[0][1], '-2.30');
  assert.equal(parsed.rows[0][2], 'false');
  assert.equal(exportCsv(['Name'], []), 'Name\r\n');
  assert.throws(() => exportCsv(['Name'], [[]]), code('invalid_value'));
});
