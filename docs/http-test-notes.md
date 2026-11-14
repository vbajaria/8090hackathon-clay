# Final verification — supersedes historical failures below

2026-11-14: all 13 cases in this suite passed in the complete root verification.
Validated mapping container shapes; removed owner-row writes from existing-workspace reads; ended the workspace transaction before usage acquisition; verified 30 concurrent polls; bounded result pages and conservative legacy-history freshness.
These are fixture results with zero live vendor requests. Earlier red findings
are retained below as the debugging history, not current release status.

# Fixture-only HTTP integration tests

Owned files: `packages/core/test/http.test.mjs` and this note. Work branch:
`8090/wo-2-complete-mvp-6afd80`. No application sources, project Test records,
work-order status, or development-server configuration are changed here.

## Reproduce locally

From `/workspace/vbajaria/8090hackathon-clay`, using the existing workspace's
Node 22, pnpm 9.15.0, and initialized local PostgreSQL 15:

```sh
pnpm build:packages
DATABASE_URL='postgresql://leadwork:leadwork-local-only@localhost:5432/leadwork' \
  node --test packages/core/test/http.test.mjs
```

No web server, standalone worker, browser, Supabase account, provider credential,
or external HTTP connection is required. The suite calls `createApp.handle`
with Web `Request` objects at `http://localhost:3000/api/...`. Mutations include
that exact Origin and JSON Content-Type unless testing their rejection.
Login cookies are read with Node `Headers.getSetCookie()` and replayed through
Cookie headers, not invented identities or browser storage.

Prerequisite: the parent's local setup/migration has created `app.run_rows`
with `source_versions` and `app.request_authorizations` (migrations 001–003).
The suite probes these before running; it does **not** apply migrations or start
services. If unavailable, finish the normal parent-managed workspace setup;
do not manually launch duplicate PostgreSQL/web/worker processes. Rebuild packages
after parent source fixes because tests import `dist`, not TypeScript sources.
Root `pnpm test` already picks this file up via the core `test/*.test.mjs` glob.
For deterministic queued-step assertions, no independent unscoped worker may
consume this fixture database during the run: it could legitimately claim the
queued formula before the test's explicit tick. If the parent's managed worker
is active, use a separate already-migrated **local fixture database** via
DATABASE_URL, rather than stopping parent services or starting another server.

Run only the defect regression:

```sh
node --test --test-name-pattern='malformed import mapping shapes' \
  packages/core/test/http.test.mjs
```

## Isolation and safety

- Real local PostgreSQL is required. A nonloopback DATABASE_URL or production
  NODE_ENV is rejected before fixture work.
- Each app uses explicit development/test auth, a newly generated 32-byte random
  signing secret (hex), an independent 32-byte base64 encryption key, and exact
  loopback APP_ORIGIN. Separate Alice/Bob logins produce server-derived identities;
  no environment-provided Supabase configuration is used for authentication.
- Shipped capability policies are pinned disabled; the gateway's real requests
  are explicitly disabled. A process-local `fetch` sentinel fails/counts attempted
  external I/O. Every fixture and the final hook assert **zero external calls**.
- Tests are sequential within this file. The pool has max 10 clients, a 5-second
  statement timeout and a 2-second connect timeout; each test has a 15-second
  timeout. Usage uses nested DB transactions, but its inner workspace check is a
  SELECT, not a conflicting upsert, and passes against actual PostgreSQL.
- Cleanup is registered before logins and deletes only workspace IDs resolved
  from these fixture-specific authenticated owner IDs. No truncation/global
  cleanup or nonfixture writes. Tables/plans/runs cascade within those workspaces;
  usage observations/consumption are explicitly deleted first.
- Production Worker claim/recovery scans are global. The explicit formula-only
  tick uses a transaction proxy that adds this fixture's workspace predicate only
  to candidate claim, recovery, and expired-plan SQL. All real worker transitions,
  transactions, fencing, publication, and formula computation remain unchanged.
  Thus it cannot claim or recover another owner's pending work.
- One deliberately faulty transaction wrapper and one throwing validation gateway
  verify sanitized 500 responses. All positive persistence flows use the real DB;
  no actual failing vendor or database service is contacted.
- The single oversized body is ~21 MB of UTF-8 JSON, generated from `é` characters
  whose JS string length is under the byte limit. A fake Content-Length of 1 must
  not bypass the actual streamed **21,000,000-byte** limit. Memory use is bounded
  to this one case; no huge persistent CSV/table fixtures are created.

## Coverage

1. Signed login/session, distinct owners, unauthenticated business APIs,
   signature tampering, logout cookie clearing and old-cookie replay rejection.
2. Missing/wrong/mismatched-loopback mutation Origin, including login/logout;
   failed logout does not revoke the legitimate session.
3. Table/typed-cell SQL persistence and a fresh app instance reading the same
   saved state; stale edit returns 409 with the actual latest cell. Client body
   ownerId is rejected; query/header owner spoofing cannot cross ownership.
4. Entire staged CSV correction flow (blank header and invalid exact number),
   stale plan conflict, second-owner denial, confirmed idempotent retry, changed-key
   conflict, one appended row, exact decimal storage, and raw CSV download of the
   **current edited value**, not original import text.
5. Public connection responses omit credentials/ciphertext; ciphertext is nonplain
   and decrypts with workspace/connection AAD. Default-disabled Hunter validation
   performs zero account-check I/O. Other-owner validate/disconnect denies;
   disconnect clears ciphertext and increments revision.
6. AI preview resolves actual saved cells with no execution/run creation or I/O.
7. Formula preview/confirm: live formulas are initially fresh and reused. A
   fixture-only stale cell then produces a queued formula run; repeated GET
   detail/list polling leaves step outcome/fencing unchanged. Only an explicit
   scoped Worker tick completes it. Other-owner run detail/cancel/retry, run plan
   confirmation, and run-filtered usage deny; owner usage has zero external starts.
8. Malformed JSON, wrong Content-Type, bad UUID path/query/cell/mapping inputs,
   and oversized UTF-8 request return safe canonical 4xx envelopes.
9. Unexpected DB/provider/credential-bearing diagnostics return only canonical
   `internal_error`, never raw SQL/provider payloads/credentials.
10. Malformed import mapping **container** shapes must also return 4xx. This
    regression currently exposes the source defect below.

HTTP cells extend the strict shared domain Cell schema with nullable UUID
`sourceStepId`; the suite explicitly validates that extension. HTTP progress adds
`createdAt`/`completedAt` per [API handoff](api-handoff.md), so the suite validates
those metadata separately before applying the strict domain progress schema.
Their presence is not a business-flow failure; direct use of the unextended strict
schemas would reject these DTOs.

## Verification and parent defect handoff

Verified on 2026-11-14: shared-package build passes. The initial nine business and
safety scenarios passed; adding the malformed-container regression reveals one
source defect. The final rebuilt run reports **10 tests: 9 pass, 1 fail, 0 skipped/TODO**,
with **zero external calls**. Final results must not be represented as an all-green acceptance
run while that regression remains red. No reload, managed browser session,
Next route adapter, production Supabase flow, cloud deployment, or real provider
behavior was tested here; these remain parent-owned checks.

### Invalid mapping container returns 500 instead of safe 4xx

Preconditions: signed-in fixture owner, existing private table; same loopback URL,
Origin and Cookie, `Content-Type: application/json`.

```http
POST /api/tables/<owned-table-id>/import/preview
Origin: http://localhost:3000
Content-Type: application/json
Cookie: <signed fixture login cookie>

{"csvText":"Name\nAda","mappings":{}}
```

Actual **HTTP 500** response:

```json
{"error":{"code":"internal_error","status":500,"message":"The operation could not be completed."}}
```

Expected: safe 4xx validation rejection (preferably canonical 422 `invalid_value`)
before attempting array operations. `TransferService.validate` calls `.map` on
`raw.mappings` without validating it is an array; the resulting TypeError becomes
500 in the application catch. Malformed entries `[null]` and `[42]` correctly
return 422; `null` container is treated as missing mappings and stages a
`needs_correction` plan, so it is not included as a failing-container case.

Captured reproduction used table `6e62ecee-4d64-416c-a160-50c0cf154258`; fixture
cleanup removes that table, so rerun the regression for a fresh one. The test
prints exact request/body/status/response for every offending case and retains
its required 4xx assertion (not skipped/TODO or rewritten to accept the bug).
Fix belongs to the parent application's input validation, outside these two
owned files. No application-source workaround was made.
