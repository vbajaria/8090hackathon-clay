import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../dist/index.js';
import * as F from '../dist/fixtures.js';
const copy = value => structuredClone(value);
const now = new Date(F.FIXTURE_TIME);
const id = F.fixtureId;
const noConsent = { overwritePopulated: false, refreshStale: false, unknownPrice: false, possibleDuplicateCharge: false };
const confirm = preview => ({ previewId: preview.id, expectedPreviewRevision: preview.revision, idempotencyKey: 'confirm:fixture:1', consent: { ...noConsent, unknownPrice: true } });
const importConfirm = plan => ({ planId: plan.id, expectedPlanRevision: plan.revision, idempotencyKey: 'import:fixture:1' });
const reject = (schema, value) => assert.equal(schema.safeParse(value).success, false);

test('all exported fixtures validate at runtime', () => {
  assert.equal(F.providerResultFixtures.length, 5);
  assert.equal(F.candidateCapabilities.length, 4);
  assert.equal(C.ImportPlanSchema.parse(F.importFixture).state, 'ready');
  assert.equal(C.RunPreviewSchema.parse(F.runPreviewFixture).maximumExternalRequests, 5);
});
test('decimal strings preserve precision and signed base-ten values', () => {
  for (const value of ['+12.5', '-0.01', '9007199254740993.0000001']) assert.equal(C.CellValueSchema.parse({ type: 'number', value }).value, value);
  for (const value of ['1e3', '1,000', '$2', 'NaN', '', 42]) reject(C.CellValueSchema, { type: 'number', value });
});
test('booleans are typed, blanks explicit, text Unicode preserved', () => {
  assert.deepEqual(C.CellValueSchema.parse({ type: 'text', value: '你好 · Avery' }), { type: 'text', value: '你好 · Avery' });
  for (const type of ['text', 'number', 'date', 'boolean']) assert.equal(C.CellValueSchema.parse({ type, value: null }).value, null);
  reject(C.CellValueSchema, { type: 'boolean', value: 'true' });
});
test('date values reject impossible dates and noncanonical formats', () => {
  assert.equal(C.CellValueSchema.parse({ type: 'date', value: '2024-02-29' }).value, '2024-02-29');
  for (const value of ['2026-02-29', '2026-02-30', '14/11/2026', '2026-1-1', '0000-01-01']) reject(C.CellValueSchema, { type: 'date', value });
});
test('revisions are JSON-safe bigint strings', () => {
  assert.equal(C.RevisionSchema.parse('9007199254740993'), '9007199254740993');
  for (const value of [1, '-1', '1.1', '01']) reject(C.RevisionSchema, value);
});
test('safe errors forbid raw provider details and arbitrary context', () => {
  const error = C.apiError('not_found');
  assert.equal(error.status, 404);
  reject(C.ApiErrorSchema, { ...error, message: 'raw api_key=secret' });
  reject(C.ApiErrorSchema, { ...error, context: { stack: 'raw stack' } });
  reject(C.ApiErrorSchema, { ...error, status: 403 });
});
test('mutations reject caller-supplied ownership', () => {
  reject(C.CreateTableRequestSchema, { name: 'Leads', ownerId: id(1) });
  reject(C.CellPatchSchema, { rowId: id(1), columnId: id(2), expectedVersion: '1', value: { type: 'text', value: 'Synthetic' }, workspaceId: id(3) });
});
test('cell mutations require stable IDs and matching editable type', () => {
  const column = { id: id(2), revision: '1', name: 'Name', definition: { kind: 'editable', valueType: 'text' } };
  const patch = { rowId: id(1), columnId: id(2), expectedVersion: '1', value: { type: 'text', value: 'Avery Lane' } };
  assert.equal(C.checkCellPatch(C.ColumnSchema.parse(column), C.CellPatchSchema.parse(patch)), null);
  assert.equal(C.checkCellPatch(column, { ...patch, value: { type: 'number', value: '1' } }).code, 'invalid_value');
  assert.equal(C.checkCellPatch({ ...column, definition: { kind: 'company', connection: { id: id(3), revision: '1' }, domainInput: { kind: 'column', columnId: id(4) }, output: 'name' } }, patch).code, 'invalid_value');
  reject(C.CellPatchSchema, { ...patch, expectedVersion: undefined });
});
test('conflicts expose current value and version, not raw errors', () => {
  assert.equal(F.conflictFixture.current.version, '2');
  assert.equal(F.conflictFixture.error.context.expectedVersion, '1');
});
test('filters are allowlisted and ordered comparisons typed', () => {
  assert.equal(C.FilterSchema.parse({ operator: 'contains', columnId: id(1), value: "'; DROP TABLE leads; --" }).operator, 'contains');
  reject(C.FilterSchema, { operator: 'raw_sql', columnId: id(1), value: '1=1' });
  reject(C.FilterSchema, { operator: 'greater_than', columnId: id(1), value: { type: 'text', value: 'abc' } });
});
test('row scopes and page requests are explicit and bounded', () => {
  reject(C.RowScopeSchema, { kind: 'selected', rowIds: [] });
  reject(C.RowScopeSchema, { kind: 'selected', rowIds: [id(1), id(1)] });
  assert.equal(C.PageRequestSchema.parse({}).limit, 100);
  reject(C.PageRequestSchema, { limit: 251 });
});
test('table capacities enforce exact upper boundaries', () => {
  const table = { id: id(1), name: 'Synthetic', revision: '1', createdAt: F.FIXTURE_TIME, rowCount: 5000, columnCount: 50 };
  C.TableSchema.parse(table);
  reject(C.TableSchema, { ...table, rowCount: 5001 });
  reject(C.TableSchema, { ...table, columnCount: 51 });
});
test('CSV mappings cannot target computed types or duplicate fields', () => {
  reject(C.ImportMappingSchema, { sourceIndex: 0, destination: { kind: 'new', name: 'AI', valueType: 'ai' } });
  reject(C.ImportPreviewRequestSchema, { tableId: id(1), uploadId: id(2), expectedTableRevision: '1', mappings: [F.importFixture.mappings[0], F.importFixture.mappings[0]] });
});
test('import plans reflect full-file validity and shape', () => {
  reject(C.ImportPlanSchema, { ...F.importFixture, state: 'ready', issues: F.correctionFixture.issues });
  reject(C.ImportPlanSchema, { ...F.importFixture, mappings: [{ sourceIndex: 3, destination: F.importFixture.mappings[0].destination }] });
  reject(C.ImportPlanSchema, { ...F.importFixture, previewRows: [['wrong width']] });
  reject(C.ImportPlanSchema, { ...F.importFixture, headers: ['Name', ' name '] });
});
test('import capacities include existing data and source byte ceiling', () => {
  C.ImportPlanSchema.parse({ ...F.importFixture, existingRows: 4999, sourceBytes: 10000000 });
  reject(C.ImportPlanSchema, { ...F.importFixture, existingRows: 5000 });
  reject(C.ImportPlanSchema, { ...F.importFixture, sourceBytes: 10000001 });
  reject(C.ImportPlanSchema, { ...F.importFixture, createdColumns: 1 });
});
test('import confirmation handles correction, expiry and conflicts', () => {
  assert.equal(C.checkImportConfirmation(F.importFixture, importConfirm(F.importFixture), now), null);
  assert.equal(C.checkImportConfirmation(F.correctionFixture, importConfirm(F.correctionFixture), now).code, 'invalid_mapping');
  assert.equal(C.checkImportConfirmation(F.expiredImportFixture, importConfirm(F.expiredImportFixture), now).code, 'expired_plan');
  assert.equal(C.checkImportConfirmation(F.importFixture, { ...importConfirm(F.importFixture), expectedPlanRevision: '2' }, now).code, 'version_conflict');
  assert.equal(C.checkImportConfirmation(F.importFixture, importConfirm(F.importFixture), new Date('invalid')).code, 'invalid_value');
});
test('export requires columns and spreadsheet-safe defaults', () => {
  const request = { tableId: id(1), rowScope: { kind: 'all' }, columnIds: [id(2)], expectedViewRevision: '1', acknowledgeStoredOutputWarnings: false, neutralizeSpreadsheetText: true };
  C.ExportRequestSchema.parse(request);
  reject(C.ExportRequestSchema, { ...request, columnIds: [] });
  reject(C.ExportRequestSchema, { ...request, neutralizeSpreadsheetText: false });
});
test('AI instruction templates enforce character limit', () => {
  const definition = { kind: 'ai', connection: { id: id(1), revision: '1' }, model: 'pending-model-selection', instructionTemplate: 'a'.repeat(2000), referencedColumnIds: [] };
  C.ColumnDefinitionSchema.parse(definition);
  reject(C.ColumnDefinitionSchema, { ...definition, instructionTemplate: 'a'.repeat(2001) });
  reject(C.ColumnDefinitionSchema, { ...definition, instructionTemplate: '   ' });
});
test('email waterfalls allow owner-selected subsets and reject duplicate providers', () => {
  const mapping = { mode: 'mapped_parts', givenNameInput: { kind: 'column', columnId: id(1) }, familyNameInput: { kind: 'column', columnId: id(2) }, source: 'owner_mapped' };
  const provider = key => ({ providerKey: key, connection: { id: id(3), revision: '1' }, nameMapping: mapping });
  const config = { kind: 'email', domainInput: { kind: 'column', columnId: id(4) }, providers: [provider('hunter'), { ...provider('snov'), connection: { id: id(5), revision: '1' } }] };
  C.ColumnDefinitionSchema.parse(config);
  C.ColumnDefinitionSchema.parse({ ...config, providers: [provider('hunter')] });
  reject(C.ColumnDefinitionSchema, { ...config, providers: [] });
  reject(C.ColumnDefinitionSchema, { ...config, providers: [provider('hunter'), provider('hunter')] });
});
test('preview includes full waterfall and separately chargeable polling bounds', () => {
  assert.equal(F.runPreviewFixture.maximumExternalRequests, 5);
  reject(C.RunPreviewSchema, { ...F.runPreviewFixture, maximumExternalRequests: 2 });
  reject(C.RunPreviewSchema, { ...F.runPreviewFixture, cells: { eligible: 2, skipped: 1, reused: 0 } });
  reject(C.RunPreviewSchema, { ...F.runPreviewFixture, prerequisiteColumnIds: F.runPreviewFixture.selectedColumnIds });
});
test('unknown pricing cannot be represented as zero or bypass consent', () => {
  reject(C.CostEstimateSchema, { kind: 'unknown', maximum: 0 });
  reject(C.RunPreviewSchema, { ...F.runPreviewFixture, requiredConsent: noConsent });
  assert.equal(C.checkRunConfirmation(F.runPreviewFixture, { ...confirm(F.runPreviewFixture), consent: noConsent }, now).code, 'consent_required');
});
test('unbounded provider polling blocks confirmation', () => {
  const preview = copy(F.runPreviewFixture); preview.providers[1].chargeablePolls = null;
  reject(C.RunPreviewSchema, preview);
  preview.maximumExternalRequests = null; preview.blockers = ['unverified_provider_policy'];
  C.RunPreviewSchema.parse(preview);
  assert.equal(C.checkRunConfirmation(preview, confirm(preview), now).code, 'provider_not_ready');
});
test('run confirmation rejects expired and changed previews', () => {
  assert.equal(C.checkRunConfirmation(F.runPreviewFixture, confirm(F.runPreviewFixture), now), null);
  assert.equal(C.checkRunConfirmation({ ...F.runPreviewFixture, expiresAt: F.FIXTURE_TIME }, confirm(F.runPreviewFixture), now).code, 'expired_plan');
  assert.equal(C.checkRunConfirmation(F.runPreviewFixture, { ...confirm(F.runPreviewFixture), expectedPreviewRevision: '2' }, now).code, 'version_conflict');
});
test('overwrite and stale-refresh consent are independent', () => {
  const preview = C.RunPreviewSchema.parse({ ...F.runPreviewFixture, requiredConsent: { ...F.runPreviewFixture.requiredConsent, overwritePopulated: true, refreshStale: true } });
  assert.equal(C.checkRunConfirmation(preview, confirm(preview), now).code, 'consent_required');
  assert.equal(C.checkRunConfirmation(preview, { ...confirm(preview), consent: { ...confirm(preview).consent, overwritePopulated: true, refreshStale: true } }, now), null);
});
test('unknown-outcome manual retries require possible-charge acknowledgement', () => {
  assert.equal(C.checkRunConfirmation(F.retryPreviewFixture, confirm(F.retryPreviewFixture), now).code, 'consent_required');
  assert.equal(C.checkRunConfirmation(F.retryPreviewFixture, { ...confirm(F.retryPreviewFixture), consent: { ...confirm(F.retryPreviewFixture).consent, possibleDuplicateCharge: true } }, now), null);
  const request = C.RetryPreviewRequestSchema.parse({ parentRunId: id(1), targets: [{ rowId: id(2), columnId: id(3) }] });
  assert.deepEqual(request.includeOutcomes, ['failed']);
  reject(C.RetryPreviewRequestSchema, { ...request, includeOutcomes: ['succeeded'] });
});
test('mixed terminal outcomes still permit completed progress', () => {
  C.RunProgressSchema.parse(F.completedRunFixture);
  reject(C.RunProgressSchema, { ...F.completedRunFixture, terminal: 1 });
  reject(C.RunProgressSchema, { ...F.completedRunFixture, counts: { ...F.completedRunFixture.counts, queued: 1 } });
});
test('terminal run state rejects queued work even with otherwise consistent counters', () => {
  reject(C.RunProgressSchema, { ...F.completedRunFixture, total: 3, terminal: 2, counts: { ...F.completedRunFixture.counts, queued: 1 } });
});
test('snapshots require source versions and separate reusable outputs', () => {
  C.RunRowSnapshotSchema.parse({ rowId: id(1), baseInputs: { [id(2)]: { type: 'text', value: 'Avery' } }, reusedOutputs: {}, sourceVersions: { [id(2)]: '2' } });
  reject(C.RunRowSnapshotSchema, { rowId: id(1), baseInputs: { [id(2)]: { type: 'text', value: 'Avery' } }, reusedOutputs: {}, sourceVersions: {} });
});
test('names are explicitly full or owner-mapped; no silent splitting', () => {
  const hunter = F.candidateCapabilities.find(c => c.providerKey === 'hunter');
  const snov = F.candidateCapabilities.find(c => c.providerKey === 'snov');
  const name = C.PersonNameSchema.parse({ mode: 'full_name', fullName: 'María de la Cruz' });
  assert.equal(C.supportsName(hunter, name), true); assert.equal(C.supportsName(snov, name), false);
  reject(C.PersonNameSchema, { mode: 'mapped_parts', givenName: 'María', familyName: 'de la Cruz' });
});
test('domains are lookup values, not arbitrary fetch URLs', () => {
  C.DomainSchema.parse('juniper.example');
  for (const domain of ['https://juniper.example', 'juniper.example/path', '-bad.example', 'a..example']) reject(C.DomainSchema, domain);
});
test('AI requests disallow tools and provider response storage', () => {
  const request = { capability: 'ai', model: 'pending-model-selection', resolvedInstructions: 'Personalize from table data.', maxOutputTokens: 300, tools: [], store: false };
  C.ProviderRequestSchema.parse(request);
  reject(C.ProviderRequestSchema, { ...request, tools: [{ type: 'web_search' }] });
  reject(C.ProviderRequestSchema, { ...request, store: true });
});
test('only confirmed no-result can advance the email waterfall', () => {
  for (const result of F.providerResultFixtures) assert.equal(C.mayAdvanceWaterfall(result), result.status === 'no_result');
  reject(C.NormalizedProviderResultSchema, { status: 'no_result', providerKey: 'openai', capability: 'ai', retrievedAt: F.FIXTURE_TIME, requestId: null });
});
test('company website output must be usable HTTP(S) and credential-free', () => {
  C.SelectedProviderOutputSchema.parse({ capability: 'company', output: 'website', value: 'https://juniper.example' });
  for (const value of ['javascript:alert(1)', 'ftp://juniper.example', 'https://key:secret@juniper.example']) reject(C.SelectedProviderOutputSchema, { capability: 'company', output: 'website', value });
  reject(C.SelectedProviderOutputSchema, { capability: 'ai', value: '   ' });
});
test('async retrieval requires a persisted task identity', () => {
  const attempt = { id: id(1), executionStepId: id(2), connection: { id: id(3), revision: '1' }, waterfallPosition: 1, dispatchState: 'awaiting_result', requestId: null, task: null, dispatchedAt: F.FIXTURE_TIME, deadlineAt: '2026-11-14T08:01:00Z' };
  reject(C.ProviderAttemptSchema, attempt);
  C.ProviderAttemptSchema.parse({ ...attempt, task: { providerKey: 'snov', taskId: 'synthetic-task' } });
});
test('public connections cannot contain credentials or claim unvalidated readiness', () => {
  const connection = { id: id(1), revision: '1', providerKey: 'hunter', status: 'unvalidated', capabilities: ['email'], validatedAt: null, validationEvidenceId: null };
  C.ProviderConnectionSchema.parse(connection);
  reject(C.ProviderConnectionSchema, { ...connection, apiKey: 'secret' });
  reject(C.ProviderConnectionSchema, { ...connection, status: 'ready' });
});
test('documented candidates remain disabled without live evidence and bounded policies', () => {
  for (const capability of F.candidateCapabilities) {
    assert.equal(capability.enabledForRealRequests, false);
    reject(C.ProviderCapabilitiesSchema, { ...capability, enabledForRealRequests: true });
  }
});
test('usage distinguishes unknown, confirmed zero and estimates', () => {
  assert.deepEqual(F.unknownUsageFixture.reportedMoney, { kind: 'unknown' });
  C.MoneySchema.parse({ kind: 'known', amount: '0', currency: 'USD' });
  reject(C.MoneySchema, { kind: 'unknown', amount: '0' });
  reject(C.UsageObservationSchema, { ...F.unknownUsageFixture, semantics: 'estimate', reportedMoney: { kind: 'known', amount: '1', currency: 'USD' } });
});
test('cumulative observation history stays separate from one authoritative total', () => {
  assert.equal(F.cumulativeObservationFixtures.length, 2);
  assert.equal(F.consumptionFixture.units.amount, '1');
  assert.equal(F.consumptionFixture.latestAuthoritativeObservationKey, F.cumulativeObservationFixtures[1].sourceObservationKey);
  reject(C.AttemptConsumptionSchema, { ...F.consumptionFixture, latestAuthoritativeObservationKey: null });
});
test('usage DTOs reject lead-bearing fields and raw response payloads', () => {
  reject(C.UsageObservationSchema, { ...F.unknownUsageFixture, personName: 'Avery Lane' });
  reject(C.AttemptConsumptionSchema, { ...F.consumptionFixture, rawProviderResponse: {} });
  C.AttemptConsumptionSchema.parse({ ...F.consumptionFixture, attemptId: null, runId: null });
});
test('usage query requires valid month and preserves separate currency/unit dimensions', () => {
  reject(C.UsageQuerySchema, { month: '2026-13' });
  C.MoneySchema.parse({ kind: 'known', amount: '0.01', currency: 'EUR' });
  C.UnitsSchema.parse({ kind: 'known', amount: '1', unitKind: 'credits' });
  reject(C.MoneySchema, { kind: 'known', amount: 0.01, currency: 'USD' });
});

test('invalid website strings produce validation issues rather than throwing', () => {
  for (const value of ['', '   ', 'not a URL', 'https://[']) {
    let result;
    assert.doesNotThrow(() => { result = C.SelectedProviderOutputSchema.safeParse({ capability: 'company', output: 'website', value }); });
    assert.equal(result.success, false);
  }
});

test('mandatory enrichment inputs support explicit fixed values or column references', () => {
  C.ColumnDefinitionSchema.parse({ kind: 'company', connection: { id: id(1), revision: '1' }, domainInput: { kind: 'fixed', value: 'juniper.example' }, output: 'name' });
  C.EmailNameMappingSchema.parse({ mode: 'full_name', fullNameInput: { kind: 'fixed', value: 'Avery Lane' } });
  reject(C.TextInputMappingSchema, { kind: 'fixed', value: '   ' });
  reject(C.TextInputMappingSchema, { kind: 'column', columnId: 'missing' });
});
test('email usability follows the specified format, without invented deliverability checks', () => {
  for (const value of ['avery@juniper.example', 'a@b', '名@company.example']) C.UsableEmailSchema.parse(value);
  for (const value of ['@domain', 'name@', 'a@@b', 'a b@domain', ' a@b']) reject(C.UsableEmailSchema, value);
});
