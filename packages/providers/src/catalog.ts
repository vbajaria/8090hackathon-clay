import type { ProviderCapabilities } from '@leadwork/contracts';
export const capabilityCatalog: ReadonlyArray<ProviderCapabilities & { name: string; authMechanism: string; gateReason: string }> = [
  { providerKey: 'pdl', name: 'People Data Labs', capability: 'company', credentialShape: 'api_key', execution: 'synchronous', nameModes: [], authorizationCheck: 'unknown', authMechanism: 'X-Api-Key' },
  { providerKey: 'hunter', name: 'Hunter', capability: 'email', credentialShape: 'api_key', execution: 'synchronous', nameModes: ['full_name', 'mapped_parts'], authorizationCheck: 'nonbillable_documented', authMechanism: 'api_key query parameter; free GET /v2/account' },
  { providerKey: 'snov', name: 'Snov', capability: 'email', credentialShape: 'client_credentials', execution: 'asynchronous', nameModes: ['mapped_parts'], authorizationCheck: 'unknown', authMechanism: 'OAuth client_credentials; bearer token' },
  { providerKey: 'openai', name: 'OpenAI', capability: 'ai', credentialShape: 'api_key', execution: 'synchronous', nameModes: [], authorizationCheck: 'unknown', authMechanism: 'Bearer API key' },
].map(entry => ({ ...entry, evidence: 'documented', enabledForRealRequests: false,
  policy: { deadlineMs: null, maxConcurrent: null, requestsPerMinute: null, maxPolls: null, pollingCost: entry.providerKey === 'snov' ? 'unknown' : 'not_applicable' },
  gateReason: 'Requires authorized account, live-verified sanitized fixtures, retention and bounded dispatch policy; async polling charge policy remains unverified.',
})) as Array<ProviderCapabilities & { name: string; authMechanism: string; gateReason: string }>;
