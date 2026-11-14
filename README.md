# Leadwork — Clay-style MVP

Private, owner-scoped lead tables with atomic CSV import, typed edits, formulas,
filters/sort/visibility, stored-value export, encrypted provider connections,
manual dependency-aware runs, provenance, cancellation/retry, usage accounting,
and editable review copies. Owners bring their own accounts; no outreach is sent.

The Next.js web/API and separate durable PostgreSQL worker are implemented.
**Live provider execution is deliberately disabled.** Fixture tests are not live
provider certification, real Supabase verification, or production deployment.

## Run locally

Requires Node 22, pnpm 9.15.0, and PostgreSQL 15 on a Debian-compatible host.
The connected Factory workspace manages database, web and worker terminals.
See [development setup](docs/development.md) for a standalone machine.

```sh
pnpm install --frozen-lockfile
pnpm build:packages
node scripts/workspace-setup.mjs
# Standalone only: start PostgreSQL if setup started and stopped it.
sudo pg_ctlcluster 15 main start
pnpm dev       # http://localhost:3000 — explicit local development sign-in
# Separate terminal:
pnpm worker
```

Do not start duplicate servers in the managed Factory workspace. Development
sign-in is loopback-only and is not a public authentication mechanism. Generated
private environment files are ignored by git; never copy them to production.

## Verify

```sh
pnpm test      # unit + real PostgreSQL fixtures; isolated leadwork_test locally
pnpm typecheck
pnpm build
node --test .8090/workspace-setup.test.mjs
# Install Chromium once; reuse the managed dev server:
pnpm exec playwright install --with-deps chromium
E2E_REUSE_SERVER=1 pnpm test:browser
```

Never point fixtures at production or a database with an active worker. Root
`pnpm test` isolates local jobs; CI uses a disposable PostgreSQL service.

- [Acceptance evidence and remaining release gates](docs/acceptance.md)
- [HTTP/API handoff](docs/api-handoff.md)
- [Provider protocol evidence](docs/provider-evidence.md)
- [Shared contracts](docs/contracts.md)

Limits: 5,000 rows, 50 columns, 10,000,000 CSV bytes and 2,000 AI-template
characters before substitution. Empty values stay empty. Fresh outputs reuse;
replacement preparation and overwrite consent are separate. Unknown external
outcomes never automatically replay. Current-database restart recovery is
supported; backup restore/reconciliation is explicitly excluded.

## Review / launch

PR #2 is stacked on PR #1's shared-contract branch; review/merge the foundation
first and then retarget the full application PR appropriately. Work orders remain
In Review, not accepted as Completed. Requirements/blueprint source edits still
need project review.

Production needs approved hosting/region/cost/retention, persistent PostgreSQL,
real Supabase configuration and staging verification, stable encryption-key
management, authorized provider accounts, and explicitly budgeted live evidence.
Neither environment variables nor readiness checks bypass provider release gates.
