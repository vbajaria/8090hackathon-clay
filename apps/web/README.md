# @leadwork/web — WO-12 / WO-13 / WO-14 / WO-15

Production Next.js App Router client. Only `apps/web/**` excluding `app/api/**` is UI-owned. The shared working branch is `8090/wo-2-complete-mvp-6afd80`; the parent owns the catch-all server bridge, durable persistence, root dependency install/lockfile and E2E. No new server, root manifest changes, PR or work-order status changes were made by this task.

## Dependencies / integration

Registry-resolved exact versions: Next **16.4.6**, React / React DOM **19.3.1**, TypeScript **5.9.3**, `@types/react` / `@types/react-dom` **19.3.0**, `@types/node` **22.20.5**. Next's registry engines (`>=20.9.0`) and React peers (`^19.0.0`) support the project's Node 22 and these React pins. Workspace dependencies: `@leadwork/contracts`, `@leadwork/engine`. No external fonts, images, CDN assets, provider SDKs or browser secrets in logs/storage. No UI simulations, localStorage or client-originated provider calls.

Parent: install the root workspace dependencies, build contracts/engine, then:

```sh
pnpm --filter @leadwork/web typecheck
pnpm --filter @leadwork/web test
pnpm --filter @leadwork/web build
```

This task verified using an isolated npm install in `/workspace/.leadwork-web-verify` and ignored `apps/web/node_modules`, leaving root files untouched. Parent may replace/remove ignored `apps/web/node_modules` before the normal pnpm install. Tests use Node 22 type stripping; they require built workspace contracts/engine and no API credentials. The UI fetches only `/api/*` same-origin, with cookie credentials and no-store reads. Next's static `/` shell does not embed workspace data.

## Implemented boundaries

- Session gate, unconfigured setup gate, Supabase email-link request, explicitly labeled development sign-in, logout; genuine empty tables separate from loading/error/retry.
- Table create/open/delete, blank rows, selected row deletion, text/number/date/boolean editors with string CAS versions, unsaved/invalid/conflict states and explicit post-interruption read reconciliation. Computed cells cannot be directly edited.
- Server-paged 100-row table (no 5,000-row DOM), stable cross-page selection, filters, multiple sorts and server-saved visible columns. Full filtered scopes do not mean the loaded page.
- Existing/new editable columns; formula function guidance, stable UUID reference insertion/selection, missing/reference/cycle validation; company domain input/output; ordered email waterfall with one or more providers, fixed or column inputs, explicit owner-mapped name parts; AI provider/model/template and saved-only resolved preview. Snov compatibility is taken from the catalog and mapped-parts-only is enforced by the engine. No silent full-name splitting.
- Provider catalog/authorization status and real-policy gates; safe credential POST and direct-billing acknowledgement. A successful form submission never implies readiness. Configuration changes never run providers.
- Selected/filtered/all manual run preview, explicit scope if none selected, outputs/prerequisites/counts/provider estimates/skipped reasons, four independent opt-ins, expiring/versioned/idempotent confirmation. Latest table revision is fetched before each new run preview. Retry preview uses the server's latest saved inputs and defaults to failed cells; optional unknown retry warns about duplicate charges.
- Read-only visible-tab polling of persisted progress, active/recent run restoration, all nine counters, final completion metadata, pending cancellation/in-flight charge disclosure, saved results in bounded 50-result DOM pages, provenance attempts in the server-supplied `attemptIds` order. No implicit runs or automatic paid retries.
- UTC month and run-ID usage filters; reported/estimated/unknown amounts and provider/currency/unit groups remain distinct.
- CSV 10,000,000-byte file gate, server header/sample detection, up to ten preview rows, editable-only destinations, new typed columns, staged header/mapping/cell corrections (including invalid rows beyond the ten-row sample), confirmation disabled until server validation is ready and staged changes are validated. Stable confirmation keys prevent duplicate imports on uncertain retries.
- Export default filtered scope and visible-column order, selected/all alternatives, warnings/acknowledgement, safe stored-value blob download. No recomputation. Draft inspection/copy to editable text with populated-destination confirmation; original output unchanged.

## Handoff notes / limitations (do not silently change API)

1. HTTP preview/correction bodies deliberately follow `docs/api-handoff.md`, not the lower-level upload/domain request schemas. Initial import accepts `{csvText,mappings:[]}`; correction accepts header/mapping updates in addition to cell corrections. The HTTP layer must return a staged plan even for invalid/duplicate headers; those plans cannot be strictly parsed by `ImportPlanSchema` until corrected. The UI retains them as correction state rather than pretending they are ready.
2. `RunResultSchema` has no source-result reference for reused output. The UI recognizes optional `sourceResultId`, otherwise explicitly displays **Source reference unavailable in API response**. Parent must supply an agreed public reference to fully satisfy AC-LET-018.7; UI does not invent one.
3. Run attempt summaries have no specified public field schema in the handoff. The UI links sanitized summaries by `id`, preserves `provenance.attemptIds` order and displays their supplied fields verbatim as text. Missing summaries and absent verification are labeled unavailable. The parent must keep these DTOs sanitized (no credentials/raw provider payloads).
4. Full run detail results arrive in a single server response because no results-pagination route is specified; DOM rendering is bounded to 50, but network/memory consumption still scales with the result count. Run-preview skipped reasons show the first 100 with disclosure. Import issues remain fully visible to permit corrections outside the sample.
5. AI preview intentionally previews **saved** instructions only. New/edited templates must be saved and the editor reopened before preview. Model selection is an explicit text field because the handoff has no model catalog. Client syntax validation does not certify a model/provider as usable.
6. Configuration can be saved against an existing unvalidated connection; external confirmation remains blocked by the authoritative server preview/readiness/policy. Catalog provider gates are real, never represented as pretend ready. Person enrichment, research, conditions, outreach and funded credits are absent.
7. For ordinary table/row creation the handoff has no idempotency key or operation-status endpoint. Network errors disclose uncertain outcomes and instruct saved-state reconciliation; the owner must review the refreshed workspace/table before repeating a create. Cell reconciliation and import/run stable-key retries are stronger. Do not treat a network failure as proof that a mutation was rolled back.
8. Server deletion barriers, type conversion and dependency rejection are surfaced as retryable errors; UI doesn't override them. Selection includes stable IDs from previous pages and the server must validate deleted/invalid targets.
9. UI authentication/provider behavior has not been live-verified: the parent owns Supabase callback integration, Postgres, worker execution, authorized real-provider certification and browser E2E. No actual paid calls were made. This task did not claim live-provider or browser-test success.

## Verification performed

- Node 22 credential-free client tests: **11 passed**, including precise decimal/blank/boolean/date validation, scope requirements, dependency/missing/reference/name compatibility, independent consent, contract-valid payloads, genuine empty API replies, same-origin requests, CAS conflicts, uncertain saves and CSV blobs.
- `tsc --noEmit`: passed.
- `next build`: passed (Next 16.4.6 / Turbopack); `/` and `/_not-found` prerendered successfully. Parent's API route is separately owned and was not present during initial standalone client verification.
- No duplicate dev server started; no browser testing was performed by this child task.

## Parent browser/E2E checklist

Use the existing parent server, not a second Next instance. Mock the API only in tests, never as a production fallback. Include keyboard-only and narrow viewport checks.

1. `/auth/session`: null Supabase user, development mode, unconfigured setup gate, 500 retry; request email link and callback to real session. Sign out and ensure subsequent data is blocked. Check browser logs/network for leaked credentials.
2. `/tables`: genuine `[]` creates an empty state; 500 never does. Failed create preserves entered name. Create/open/delete table and verify permanent-delete confirmation plus active-work 409.
3. Edit a typed cell: empty/zero/false, malformed date/decimal, failed save, two-session CAS with current saved value, interruption then explicit GET reconciliation. Navigate/refresh with unsaved edits. Add/delete rows, switch 100-row pages and select stable IDs across pages.
4. Add/rename/delete/type-change columns; verify 50-column and 5,000-row gates, dependencies/cycles and nonempty-value rejection. Formula errors must not render fabricated outputs.
5. Save AND filters, multi-sort and visibility, then reopen/refresh. Zero matches offers Clear filters. Verify blank-last sort and filtered runs use the full server scope, not loaded rows.
6. Provider catalog: ready/unvalidated/invalid/disconnected plus policy gate. Hunter supports full name/parts; Snov only explicit parts, no silent split. Configure one-/two-provider waterfalls and order them. Assert no provider/run requests on save/import/view/open.
7. AI: missing UUIDs, >2,000 characters, cycles, saved resolved preview without generation. Inspect a real stored draft, copy to blank/populated text destinations with confirmation, edit copied text and export it; original result remains unchanged.
8. Run: no selection requires explicit scope, explicit computed output list, prerequisite closure, independent unknown-price/overwrite/stale-refresh/duplicate-charge acknowledgements; blockers/expiry/version-conflict require preview refresh. Double confirm uses same key. Refresh/reopen restores active progress without creating work. Hide tab to pause polling. Inspect all counters, reasons, ordered provenance, unavailable verification, cancel-requested/in-flight disclosure and latest-input retry preview.
9. CSV: malformed/oversize file, blank/duplicate headers, existing/new typed destinations, invalid rows outside the first ten, staged corrections preserved on failed validation, expired plan and repeat confirmation. Confirmation disabled while issues/unsaved staged edits remain. Import preserves order/duplicates and appends atomically.
10. Export: filtered/visible defaults, selected/all scopes and explicit column order, pending/failed/stale/unknown warning response before acknowledgement, stored-value blob and zero-row headers-only CSV, no provider calls.
11. Usage: UTC boundaries, run filtering, provider/currency/unit grouping; unknown is not zero and estimates are not confirmed charges.
