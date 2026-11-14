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
