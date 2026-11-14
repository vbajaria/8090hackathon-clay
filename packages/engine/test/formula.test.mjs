import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFormula as evaluate, DomainError, resolveInstructions, FORMULA_LIMITS } from '../dist/index.js';
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ref = n => `{{${id(n)}}}`;
const text = value => ({type:'text',value});
const number = value => ({type:'number',value});
const boolean = value => ({type:'boolean',value});
const code = expected => error => error instanceof DomainError && error.code === expected;
test('restricted formulas support text, Unicode normalization and stable UUID references', () => {
  assert.deepEqual(evaluate(`CONCAT(UPPER(${ref(1)}), " / ", LOWER('ZoË'), ${ref(2)}, false)`, {[id(1)]:text('acme'),[id(2)]:number('0')}), text('ACME / zoë0false'));
  assert.deepEqual(evaluate('CONCAT("line\\n", \'quote\\\'\')', {}), text("line\nquote'"));
});
test('arithmetic has precedence and exact signed decimals beyond JS safe integers', () => {
  assert.deepEqual(evaluate('0.1 + 0.2',{}), number('0.3'));
  assert.deepEqual(evaluate('9007199254740993 + 2',{}), number('9007199254740995'));
  assert.deepEqual(evaluate('-2 * (3 + 4) / +2',{}), number('-7'));
  assert.deepEqual(evaluate('1.200 * 2.05 - 0.001',{}), number('2.459'));
  assert.deepEqual(evaluate('1 / 8',{}), number('0.125'));
  assert.equal(evaluate('1 / 3',{}).value, '0.'+'3'.repeat(FORMULA_LIMITS.divisionPrecision));
});
test('comparisons are typed and IF is lazy and strictly boolean', () => {
  for (const [expression, expected] of [['1 < 2',true],['1 >= 2',false],['1.00 == 1',true],['2 <> 1',true],['"a" = "a"',true],['false != true',true]]) {
    assert.deepEqual(evaluate(expression,{}), boolean(expected));
  }
  assert.deepEqual(evaluate(`IF(true, "yes", ${ref(9)} / 0)`,{}), text('yes'));
  assert.deepEqual(evaluate('IF(false, 1/0, null)',{}), text(null));
  assert.throws(() => evaluate('IF(1, "yes", "no")',{}), code('invalid_operand'));
  assert.throws(() => evaluate('1 = "1"',{}), code('invalid_operand'));
});
test('missing values, invalid operands, and divide-by-zero give lead-free errors', () => {
  for (const values of [{}, {[id(1)]:text(null)}]) assert.throws(() => evaluate(ref(1),values), code('missing_value'));
  assert.throws(() => evaluate(`${ref(1)} + 2`,{[id(1)]:text('secretLeadValue')}), error => code('invalid_operand')(error) && !error.message.includes('secretLeadValue') && !JSON.stringify(error).includes('secretLeadValue'));
  assert.throws(() => evaluate('1 / -0',{}), code('division_by_zero'));
  assert.throws(() => evaluate('LOWER(2)',{}), code('invalid_operand'));
});
test('no executable identifiers, property access, array access, JS statements or malformed references', () => {
  for (const expression of ['process.exit()', 'constructor()', 'Function("return 1")', 'eval("1")', 'globalThis', 'Math.max(1,2)', '({}).constructor', '1;2', '[1]', 'LOWER()', 'IF(true,1)', 'CONCAT()', '1e3', '{{name}}', '"unterminated', '"bad\\q"', '1 +']) {
    assert.throws(() => evaluate(expression,{}), error => error instanceof DomainError);
  }
});
test('expression length, AST depth, recursive nesting and output are bounded', () => {
  assert.throws(() => evaluate('('.repeat(80)+'1'+')'.repeat(80),{}), code('formula_limit'));
  assert.throws(() => evaluate(Array(100).fill('1').join('+'),{}), code('formula_limit'));
  assert.throws(() => evaluate('1'.repeat(16_001),{}), code('formula_limit'));
  assert.throws(() => evaluate(ref(1),{[id(1)]:text('x'.repeat(100_001))}), code('formula_limit'));
  assert.throws(() => evaluate('9'.repeat(6_000)+'*'+'9'.repeat(6_000),{}), code('formula_limit'));
});
test('AI interpolation preserves false/zero, marks null missing, de-duplicates and never reparses values', () => {
  assert.deepEqual(resolveInstructions(`Flag ${ref(1)}; zero ${ref(2)}; empty ${ref(3)}; again ${ref(3)}; absent ${ref(4)}`, {
    [id(1)]:boolean(false),[id(2)]:number('0'),[id(3)]:text(null)
  }), {resolvedInstructions:'Flag false; zero 0; empty ; again ; absent ',missingColumnIds:[id(3),id(4)]});
  assert.deepEqual(resolveInstructions(ref(1),{[id(1)]:text(ref(2))}), {resolvedInstructions:ref(2),missingColumnIds:[]});
  assert.deepEqual(resolveInstructions(ref(1),{[id(1)]:text('')}), {resolvedInstructions:'',missingColumnIds:[]});
});
test('AI templates reject empty, over-limit, malformed and name-based references', () => {
  for (const template of ['', '  ', 'a'.repeat(2001), '{{name}}', '{{', '}}', '{{'+id(1)+'}} }}']) assert.throws(() => resolveInstructions(template,{}), error => error instanceof DomainError);
  assert.equal(resolveInstructions('😀'.repeat(2000),{}).missingColumnIds.length, 0);
});
test('formula references cannot read inherited values and UUID-looking quoted literals are plain text', () => {
  assert.throws(() => evaluate(ref(1),Object.create({[id(1)]:number('2')})),code('missing_value'));
  assert.deepEqual(evaluate('"'+ref(1)+'"',{}),text(ref(1)));
  assert.deepEqual(resolveInstructions(ref(1),Object.create({[id(1)]:text('secret')})),{resolvedInstructions:'',missingColumnIds:[id(1)]});
});
test('AST node count is bounded even for broad shallow trees', () => {
  assert.throws(() => evaluate('CONCAT('+Array(600).fill('"x"').join(',')+')',{}),code('formula_limit'));
});
