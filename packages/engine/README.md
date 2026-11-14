# @leadwork/engine

Pure Node 22 / TypeScript ESM domain functions for WO-5 and WO-6. This package performs no persistence, authentication, provider IO, or worker orchestration.

## Integration surface

```ts
parseCsv(text: string): { headers: string[]; rows: string[][] }
exportCsv(headers: string[], typedRows: CellValue[][]): string
parseEditableValue(type: CellValue['type'], text: string): CellValue
columnDependencies(column: Column): string[]
validateColumnConfiguration(columns: Column[]): void
topologicalColumns(columns: Column[], selectedIds: string[]): Column[]
evaluateFormula(expression: string, valuesByColumnId: Record<string, CellValue>): CellValue
resolveInstructions(template: string, valuesByColumnId: Record<string, CellValue>): {
  resolvedInstructions: string; missingColumnIds: string[]
}
csvHeaderIssues(headers: string[]): {
  sourceIndex: number; code: 'blank_header' | 'duplicate_header'
}[]
```

`Column` and `CellValue` come from `@leadwork/contracts`. Public failures are `DomainError` with stable `code`, static safe `message`, and lead-free `errors` containing optional UUID column IDs and zero-based row/source indexes. These are domain codes, **not** HTTP contract error codes: callers must map them to `apiError` / import issues without exposing source values or raw caught errors. `malformed_csv` diagnostics index data rows; header syntax errors omit the row index. CSV header issues are correction issues, not parser exceptions. Headers are preserved, never silently renamed or discarded. The current `ImportPlanSchema` rejects blank/duplicate headers even in correction state; retain raw parse data separately until the caller has supplied corrected names. Name uniqueness uses trimmed, case-insensitive names.

## CSV and editable values

The parser counts UTF-8 bytes (including a BOM) against the 10,000,000-byte limit, then strips one leading BOM. It accepts quoted commas/quotes/newlines, CRLF/LF/CR records, and a final record without a terminator. It preserves duplicates, empty cells, whitespace and all quoted content. Unterminated/misplaced quotes, characters after closing quotes and ragged records reject safely. Empty input returns empty headers/rows; an ending record separator does not manufacture a row.

The exporter uses CRLF and RFC quote escaping. Text **and headers** with spreadsheet-executable prefixes are apostrophe-neutralized, including leading whitespace/control/Unicode-format prefixes; actual tagged numbers (including negative values) are never neutralized. Only saved typed values are accepted; no computed work is launched. Header-only scopes are supported.

Only `''` is an empty editable value and becomes typed null; whitespace text remains text, whitespace numbers/dates/booleans fail. Numeric strings retain exact spelling/sign/scale. Dates must be valid `YYYY-MM-DD` calendars, years 0001–9999. Booleans must be lowercase `true` or `false`.

## Formula language

`{{UUID}}` references, signed decimal literals, quoted text (single/double quotes with `\\n`, `\\r`, `\\t`, escaped quote/backslash), `true`, `false`, `null`, parentheses, unary `+/-`, `+ - * /`, and `= == != <> < <= > >=` are supported. Identifiers are limited to the uppercase functions in exported `FORMULA_FUNCTIONS`: `CONCAT`, `LOWER`, `UPPER`, `IF`. No executable JS, properties, arrays, provider operations or expression interpolation.

Precedence is unary, multiplication/division, addition/subtraction, comparison. Arithmetic requires tagged numbers. Comparisons require matching types (numeric comparisons use exact decimals; text/date comparisons use lexical order). `IF` requires a boolean condition and evaluates only the selected branch. Case functions require text. `CONCAT` stringifies nonmissing typed values, preserving false and zero. A missing or null reference produces `missing_value`; there is no truthiness coercion. Literal `null` returns a text-tagged null; the caller must reconcile the configured formula return type before writing cells.

`decimal.js` avoids binary-floating-point arithmetic. Add/subtract/multiply are exact within the supported bounds. Division is rounded half-up at **100 significant decimal digits**; recurring results cannot be represented exactly. All numeric outputs are plain decimal strings, not exponent notation. Exported `FORMULA_LIMITS` bounds expression length (16,000 UTF-16 units), node count (512), parser/AST depth (64), numeric output length (10,000) and text output length (100,000).

## Configurations, dependencies and AI

Validation rejects invalid schema/UUIDs, duplicate IDs/names, unknown references, declared reference mismatches, non-text provider inputs, extra per-column conditions and dependency cycles across all computed kinds. Formula/AI declarations must match the actual unique UUID references exactly as a set. Quoted formula text is not a dependency. `topologicalColumns` expands the prerequisite closure and returns **computed columns only**, once each, with prerequisites first and table order as the selected-column tie-breaker.

Documented email compatibility matches `docs/provider-evidence.md`: Hunter allows explicit full-name or mapped-parts input; Snov requires explicit mapped parts with owner-mapped/owner-confirmed source; Tomba is reserved and rejected until evidence exists. Fixed mappings are allowed. Names are never decomposed. Company and AI kinds imply PDL and OpenAI respectively under the existing contracts. Connection ownership, associated provider keys, revision/readiness, real execution gates and output/return-type reconciliation are the integrating service's responsibility.

AI templates must be nonblank, at most 2,000 Unicode code points and use only UUID `{{...}}` references. Preview replaces absent or null inputs with empty text and returns distinct missing IDs in occurrence order; false, zero and an explicit text empty string are not missing. Substituted values are never reparsed as templates. Resolved previews are lead-bearing data and must not be logged.

## Build and verification

Dependencies: `@leadwork/contracts: workspace:*`, `decimal.js: 10.6.0`; development `typescript: 5.9.3`.

```sh
pnpm --filter @leadwork/contracts build
pnpm --filter @leadwork/engine typecheck
pnpm --filter @leadwork/engine test
```

Tests use `node:test` against compiled `dist/*.js` without database/provider fixtures or live services. Workspace installation and root build/test wiring belong to the parent integration task.

## Parent-owned release responsibilities

This helper **does not implement atomic imports**. The caller owns source/header correction state, mapped destination validation, all-row validation, owner-scoped staged plans, table-capacity checks under lock, idempotent confirmation and transactional append. It also owns export snapshot consistency/warnings, live formula recalculation, configured return-type validation, freshness fingerprints/stale writes, AI output bounds and connection authorization. Do not mark WO-5/WO-6 fully complete solely because these helpers pass.
