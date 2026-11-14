const messages = {
  csv_too_large: 'CSV exceeds the 10,000,000-byte limit.',
  malformed_csv: 'CSV syntax or record width is invalid.',
  invalid_text: 'The text value is invalid.',
  invalid_number: 'Use a signed or unsigned base-ten integer or decimal.',
  invalid_date: 'Use a valid calendar date in YYYY-MM-DD form.',
  invalid_boolean: 'Use lowercase true or false.',
  invalid_value: 'The typed value is invalid.',
  invalid_configuration: 'The column configuration is invalid.',
  duplicate_column: 'Column IDs and names must be unique.',
  invalid_reference: 'A column reference is missing or invalid.',
  reference_mismatch: 'Expression references must match the selected column IDs.',
  dependency_cycle: 'Column dependencies contain a cycle.',
  incompatible_provider: 'The provider does not support this explicit name mapping.',
  invalid_template: 'Use nonblank instructions with at most 2,000 characters and valid UUID references.',
  invalid_formula: 'The formula syntax or function arguments are invalid.',
  formula_limit: 'The formula exceeds the supported complexity or output limit.',
  missing_value: 'A referenced input value is missing.',
  invalid_operand: 'The formula operands have incompatible types.',
  division_by_zero: 'Division by zero is not supported.',
} as const;
export type DomainErrorCode = keyof typeof messages;
/** Lead-free diagnostics only. Do not include source text or schema error objects. */
export interface DomainIssue {
  code: DomainErrorCode;
  columnId?: string;
  rowIndex?: number;
  sourceIndex?: number;
}
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly errors: readonly DomainIssue[];
  constructor(code: DomainErrorCode, errors: readonly DomainIssue[] = []) {
    super(messages[code]);
    this.name = 'DomainError';
    this.code = code;
    this.errors = errors.map(issue => ({ ...issue }));
  }
}
