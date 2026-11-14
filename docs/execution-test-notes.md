# Final verification — supersedes historical failures below

2026-11-14: all 20 cases in this suite passed in the complete root verification.
Qualified rate-limit SQL; moved wait before poll authorization; rechecked cancellation/revocation/fences before IO; persisted request authorizations; added reactive/frozen-input freshness regressions.
These are fixture results with zero live vendor requests. Earlier red findings
are retained below as the debugging history, not current release status.

# WO-16 execution acceptance evidence

Owned scope: `packages/core/test/execution.test.mjs` and this note only. Runtime,
HTTP/browser integration, migrations, and provider certification belong to the
parent integration work. No PR or work-order status change from this subtask.

## Run locally

Requires Node 22, built contracts/engine/providers/core, and a local PostgreSQL
with migrations 001/002 already applied by the parent:

```sh
pnpm build:packages
node --test packages/core/test/execution.test.mjs
```

`DATABASE_URL` overrides the existing local-only development database default.
Every test has a 15-second Node timeout, drains at most 12 worker ticks, and uses
1-second fixture deadlines (5-second leases), 2 concurrent operations, 1000
requests/minute, and at most 2 polls. The second-provider rate-limit test forces
zero capacity only after valid preview/confirmation to exercise the boundary.

## Fixture-only safety and isolation

- `createApp` receives an object implementing execute/poll/validate; no real
  provider gateway, auth-provider request, account validation, or paid I/O occurs.
- Fixture provider requests and results are checked with the exact shared schemas.
- Policies clone the catalog and mark `live_verified`/enabled **only for fixtures**;
  this is not real certification evidence or permission to enable production.
- Each fixture generates a random 32-byte base64 encryption key, owner/workspace,
  and encrypted connections using ConnectionService and its proper workspace/id
  AAD. SQL sets restricted synthetic ready/validated-at/evidence UUIDs. Validation
  calls fail deliberately and the cleanup asserts they never occurred.
- Worker claim/recovery scans are constrained to the synthetic workspace by a
  narrow transaction-query proxy. Other worker SQL, transitions, locking,
  dispatch authorization, journal, publication, and reader code remain real.
  Expired-plan cleanup is similarly workspace-scoped. This protects concurrent
  parent fixtures; it does not test production global queue scheduling.
- No schema migration/truncate/global deletion. Cleanup deletes only owned tables
  (cascading run references), retained usage observations/consumption, connections,
  and workspaces. A second owner is separately isolated and cleaned.

## Coverage

19 cases cover manual-only dispatch after import/edit/read, company → formula →
AI fresh same-run dependencies, duplicate confirmation, provenance order,
unknown versus known-zero usage, email waterfall no-result/error/unknown stops,
missing/invalid inputs with zero I/O, just-before-authorization policy/revocation,
queued/in-flight cancellation, stale publication after input/config edits,
immutable snapshots, timeout terminality, latest-input retry consent, expired
unstarted requeue versus dispatch-intent unknown, late fenced usage-only reports,
reservation overlap/release/fresh reuse, waterfall rate-bound no implicit
restart, persisted async tasks/two-poll bounds, and async cancellation boundaries.

## Initial integrated result

After correcting a fixture-only schema mismatch (catalog display metadata must
be removed before parsing the strict policy schema), the first real runtime run
reported **5 passed / 14 failed**. PostgreSQL rejected dispatch authorization:

```text
42702: column reference "created_at" is ambiguous
Worker.authorize: COUNT(*) FILTER(WHERE created_at > now()-interval '1 minute')
FROM app.attempts a JOIN app.steps st ... JOIN app.runs r ...
```

Required parent fix: qualify the attempt timestamp as `a.created_at`. This is a
runtime SQL regression, not a fixture expected failure; tests remain strict.
Deferred tests now race fixture entry against tick completion/rejection to expose
this exact error rather than waiting or producing unhandled rejection noise.

Later integrated results will be recorded below. No browser, deployed service,
real-provider certification, or paid smoke-test completion is claimed here.

## Final verification at this handoff

- `node --check packages/core/test/execution.test.mjs`: **passed**.
- `pnpm --filter @leadwork/core build`: **passed** against the parent's current
  uncommitted runtime interfaces.
- `node --test packages/core/test/execution.test.mjs`: **5 passed / 14 failed**,
  exit 1, approximately 0.61 seconds. No skipped/canceled/todo cases.
- Passing proofs: missing input, invalid domain, just-before-authorization
  connection revocation, just-before-authorization policy disablement, and queued
  cancellation/reservation release. All verify zero fixture dispatch I/O.
- All 14 failing cases still encounter PostgreSQL 42702 in Worker.authorize;
  their downstream assertions are **unverified**, not accepted or expected fails.
- Manual retry coverage now executes the separately consented latest-input retry
  and checks its new parent-linked run, frozen original inputs/outcome/attempts,
  and request domain, once parent dispatch is functional.
- Every pg client has 5-second statement and 2-second connection acquisition
  bounds. Deferred fixture-entry waits race the worker tick's error/completion.

### Next boundary regression to run after the SQL fix

`cancel after async authorization but during poll wait must not issue a new poll`
uses the real boolean-returning polling authorization transaction as its signal.
It commits owner cancellation immediately after that transaction, while the
worker is still before its 50ms delay/poll call. Current inspected worker code
checks cancellation **before** the delay, then polls without rechecking; this is
an identified code-level race, not yet an executed failing proof because the SQL
blocker prevents reaching it. Do not mark this case expected-fail or weaken its
zero-poll assertion. Parent should review whether the authorization-to-dispatch
boundary needs moving after the delay or otherwise coordinating cancellation.

### Parent handoff

Tests and notes were pushed on `8090/wo-2-complete-mvp-6afd80` only. The first
milestone is commit `645f2f8`; a subsequent milestone adds final bounds, stronger
retry assertions, and this verification record. Runtime source was never patched,
and no test-only bypass hides the SQL regression. Run this suite again after
parent runtime fixes; it deliberately remains red until real acceptance holds.
