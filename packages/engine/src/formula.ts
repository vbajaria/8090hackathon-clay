import { Decimal } from 'decimal.js';
import { IdSchema, type CellValue } from '@leadwork/contracts';
import { DomainError } from './errors.js';
import { checkedValue, parseEditableValue, valueText } from './values.js';

export const FORMULA_LIMITS = Object.freeze({ expressionCharacters: 16_000, nodes: 512, depth: 64, textCharacters: 100_000, numericDigits: 10_000, divisionPrecision: 100 });
export const FORMULA_FUNCTIONS = Object.freeze({
  CONCAT: 'One or more nonmissing typed values; returns text.',
  LOWER: 'One nonmissing text value; returns lowercase text.',
  UPPER: 'One nonmissing text value; returns uppercase text.',
  IF: 'Boolean condition, true branch, false branch; evaluates only the chosen branch.',
});
type Node = { depth: number } & (
  { kind: 'literal'; value: CellValue } |
  { kind: 'reference'; id: string } |
  { kind: 'unary'; op: string; operand: Node } |
  { kind: 'binary'; op: string; left: Node; right: Node } |
  { kind: 'call'; name: keyof typeof FORMULA_FUNCTIONS; args: Node[] }
);
type Token = { kind: 'number' | 'string' | 'reference' | 'identifier' | 'symbol' | 'end'; value: string };
const fail = (): never => { throw new DomainError('invalid_formula'); };
function tokenize(expression: string): Token[] {
  if (typeof expression !== 'string' || !expression.trim()) fail();
  if (expression.length > FORMULA_LIMITS.expressionCharacters) throw new DomainError('formula_limit');
  const tokens: Token[] = [];
  for (let i = 0; i < expression.length;) {
    const c = expression[i]!;
    if (/\s/u.test(c)) { i++; continue; }
    if (expression.startsWith('{{', i)) {
      const end = expression.indexOf('}}', i + 2);
      if (end < 0) fail();
      const id = expression.slice(i + 2, end);
      if (!IdSchema.safeParse(id).success) throw new DomainError('invalid_reference');
      tokens.push({ kind: 'reference', value: id }); i = end + 2;
    } else if (c === '"' || c === "'") {
      const quote = c; let value = '', closed = false; i++;
      while (i < expression.length) {
        const ch = expression[i++]!;
        if (ch === quote) { closed = true; break; }
        if (ch === '\\') {
          const escape = expression[i++]!;
          const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'" };
          if (!Object.hasOwn(escapes, escape)) fail();
          value += escapes[escape];
        } else value += ch;
      }
      if (!closed) fail();
      tokens.push({ kind: 'string', value });
    } else if (/\d/u.test(c)) {
      const value = /^\d+(?:\.\d+)?/u.exec(expression.slice(i))![0];
      tokens.push({ kind: 'number', value }); i += value.length;
    } else if (/[A-Za-z_]/u.test(c)) {
      const value = /^[A-Za-z_][A-Za-z_0-9]*/u.exec(expression.slice(i))![0];
      tokens.push({ kind: 'identifier', value }); i += value.length;
    } else {
      const pair = expression.slice(i, i + 2);
      const value = ['<=', '>=', '!=', '==', '<>'].includes(pair) ? pair : c;
      if (!['+', '-', '*', '/', '=', '==', '!=', '<>', '<', '<=', '>', '>=', '(', ')', ','].includes(value)) fail();
      tokens.push({ kind: 'symbol', value }); i += value.length;
    }
    if (tokens.length > FORMULA_LIMITS.nodes * 4) throw new DomainError('formula_limit');
  }
  tokens.push({ kind: 'end', value: '' }); return tokens;
}
function parse(expression: string): Node {
  const tokens = tokenize(expression); let cursor = 0, count = 0;
  const peek = () => tokens[cursor]!;
  const take = () => tokens[cursor++]!;
  const expect = (value: string) => { if (take().value !== value) fail(); };
  const node = (n: Node): Node => {
    if (++count > FORMULA_LIMITS.nodes || n.depth > FORMULA_LIMITS.depth) throw new DomainError('formula_limit');
    return n;
  };
  const precedence: Record<string, number> = { '=': 1, '==': 1, '!=': 1, '<>': 1, '<': 1, '<=': 1, '>': 1, '>=': 1, '+': 2, '-': 2, '*': 3, '/': 3 };
  function primary(level: number): Node {
    if (level > FORMULA_LIMITS.depth) throw new DomainError('formula_limit');
    const token = take();
    if (token.kind === 'number') return node({ kind: 'literal', value: parseEditableValue('number', token.value), depth: 1 });
    if (token.kind === 'string') return node({ kind: 'literal', value: { type: 'text', value: token.value }, depth: 1 });
    if (token.kind === 'reference') return node({ kind: 'reference', id: token.value, depth: 1 });
    if (token.value === '+' || token.value === '-') {
      const operand = primary(level + 1); return node({ kind: 'unary', op: token.value, operand, depth: operand.depth + 1 });
    }
    if (token.value === '(') { const result = expressionNode(1, level + 1); expect(')'); return result; }
    if (token.kind === 'identifier') {
      if (token.value === 'true' || token.value === 'false') return node({ kind: 'literal', value: { type: 'boolean', value: token.value === 'true' }, depth: 1 });
      if (token.value === 'null') return node({ kind: 'literal', value: { type: 'text', value: null }, depth: 1 });
      if (!Object.hasOwn(FORMULA_FUNCTIONS, token.value)) fail();
      const name = token.value as keyof typeof FORMULA_FUNCTIONS; expect('(');
      const args: Node[] = [];
      if (peek().value !== ')') {
        args.push(expressionNode(1, level + 1));
        while (peek().value === ',') { take(); args.push(expressionNode(1, level + 1)); }
      }
      expect(')');
      if ((name === 'CONCAT' && args.length < 1) || (name === 'IF' && args.length !== 3) || (['LOWER', 'UPPER'].includes(name) && args.length !== 1)) fail();
      return node({ kind: 'call', name, args, depth: 1 + Math.max(...args.map(a => a.depth)) });
    }
    return fail();
  }
  function expressionNode(min: number, level: number): Node {
    let left = primary(level);
    while (peek().kind === 'symbol' && (precedence[peek().value] ?? 0) >= min) {
      const op = take().value, right = expressionNode(precedence[op]! + 1, level + 1);
      left = node({ kind: 'binary', op, left, right, depth: 1 + Math.max(left.depth, right.depth) });
    }
    return left;
  }
  const result = expressionNode(1, 1);
  if (peek().kind !== 'end') fail();
  return result;
}
export function formulaReferences(expression: string): string[] {
  const ids = new Set<string>();
  const visit = (node: Node) => {
    if (node.kind === 'reference') ids.add(node.id);
    else if (node.kind === 'unary') visit(node.operand);
    else if (node.kind === 'binary') { visit(node.left); visit(node.right); }
    else if (node.kind === 'call') node.args.forEach(visit);
  };
  visit(parse(expression)); return [...ids];
}
function bounded(value: CellValue): CellValue {
  if (value.type === 'text' && value.value !== null && value.value.length > FORMULA_LIMITS.textCharacters) throw new DomainError('formula_limit');
  if (value.type === 'number' && value.value !== null && value.value.length > FORMULA_LIMITS.numericDigits) throw new DomainError('formula_limit');
  return value;
}
function present(value: CellValue): CellValue {
  if (value.value === null) throw new DomainError('missing_value');
  return value;
}
function numeric(value: CellValue): string {
  present(value);
  if (value.type !== 'number') throw new DomainError('invalid_operand');
  return value.value!;
}
export function evaluateFormula(expression: string, valuesByColumnId: Record<string, CellValue>): CellValue {
  const ast = parse(expression);
  // Addition/subtraction/multiplication stay exact up to the numeric output bound.
  const Exact = Decimal.clone({ precision: FORMULA_LIMITS.numericDigits * 2 + 4, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -100_000, toExpPos: 100_000 });
  const Division = Decimal.clone({ precision: FORMULA_LIMITS.divisionPrecision, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -100_000, toExpPos: 100_000 });
  const numberResult = (result: Decimal): CellValue => {
    if (!result.isFinite()) throw new DomainError('invalid_operand');
    return bounded({ type: 'number', value: result.toFixed() });
  };
  function evaluate(node: Node): CellValue {
    if (node.kind === 'literal') return bounded(node.value);
    if (node.kind === 'reference') {
      if (!Object.hasOwn(valuesByColumnId, node.id)) throw new DomainError('missing_value', [{ code: 'missing_value', columnId: node.id }]);
      const value = bounded(checkedValue(valuesByColumnId[node.id]!));
      if (value.value === null) throw new DomainError('missing_value', [{ code: 'missing_value', columnId: node.id }]);
      return value;
    }
    if (node.kind === 'unary') {
      const value = new Exact(numeric(evaluate(node.operand)));
      return numberResult(node.op === '-' ? value.negated() : value);
    }
    if (node.kind === 'call') {
      if (node.name === 'IF') {
        const condition = present(evaluate(node.args[0]!));
        if (condition.type !== 'boolean') throw new DomainError('invalid_operand');
        return evaluate(node.args[condition.value ? 1 : 2]!);
      }
      const args = node.args.map(arg => present(evaluate(arg)));
      if (node.name === 'CONCAT') return bounded({ type: 'text', value: args.map(valueText).join('') });
      const value = args[0]!;
      if (value.type !== 'text') throw new DomainError('invalid_operand');
      return bounded({ type: 'text', value: node.name === 'LOWER' ? value.value!.toLowerCase() : value.value!.toUpperCase() });
    }
    const left = present(evaluate(node.left)), right = present(evaluate(node.right));
    if (['+', '-', '*', '/'].includes(node.op)) {
      const a = new Exact(numeric(left)), b = new Exact(numeric(right));
      if (node.op === '/' && b.isZero()) throw new DomainError('division_by_zero');
      return numberResult(node.op === '+' ? a.plus(b) : node.op === '-' ? a.minus(b) : node.op === '*' ? a.times(b) : new Division(a.toFixed()).div(b.toFixed()));
    }
    if (left.type !== right.type) throw new DomainError('invalid_operand');
    const comparison = left.type === 'number' ? new Exact(left.value!).cmp(numeric(right))
      : left.value! < right.value! ? -1 : left.value! > right.value! ? 1 : 0;
    const result = node.op === '=' || node.op === '==' ? comparison === 0 : node.op === '!=' || node.op === '<>' ? comparison !== 0
      : node.op === '<' ? comparison < 0 : node.op === '<=' ? comparison <= 0 : node.op === '>' ? comparison > 0 : comparison >= 0;
    return { type: 'boolean', value: result };
  }
  return evaluate(ast);
}
