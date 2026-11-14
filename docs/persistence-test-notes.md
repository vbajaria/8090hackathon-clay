# Postgres persistence integration tests

Owned regression file: `packages/core/test/tables-transfer.test.mjs`.
These tests exercise actual `TableService`, `TransferService`, and `Planner`
transactions against Postgres, not mocked repositories. Imports target individual
`dist/db.js`, `migrate.js`, `tables.js`, `transfer.js`, `planner.js`, and the
providers' `dist/catalog.js`, so core index/worker/API development is independent.

## Run locally

```sh
pnpm --filter @leadwork/core build
DATABASE_URL=postgresql://leadwork:leadwork-local-only@localhost:5432/leadwork \
  node --test packages/core/test/tables-transfer.test.mjs
# Existing Node test files run in separate processes with normal file parallelism:
node --test packages/core/test/*.test.mjs
```

Build contracts, engine and providers first on a fresh checkout (`pnpm
build:packages`). The local URL above is the fallback when `DATABASE_URL` is
unset. A missing database or migration failure is a real test failure, not a
skip. Use a local test database, never production. Migration startup uses the
existing advisory-locked migrator; tests never reset or truncate a schema.

## Isolation and safety

- Each test creates UUID owners, workspaces, tables, rows, columns and keys.
  Cleanup is registered before writes and deletes only its two workspaces'
  tables, sanitized ledger records, connections and workspaces. Cascades remove
  the fixture's plans/runs/steps/snapshots. No global counts or global deletes.
- All negative direct-SQL writes run inside `Database.transaction`; both expected
  SQL failures and unexpectedly accepted writes roll back. FK tests assert
  Postgres `23503`; capacity tests assert `23514`. State checks establish that
  failed writes leave no lingering invalid records or counter changes.
- 5000-row/50-column fixtures use bulk SQL (one request per row/column batch),
  real capacity triggers and real counts. Raw fixtures intentionally omit cell
  payloads: they test capacity, not complete production row construction. Direct
  fixture inserts deliberately preserve table revision to reach confirmation's
  capacity check instead of its earlier stale-revision check.
- No gateway, worker, credential/auth validation, or vendor client is invoked.
  Provider planning uses the default-disabled capability catalog and one
  SQL-created synthetic ready connection containing no real credentials.
  A throwing `fetch` sentinel additionally verifies preview/blocked confirmation
  do not use fetch. This is not an assertion about worker dispatch transports.

## Coverage

1. Four default editable columns; private owner list/read/write/delete/export;
   second-owner staged import correction/confirmation and run confirmation denial.
2. Cell CAS current-value evidence; dependent formula recomputation.
3. Exact numeric filtering/sorting above JS safe-integer range, stable insertion
   ties, paginated results and stale table/view cursor rejection.
4. Blank/duplicate CSV headers and invalid numbers; correction on the same plan;
   exact decimal storage, CSV quoting, four simultaneous identical confirmations,
   idempotent append and changed-request/key conflicts.
5. 5000-row and 50-column service/database barriers; atomic failed confirmation at
   each capacity, unchanged committed state, then success with the same key after
   fixture-scoped capacity is released.
6. Reference mismatch, configuration cycle and referenced-column deletion denial;
   active reservations block column type conversion/deletion and row/table deletion.
7. Preview creates no execution/usage records, performs no external request, and
   disabled policy blocks confirmation even with a synthetic ready connection.
8. Fresh formula outputs reused in a completed run; confirmation retries do not
   duplicate runs/steps; source edits cannot mutate normalized row snapshots;
   SQL protects run config/fingerprint/key and row values/source versions.
9. Cross-table/workspace composite FKs for cells, plans, runs/parent runs, steps,
   reservations and run-row snapshots, using rollback-only negative transactions.
10. Row deletion cascades its cells, steps and normalized snapshots, removes staged
    plans, and preserves the other row's snapshot and non-PII run config.

Worker execution and HTTP endpoints are explicitly outside this file's scope.

## Verification evidence

- At source commit `4444a18`, `pnpm --filter @leadwork/core build`: exit 0.
- Initial isolated run: 14 tests passed, 0 failed/skipped, approximately 2 seconds.
- Final `pnpm --filter @leadwork/core build && node --test packages/core/test/*.test.mjs`:
  exit 0, 43 tests passed, 0 failed/skipped; test duration approximately 2 seconds.
- Two simultaneous `node --test packages/core/test/tables-transfer.test.mjs`
  processes sharing the same Postgres database: both exit 0, each 14 tests passed,
  0 failed/skipped, approximately 2.1 seconds per process. Both include concurrent
  identical import and run confirmations; fixture cleanup did not interfere.
- During strengthening, an assertion comparing `JSON.stringify` output failed
  because Postgres JSONB reorders object keys. Corrected the **test assertion** to
  structural `assert.deepEqual`; no service fix or weakened semantic requirement.
  The final results above are from reruns after this correction.

No service defects were observed in the requested regressions. If a
regression fails, preserve the failing assertion and report the exact test/error;
do not change parent-owned service sources from this task.
