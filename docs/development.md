# Development and deployment boundaries

## Supported local environment

Node **22**, pnpm **9.15.0**, and PostgreSQL **15**. `.8090/Dockerfile` uses Debian
`node:22-bookworm` and apt PostgreSQL 15; the Node 22 and PG 15 image tags receive
upstream patches (not immutable digest pins). Package installs use the committed
lockfile with `--frozen-lockfile`. Never run paid lookups to verify setup.

The workspace configuration installs dependencies, builds shared packages, then
runs the **finite** `scripts/workspace-setup.mjs`. It creates the local `leadwork`
role/database only if missing, runs the core CLI through `pnpm db:migrate`, and
writes missing local settings. It temporarily starts the Debian `15/main` cluster
only if stopped, and stops it in `finally` **only if it started it**. An existing
server is left running, including on migration failure. Existing role passwords
are not reset. A credentials mismatch requires manual investigation.

Setup requires root or passwordless sudo and the standard Debian cluster paths.
It refuses production mode, a nonlocal database URL, nondevelopment auth, or a
nonloopback application origin. Do not use it to configure a production system.
Local connection URL:

```text
postgresql://leadwork:leadwork-local-only@localhost:5432/leadwork
```

Generated `.env` and `apps/web/.env.local` must remain gitignored and are chmod
600. Setup preserves existing values, shares the same keys between the files,
and refuses conflicting keys rather than silently rotating them. Session secrets
use 32 random bytes encoded as hex; credential encryption keys use 32 random
bytes encoded as base64. Neither is checked in or printed. A pre-existing blank
value is filled; other custom environment entries remain intact.

- Root `.env`: worker dotenv entrypoint; do not rely on dotenv in production.
- `apps/web/.env.local`: Next.js local environment loading.
- `AUTH_MODE=development` is explicit, nonproduction-only sign-in, **not real
  Supabase authentication**. `APP_ORIGIN=http://localhost:3000` is required; use
  that hostname consistently for cookies and same-origin mutation checks.
- Development auth must not be made accessible as a public production service.
  The Next development server explicitly binds 127.0.0.1:3000;
  authenticate only via the loopback origin, not a public forwarded URL.

Long-running managed terminals:

| Terminal | Process | Port |
| --- | --- | --- |
| `postgres` | `runuser -u postgres -- /usr/lib/postgresql/15/bin/postgres -D /var/lib/postgresql/15/main -c config_file=/etc/postgresql/15/main/postgresql.conf` (via sudo) | 5432 |
| `web` | database readiness wait, then root `pnpm dev` | 3000 |
| `worker` | database readiness wait, then root `pnpm worker` | none |

The readiness script uses `pg_isready` (60-second bounded wait; override with
`WAIT_DATABASE_TIMEOUT_MS`, at most 300000) and never prints database credentials.
It proves server availability, not that migrations or credentials are correct.
Preparation proves the latter by running migrations before terminals launch.
The web readiness check is `curl --fail http://localhost:3000/api/health`; a
listening port alone is not readiness. Check `tmux ls` and terminal output on
failure. A failed finite setup is not permission to ignore migration errors.

## Manual local workflow

On a Debian host with PostgreSQL 15/main installed:

```sh
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install --frozen-lockfile
pnpm build:packages
node scripts/workspace-setup.mjs
# Setup leaves a previously stopped cluster stopped; start it before dev.
sudo pg_ctlcluster 15 main start
node scripts/wait-database.mjs
pnpm dev
# In another terminal, from the repository root:
node scripts/wait-database.mjs && pnpm worker
```

Do not manually launch duplicate servers alongside the managed terminals. Setup
is not a reload: workspace image/terminal changes apply only on a platform reload,
which interrupts services. Coordinate that reload after the parent implementation
is committed and pushed. Shared package changes require `pnpm build:packages`;
restart the worker after rebuilding. Web and worker share a database, not a
process. Use Ctrl-C/SIGTERM for ordinary worker shutdown, wait for exit, and
inspect run progress before restarting. Never infer safe redispatch from a
terminated process: unknown external outcomes remain unresolved, not automatically
replayed. Review the run and deliberately preview/confirm any allowed retry.

Local database data lives at `/var/lib/postgresql/15/main` in the workspace.
It is **ephemeral development data**, not a production persistence guarantee.
Ordinary restarts are supported; backup recovery/reconciliation is outside the
MVP. **Do not start a worker against an older restored database**: it can forget
external calls already made. Recovery requires separate reconciliation design.

## Checks and CI

```sh
node --test .8090/workspace-setup.test.mjs
pnpm build
pnpm typecheck
pnpm test:unit
# DATABASE_URL must refer to a disposable/migrated fixture database:
pnpm db:migrate
pnpm test
```

GitHub Actions uses Node 22, pnpm 9.15.0, frozen-lockfile installation and a
PostgreSQL 15 service. It builds web/worker, typechecks, migrates, and executes
root `pnpm test`, including **real core SQL fixture tests**, not just mocked unit
tests. Keys are generated per job; no Supabase/provider/cloud credentials are
supplied. Development auth is intentionally unavailable to production-mode
Next builds even though CI tests exercise it in nonproduction mode.

## Real deployment: separate approval required

Nothing in this setup provisions or preapproves Railway, Supabase, or paid provider
accounts. Before deployment, confirm platform suitability for separate web and
long-running worker services, region/data residency, connectivity, expected costs,
and operations ownership. Local setup is not evidence that production is ready.

1. Provision an external PostgreSQL database (Supabase Postgres or another managed
   Postgres). Set an explicit `DATABASE_URL` in **both** processes via secret
   management; require the host's TLS configuration and suitable pool limits.
   Never use the local password or rely on an application's development fallback.
2. Configure real Supabase Auth: `AUTH_MODE=supabase`, `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, allowed site/callback URLs including `/api/auth/callback`,
   email delivery and the production HTTPS `APP_ORIGIN`. Verify login, callback,
   session/logout and origin enforcement in staging. Missing configuration must
   remain gated, never implicit fake auth. No service-role key belongs in a browser.
3. Supply stable generated keys securely; web/API needs auth settings and the
   encryption key for Connections, worker needs database and encryption access.
   Keep secrets scoped to the process that needs them; do not expose database,
   session or encryption credentials through `NEXT_PUBLIC_*`. Store provider keys
   through encrypted Connections, never CI or source control. Back up keys securely;
   do not change the credential key while connections encrypted with it exist.
4. Build artifacts, run `pnpm db:migrate` once before deploying either process,
   then start web and worker independently. Root `pnpm dev` is local only;
   production web is `pnpm --filter @leadwork/web start` after `pnpm build`.
   Worker uses root `pnpm worker`. Set `NODE_ENV=production`, probe
   `/api/health`, and verify SIGTERM behavior in staging before rollout. Never
   invoke the local setup script or copy generated development env files there.
5. Leave real provider requests **disabled**. The gateway's real-network opt-in
   (`allowRealRequests`) is not a deployment environment toggle or authorization.
   The capability catalog currently sets `enabledForRealRequests=false`; no new
   environment variable here bypasses it. Per-provider enablement needs verified
   authorization, sanitized live evidence, retention handling, bounded deadlines,
   concurrency/rate/poll limits, and verified async polling-charge policy. Establish
   separate provider account budgets/caps and explicit approval; a budget is not
   permission to dispatch. Configuration validation must not perform a paid sample.
6. Verify sanitized operational logs: no raw lead data, prompts, credentials,
   auth cookies or unsanitized provider payloads. Confirm unresolved-run handling
   after interruption before enabling dispatch. Health/readiness alone is not
   proof of exactly-once external execution.

## Verification status for this change

Eight environment regression checks passed. Two coordinated workspace reloads
built the configured image and started PostgreSQL, the web app and the worker;
`/api/health` returned ready with external provider execution disabled.
Production provisioning and real-service verification remain separate gates.
See [final acceptance evidence](acceptance.md) for the current delivery state.

## Isolated verification database

`pnpm test` uses `leadwork_test` locally, which finite workspace setup creates separately from the running app's `leadwork` database. This prevents the managed worker from claiming synthetic acceptance-test jobs. Never point fixtures at production. For another development database, supply `TEST_DATABASE_URL` for an isolated test database. CI uses its disposable service database. The low-level core package test command consumes `DATABASE_URL` directly and must not share a database with an active worker.
