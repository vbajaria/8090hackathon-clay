# Shared contracts — implementation handoff

WO-1 publishes a bounded eight-source-file TypeScript package for independent API, worker and client development. It does not implement feature handlers, database persistence, a worker or frontend.

## Source of intent and status

- [Requirements](https://factory.8090.ai/project/addc29be-86bc-4eae-80f4-2d23939ce8d0/requirements/f03c2fe4-c209-4c46-9859-db8d7a845e92)
- [Blueprint](https://factory.8090.ai/project/addc29be-86bc-4eae-80f4-2d23939ce8d0/blueprints/1dfe0d57-6144-4a01-a73a-b55521c25592)

These documents still contain pending review edits. This package follows the discussion decisions captured in WO-1; it does not silently approve pending specifications. The blueprint's shared-contract finding stays open for review. Product capacities are 5,000 rows, 50 columns, 10,000,000 CSV bytes, and 2,000 pre-substitution AI instruction characters. Page size 250 is an implementation bound, not a new product entitlement.

## Pinned local foundation and provisional architecture

Contracts: Node 22.x, pnpm 9.15.0, TypeScript 5.9.3, Zod 3.25.76, ES modules. Lockfile is committed. This package uses no server, database, network, environment secrets, credentials or provider SDKs.

The proposed feature stack remains Next.js/React web/API, separate Node worker, Postgres durable queue, Drizzle, Supabase Auth/Postgres and Railway web/worker services. **Hosting, region, model, retention, costs and pending document edits still require review before production integration/provisioning.** WO-2 owns environment and application scaffolding. No infrastructure has been provisioned and no `.8090/environment.json` is added by WO-1.

## Package surface

| Module | Shared boundary |
| --- | --- |
| `common.ts` | UUID IDs, decimal-string revisions/numbers, typed blank values, capacities, safe error definitions and HTTP codes |
| `table.ts` | Column settings, fixed column IDs, typed cell edits/conflicts, saved views, allowlisted filters, row scopes and cursor pagination |
| `transfer.ts` | CSV upload references/mappings, correction plans, preview validity/capacity/expiry, confirmation, commit result and export acknowledgement |
| `run.ts` | Run previews/dependency closure, attempt/poll bounds, required consent, frozen-plan shape, progress counters, retry targets and results |
| `provider.ts` | Explicit name modes, capability readiness gates, normalized result/task/attempt shapes, public secret-free connection DTOs and waterfall-stop policy |
| `usage.ts` | Unknown/known money/units, separate estimate versus reported amounts, source observations and authoritative attempt projections |
| `fixtures.ts` | Synthetic conflicts, import correction/expiry, missing-input counts, unknown costs/outcomes, retries, cumulative observations, disabled documented candidates |
| `index.ts` | Public runtime schemas and inferred types; fixtures exported separately |

```ts
import { RunConfirmRequestSchema, checkRunConfirmation } from '@leadwork/contracts';
import { runPreviewFixture } from '@leadwork/contracts/fixtures';

const request = RunConfirmRequestSchema.parse(untrustedRequestBody);
const error = checkRunConfirmation(runPreviewFixture, request, new Date());
// In the real handler, authorization and transactional revalidation must precede persistence.
```

All request objects reject unknown fields rather than stripping spoofed ownership. Servers derive owner context, never accept it from request JSON. Public safe errors use a fixed code/status/message definition and typed context. Never send raw provider error messages or Zod issue payloads containing lead data directly to the client.

Decimal strings preserve exact numeric quantities across JSON, including revisions above the JS safe-integer limit. No currency conversion or merging of incompatible units is implied. `null` is the explicit blank typed value; CSV parsing in WO-5 must normalize empty fields and validate lowercase booleans/base-ten numbers before emitting these typed values. Schemas do not parse CSV text.

## Mandatory service responsibilities (not implemented by schema validation)

1. **Authorization:** authenticate and scope every lookup/plan/cell/export/usage read by the server-derived owner. Valid UUIDs do not authorize access; return nondisclosing 404 for inaccessible resources.
2. **Structural validation:** verify column existence/types, dependency graphs/cycles, formula grammar, watermark/cursor contents, view revisions and actual provider mapping compatibility. `checkCellPatch` is a shape/type guard, not an authorization or save operation.
3. **Import transaction:** stage all rows owner-scoped, validate the full file and corrections, recheck live table counts/revisions, commit rows/columns atomically, and bind idempotency keys to request fingerprints. Preview readiness does not replace these checks.
4. **Confirmation transaction:** resolve the full selected/filtered/all scope, persist fixed base inputs/settings/reused results, recheck live input/config/connection revisions, authenticate preview ownership, reserve all computed cells atomically, and bind idempotency to content. The pure confirmation helpers only check plan identity/revision, expiry, blockers and consent.
5. **Execution:** persist dispatch intent and task handles before I/O/polling; no implicit retries; advance waterfall only on confirmed no-result; never replay unknown attempts automatically. Current schemas do not provide exactly-once execution, a state machine or database locks.
6. **Cancellation/deletion:** stop new authorization, retain authorized in-flight work until terminal, prevent late recreation, gate destructive column/row/table changes on active reservations, and purge lead-bearing source/snapshot/result data safely.
7. **Usage projection:** deduplicate source observations, supersede cumulative reports, apply each delta once, keep estimates separate, and aggregate only compatible currency/unit dimensions. Schema tests demonstrate the DTOs; they do not implement a ledger.
8. **Export/rendering:** consistent stored-data snapshot, acknowledgement for pending/failed/stale/unknown outputs, spreadsheet injection neutralization, CSV quoting, generated text treated as untrusted plain text. There is no exporter or renderer in this package.
9. **Provider activation:** disabled candidate fixtures are not mocks substituting for the two required real providers. See [provider evidence and gates](provider-evidence.md). Account readiness and policy evidence must come from authorized server-side validation, never from caller-supplied connection DTOs.

Retries use current saved values/settings and a new preview linked to the parent run. Unknown outcomes require the possible-duplicate-charge warning and explicit renewed consent. Failed/no-result refreshed prerequisites cannot supply old outputs downstream. Run outcome and staleness are separate fields. Mixed terminal results can complete a run; canceled/completed runs must have no queued/running steps.

Ordinary worker recovery against the current database is in scope later. **Database restore recovery is excluded:** never dispatch work against an older restored database without reconciliation of lost provider execution evidence.

## Verification

`pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`.

The Node test suite imports the compiled ESM package and fixtures, so verification exercises the delivered JS/declarations, not a test-only transpiler. Tests cover runtime boundaries, precision, invalid dates/URLs, safe errors, editable types, mapping/capacity/readiness, preview expiry/consent/poll bounds, retry warnings, terminal counters, explicit name compatibility, disabled provider policies, and lead-free usage DTOs. No live-service, database, HTTP-handler, browser or production-security certification is claimed.

Enrichment input mappings support stable column references **or owner-supplied fixed text**. Configured email waterfalls may select one or more distinct providers; offering at least two compatible real providers is a platform launch gate, not a requirement to use both in every column/run. Email usability follows AC-LET-012.11: exactly one `@`, nonempty local/domain parts, no whitespace; it does not enforce deliverability or stronger RFC/domain conditions. Normalizing domains and validating each provider's fixed/mapped inputs remains a service responsibility.
