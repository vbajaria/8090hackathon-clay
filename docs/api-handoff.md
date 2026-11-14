# Implementation API handoff

HTTP API is same-origin JSON under `/api`. Success returns the JSON objects below directly (not `{data:...}`); errors `{error:{code,status,message,context?},current?}`. Cookie session authentication; GET `/api/auth/session` returns `{user:null|{id,email},mode:'supabase'|'development'|'unconfigured'}`. POST `/api/auth/login` `{email}` requests a Supabase link (or explicitly labeled nonproduction local sign-in when AUTH_MODE=development); GET `/api/auth/callback?code=...` exchanges code; POST `/api/auth/logout` signs out. All mutations require matching Origin; browsers send same-origin cookies. No owner IDs supplied by client.

- GET `/api/tables` -> table metadata array `{id,name,revision,createdAt,updatedAt,rowCount,columnCount}`. POST `{name}` -> metadata.
- GET `/api/tables/:id` -> `{table,columns,rows,view,nextCursor}`; columns/rows/view match shared contracts. Query `cursor`,`limit`; server applies saved filters/sort to full scope. Default page limit 100, max250. POST `/api/tables/:id/rows` `{}` adds a blank row -> Row. DELETE `/api/tables/:id/rows` `{rowIds,confirmed:true}`; DELETE `/api/tables/:id` `{confirmed:true}`.
- PATCH `/api/tables/:id/cells` -> CellPatch body (shared contract), returns Cell. POST `/api/tables/:id/copy-draft` `{rowId,sourceColumnId,destinationColumnId,expectedVersion,overwrite:boolean}` returns saved Cell.
- POST `/api/tables/:id/columns` `{name,definition}` -> Column. PATCH `/api/tables/:id/columns/:columnId` `{name?,definition?,expectedRevision}` -> Column. DELETE same `{confirmed:true,expectedRevision}`.
- PUT `/api/tables/:id/view` -> TableView body (revision is expected current version), returns updated view.
- POST `/api/tables/:id/import/preview` `{csvText,mappings:[ImportMapping]}` -> ImportPlan plus `{sourceRows?:string[][]}`; mappings empty permitted for initial header detection. Correction POST `/api/imports/:planId/correct` `{expectedPlanRevision,headers?,mappings?,corrections?}` -> updated ImportPlan. POST `/api/imports/:planId/confirm` -> ImportConfirmRequest; returns ImportCommit.
- POST `/api/tables/:id/export` -> ExportRequest; returns CSV download; unacknowledged computed warnings return409 `{error,...warnings}`.
- GET `/api/connections` -> `{connections:ProviderConnection[],catalog:[{providerKey,name,capability,nameModes,authorizationCheck,enabledForRealRequests,gateReason?}]}`. POST `{providerKey,credentials:{apiKey? or clientId,clientSecret},acknowledgeDirectBilling:true}` -> public connection; no secret echo. POST `/api/connections/:id/validate` `{}`; DELETE `/api/connections/:id` `{}` disconnects. Production validation never performs automatic paid sample. Real provider policy gates remain explicit.
- POST `/api/tables/:id/ai-preview` `{columnId,rowId}` -> `{resolvedInstructions,missingColumnIds}` without paid calls.
- POST `/api/runs/preview` -> RunPreviewRequest -> RunPreview plus optional `{skippedDetails:[{rowId,columnId,reason}],replacements:number}`. Prerequisite closure inferred from stable IDs. POST `/api/runs/confirm` -> RunConfirmRequest -> `{id,tableId,status}`.
- GET `/api/runs?tableId=...` -> RunProgress[] with `createdAt,completedAt` additional read metadata; GET `/api/runs/:id` -> `{progress,results:RunResult[],attempts:[sanitized ordered attempt summaries]}`. POST `/api/runs/:id/cancel` `{}`. POST `/api/runs/:id/retry-preview` `{includeOutcomes:['failed' default],targets?:[{rowId,columnId}]}` -> new RunPreview based on latest saved inputs/config.
- GET `/api/usage?month=YYYY-MM&runId=...` -> UsageSummary.

Domain functions in @leadwork/engine (independent from persistence): parseCsv(text), exportCsv(headers, typedRows), parseEditableValue(type,text), validateColumnConfiguration(columns), columnDependencies(column), topologicalColumns(columns, selectedIds), evaluateFormula(expression, valuesByColumnId), resolveInstructions(template, valuesByColumnId). Functions may throw a safe DomainError with code, not raw values. A separate @leadwork/providers package owns normalized real adapter IO; parent integrates into durable worker.

Client must show setup gates, not simulate production capabilities. No localStorage as source of business data. No automatic run after edit/import. No provider calls on page load. UI recovery polling reads only.

## Final integrated API notes

- `RunPreviewRequest.replacePopulated` is optional, default false. Fresh selected
  outputs reuse; populated nonfresh selected outputs skip unless replacement
  preparation is explicitly requested. Confirmation independently checks overwrite
  consent. Manual retries prepare replacements with latest saved inputs/settings.
- `GET /api/runs/:id` accepts `limit` (default 50, maximum 250) and an opaque
  server cursor. `nextCursor` covers result/provenance pages; progress totals
  aggregate the full run, not only the page. Never locally slice a full download.
- Existing workspace, progress and usage reads do not update owner rows or hold
  nested database transactions. Cancellation, authorization and polling are durable.
- Step input fingerprints include actual direct values, transitive definitions,
  and editable source versions. JSONB object order is canonicalized. Historical
  values stay immutable and are marked stale when current inputs differ. Legacy
  stored results without fingerprints are conservatively stale, not certified fresh.
- Formula recalculation rejects unavailable/stale computed inputs and performs
  no external IO. Publication loads only the affected row and updates dependent
  local formulas; frozen same-run values remain the downstream execution source.
