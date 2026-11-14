# MVP implementation and release verification

Date: 2026-11-14. Implementation is submitted for review, not certified production
acceptance. PR #2 is stacked on PR #1's branch; no PR has been merged.

## Reproducible local evidence

- `pnpm test`: **226 passing tests** — contracts 43, engine 25, providers 66,
  web helpers 11, real-PostgreSQL core 81. No skipped or expected-failing cases.
- `pnpm typecheck` and production web/worker builds passed.
- `node --test .8090/workspace-setup.test.mjs`: **8 passing** checks.
- Configured PostgreSQL, Next web/API and separate worker started after workspace
  reload. Health reported ready and `providerExecution: disabled`.
- GitHub CI passed on commit `510f569`, including frozen installation, production
  build, typechecks, migrations, environment checks and the 226-test suite.
- The bounded browser harness is `tests/browser/acceptance.spec.mjs` (90-second
  test, 10-second assertions, one worker, zero retries, synthetic identities/data).
  Use `E2E_REUSE_SERVER=1 pnpm test:browser` with managed terminals; standalone/CI
  `pnpm test:browser` starts its own web server and refuses an occupied port.
  Chromium: `pnpm exec playwright install --with-deps chromium`.

The harness checks UI import/mappings and acknowledged atomic append, formula
configuration and immediate post-save recalculation, read-only preview, explicit
zero-external reuse confirmation, immutable stale historical results, page reload
and reopening saved work, actual downloaded CSV bytes, zero external usage, and
second-owner table/run/export denial. It deletes only its own synthetic table.
**Browser harness passed locally**, including actual CSV download bytes and
second-owner denial. It is also included in GitHub CI.

## Work-order evidence map

| Work order | Implementation / evidence | Acceptance still gated |
| --- | --- | --- |
| WO-1 | Runtime contracts; 43 tests; normalized protocol evidence | Real-provider compatibility, authorization and billing certification |
| WO-2 | Docker/environment, finite setup, three managed services, CI; 8 checks | Approved production hosting and operations |
| WO-3 | Migrations 001–004, owner/table composite FKs, caps, immutable row snapshots, unique run cells | Production persistent database / migration rollout |
| WO-4 | Owner-scoped typed CRUD, CAS conflicts, views; PG/HTTP ownership tests; Supabase and local auth adapters | Real Supabase staging, session expiry/logout behavior |
| WO-5 | Staged correction, atomic/idempotent CSV append, stored-value safe export; engine/PG/HTTP cases | None beyond review and production rollout |
| WO-6 | Restricted formulas, types/references/cycles, reactive evaluation and freshness | None beyond review |
| WO-7 | AES-GCM encrypted secrets, public-safe DTOs, validation/revocation controls | Authorized nonbillable validation and real account evidence |
| WO-8 | PDL, Hunter, Snov async, OpenAI Responses; 66 bounded protocol/security tests | All live providers disabled pending certification |
| WO-9 | Frozen previews, explicit independent consent, reservations, duplicate confirmation, latest-input retry | Live budget / account approvals |
| WO-10 | Durable claims, authorization journal, fencing, cancellation, conservative recovery; 20 execution cases | Real provider interruption behavior and staging operations |
| WO-11 | Bounded result/provenance cursors, immutable polling, exact usage dedup/corrections; 11 ledger cases | Certified real usage observations |
| WO-12 | Persisted private table UI; helper tests and browser journey | Production auth / public deployment |
| WO-13 | CSV mapping/export UI; browser journey and actual CSV byte assertions | None beyond review |
| WO-14 | Provider connection and computed-column configuration UI; browser formula configuration | Real provider readiness cannot be simulated |
| WO-15 | Explicit run/retry/cancel controls, progress/results/provenance, honest usage UI | Paid end-to-end acceptance remains gated |
| WO-16 | PG execution/HTTP/concurrency/capacity/privacy regressions, bounded browser harness, this matrix | Authorized live-provider and real Supabase journeys |

## Manual browser evidence

Using explicitly labeled local development authentication and synthetic leads:
created a private table, mapped/imported two rows, configured an uppercase formula,
edited a source cell and observed `ADA VERIFIED` immediately, explicitly previewed
and confirmed two reused outputs, inspected their persisted values/snapshot source
references, and verified zero external starts. Intermittent run polling was fixed
and rechecked; the 30-concurrent-read regression also passes.

The Factory recorder extension emitted `/v1/events` 404 noise. A coordinated
browser download-capture operation became unavailable and was cancelled; that
operation is **not** claimed as captured evidence. The standalone automated browser
harness verifies download bytes without relying on the recorder. No screenshot
is claimed until a durable screenshot tool reference is available.

## Freshness and migration boundary

Historical steps persist fingerprints of actual direct inputs, transitive column
settings and editable source versions. Hashes are canonical, independent of JSONB
object ordering. Current/historical result freshness compares the step's own
fingerprint, not merely the latest live cell flag. Legacy stored steps without a
fingerprint are conservatively marked stale; they are not backfilled with guessed
inputs. New previews may explicitly reuse current fresh local outputs.

Refreshed upstream steps prevent reuse of old downstream formula values. Formula
recalculation refuses stale/unavailable computed inputs, performs no external IO,
and updates affected rows only during worker publication. Run-local frozen values,
not later live edits, supply downstream execution. Automatic formula values do
not retain a misleading source-step pointer to a different historical value.

## Not production acceptance

- No actual Supabase, provider lookup/generation, paid smoke test or cloud
  provisioning was performed. Fixture readiness flags are scoped to tests.
- Native capability policies and the gateway remain disabled for real requests;
  configuration/preview cannot bypass those gates.
- Approve platform, region/residency, model, expected costs/budgets and retention;
  provision persistent PostgreSQL and real Supabase; manage stable encryption keys
  and HTTPS origins securely. Never copy local generated env files to production.
- Authorize provider accounts and a bounded smoke-test budget. Verify company and
  both email capabilities, account/connection authorization, async deadlines and
  polling charges, and reported/estimated/unknown usage with sanitized evidence.
- Supabase logout removes cookies/revokes refresh access; already-issued access
  tokens may remain valid until expiry. Immediate replay revocation is implemented
  only for local development sessions; production session policy needs review.
- Ledger request time currently uses the first observed timestamp. Different
  estimate/reported currencies in a single observation are rejected, never summed.
- Local `/var/lib/postgresql/15/main` is ephemeral sandbox data, not a production
  persistence promise. Ordinary current-database restart recovery is supported;
  backup restore/reconciliation is explicitly excluded. Do not restart a worker
  against an older restored database without separately designed reconciliation.
- Requirements/blueprint edits remain pending review. The live-provider finding
  stays open; work orders are In Review rather than Completed.
