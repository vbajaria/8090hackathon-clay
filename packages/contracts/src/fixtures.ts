// Synthetic protocol fixtures only: not live provider responses or prices.
import { apiError } from './common.js';
import { ImportPlanSchema } from './transfer.js';
import { RunPreviewSchema, RunProgressSchema } from './run.js';
import { AttemptConsumptionSchema, UsageObservationSchema } from './usage.js';
import { NormalizedProviderResultSchema, ProviderCapabilitiesSchema } from './provider.js';
import { CellConflictSchema } from './table.js';
export const fixtureId = (n: number): string => `10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
export const FIXTURE_TIME = '2026-11-14T08:00:00Z';
const noConsent = { overwritePopulated: false, refreshStale: false, unknownPrice: false, possibleDuplicateCharge: false };
const fingerprint = 'a'.repeat(64);
export const conflictFixture = CellConflictSchema.parse({
  error: apiError('version_conflict', { expectedVersion: '1', actualVersion: '2' }),
  current: { version: '2', stale: false, outcome: null, value: { type: 'text', value: 'Synthetic Company' } },
});
export const importFixture = ImportPlanSchema.parse({
  id: fixtureId(1), revision: '1', tableId: fixtureId(2), expectedTableRevision: '3', sourceFingerprint: fingerprint,
  expiresAt: '2026-11-14T09:00:00Z', sourceBytes: 128, headers: ['Name', 'Domain'],
  mappings: [{ sourceIndex: 0, destination: { kind: 'existing', columnId: fixtureId(3), valueType: 'text' } }, { sourceIndex: 1, destination: { kind: 'existing', columnId: fixtureId(4), valueType: 'text' } }],
  existingRows: 0, appendedRows: 1, existingColumns: 2, createdColumns: 0, state: 'ready', issues: [], previewRows: [['Avery Lane', 'juniper.example']],
});
export const correctionFixture = ImportPlanSchema.parse({ ...importFixture, state: 'needs_correction', issues: [{ rowIndex: 0, sourceIndex: 0, code: 'invalid_number' }], mappings: [{ sourceIndex: 0, destination: { kind: 'existing', columnId: fixtureId(3), valueType: 'number' } }] });
export const expiredImportFixture = ImportPlanSchema.parse({ ...importFixture, expiresAt: '2026-11-14T07:00:00Z' });
export const runPreviewFixture = RunPreviewSchema.parse({
  id: fixtureId(5), revision: '1', tableId: fixtureId(2), expectedTableRevision: '3', expiresAt: '2026-11-14T09:00:00Z', inputFingerprint: fingerprint,
  parentRunId: null, rowIds: [fixtureId(6), fixtureId(7)], selectedColumnIds: [fixtureId(8)], prerequisiteColumnIds: [],
  cells: { eligible: 1, reused: 0, skipped: 1 },
  providers: [
    { providerKey: 'hunter', capability: 'email', connection: { id: fixtureId(9), revision: '1' }, eligibleRows: 1, lookupStarts: 1, chargeablePolls: 0, cost: { kind: 'unknown' } },
    { providerKey: 'snov', capability: 'email', connection: { id: fixtureId(10), revision: '1' }, eligibleRows: 1, lookupStarts: 1, chargeablePolls: 3, cost: { kind: 'unknown' } },
  ],
  maximumExternalRequests: 5, requiredConsent: { ...noConsent, unknownPrice: true }, blockers: [],
});
export const retryPreviewFixture = RunPreviewSchema.parse({ ...runPreviewFixture, parentRunId: fixtureId(11), requiredConsent: { ...runPreviewFixture.requiredConsent, possibleDuplicateCharge: true } });
export const completedRunFixture = RunProgressSchema.parse({
  id: fixtureId(11), tableId: fixtureId(2), parentRunId: null, status: 'completed', total: 2, terminal: 2,
  counts: { queued: 0, running: 0, succeeded: 1, reused: 0, no_result: 0, failed: 0, skipped: 0, canceled: 0, unknown: 1 },
});
const attribution = { attributionKey: fixtureId(12), attemptId: fixtureId(13), runId: fixtureId(11), providerKey: 'snov', capability: 'email' };
export const unknownUsageFixture = UsageObservationSchema.parse({
  ...attribution, id: fixtureId(14), observedAt: FIXTURE_TIME, sourceObservationKey: 'observation:synthetic:1', sourceRevision: null,
  semantics: 'unknown', units: { kind: 'unknown' }, reportedMoney: { kind: 'unknown' }, estimatedMoney: { kind: 'unknown' },
});
export const cumulativeObservationFixtures = [1, 2].map(n => UsageObservationSchema.parse({
  ...unknownUsageFixture, id: fixtureId(14 + n), sourceObservationKey: `observation:synthetic:${n + 1}`, sourceRevision: String(n), semantics: 'cumulative', units: { kind: 'known', amount: '1', unitKind: 'credits' },
}));
export const consumptionFixture = AttemptConsumptionSchema.parse({
  ...attribution, revision: '2', units: { kind: 'known', amount: '1', unitKind: 'credits' }, reportedMoney: { kind: 'unknown' }, estimatedMoney: { kind: 'unknown' },
  latestAuthoritativeObservationKey: 'observation:synthetic:3', sourceRevision: '2',
});
export const providerResultFixtures = [
  { status: 'succeeded', providerKey: 'hunter', retrievedAt: FIXTURE_TIME, requestId: null, output: { capability: 'email', value: 'avery@juniper.example' }, verification: { providerLabel: 'unknown', source: 'hunter' } },
  { status: 'no_result', providerKey: 'hunter', capability: 'email', retrievedAt: FIXTURE_TIME, requestId: null },
  { status: 'failed', providerKey: 'hunter', reason: 'rate_limited' },
  { status: 'unknown', providerKey: 'snov', reason: 'timeout' },
  { status: 'pending', task: { providerKey: 'snov', taskId: 'synthetic-task-1' } },
].map(result => NormalizedProviderResultSchema.parse(result));
export const candidateCapabilities = [
  { providerKey: 'pdl', capability: 'company', credentialShape: 'api_key', execution: 'synchronous', nameModes: [] },
  { providerKey: 'hunter', capability: 'email', credentialShape: 'api_key', execution: 'synchronous', nameModes: ['full_name', 'mapped_parts'] },
  { providerKey: 'snov', capability: 'email', credentialShape: 'client_credentials', execution: 'asynchronous', nameModes: ['mapped_parts'] },
  { providerKey: 'openai', capability: 'ai', credentialShape: 'api_key', execution: 'synchronous', nameModes: [] },
].map(candidate => ProviderCapabilitiesSchema.parse({
  ...candidate, evidence: 'documented', authorizationCheck: candidate.providerKey === 'hunter' ? 'nonbillable_documented' : 'unknown',
  policy: { deadlineMs: null, maxConcurrent: null, requestsPerMinute: null, maxPolls: null, pollingCost: candidate.execution === 'asynchronous' ? 'unknown' : 'not_applicable' }, enabledForRealRequests: false,
}));
