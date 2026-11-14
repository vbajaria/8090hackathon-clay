# @leadwork/providers — server-only candidate adapters

WO-8 adapter layer + WO-7 credential cryptography primitive. No live provider verification was performed. Tests are **synthetic protocol fixtures**, not recorded vendor responses. See `../../docs/provider-evidence.md` for official-document evidence and unresolved release gates.

## Exports / parent integration

```ts
import { createGateway, capabilityCatalog, encryptCredentials, decryptCredentials } from '@leadwork/providers';
import type { Credentials, GatewayOptions, ProviderEnvelope, TaskHandle, RequestContext, ValidationResult } from '@leadwork/providers';
```

- `Credentials = { apiKey?: string; clientId?: string; clientSecret?: string }`
- `createGateway(options?: { fetch?: typeof fetch; deadlineMs?: number; allowRealRequests?: boolean })`
  - `execute(providerKey, request: ProviderRequest, credentials, context?: { signal?: AbortSignal }): Promise<ProviderEnvelope>`
  - `poll(providerKey, task: TaskHandle, credentials, context?): Promise<ProviderEnvelope>` — only Snov, using the saved task hash. It acquires an ephemeral OAuth token then calls `/result`; **never** `/start`.
  - `validate(providerKey, credentials): Promise<{ status: 'ready' | 'unvalidated' | 'invalid'; reason: string }>`
- `ProviderEnvelope = { result: NormalizedProviderResult; consumption?: { units?: { amount: string; unitKind: string }; reportedMoney?: { amount: string; currency: string } }; requestId?: string }`
- `TaskHandle = { providerKey: 'pdl' | 'hunter' | 'snov' | 'openai' | 'tomba'; taskId: string }`. Request/result types come from `@leadwork/contracts`; Tomba remains unsupported.
- `capabilityCatalog`: candidate capability contracts plus `name`, `authMechanism`, `gateReason`. All `enabledForRealRequests` values are **false**. Snov accepts only mapped name parts (including owner-confirmed parts), never inferred splitting. Hunter accepts either explicit name mode.
- `encryptCredentials(credentials, key32base64, context: string): string`
- `decryptCredentials(ciphertext, key32base64, context: string): Credentials`

Encryption uses AES-256-GCM, a random 12-byte IV, a 16-byte tag and versioned AAD. Context must identify **both workspace and connection**, preferably `JSON.stringify([workspaceId, connectionId])`. Key must be canonical standard base64 encoding of exactly 32 random bytes. Store the key version separately; rotate by decrypting with the old version and re-encrypting with the new key and the same context. Wrong key/context/tampering fail with a fixed safe error. Do not import this package into browser code or expose decrypt output outside server validation/dispatch. Parent owns authorization, storage, key-version management, revocation and connection revisions.

## Networking / result rules

Real requests default off; injected fetch is for fixtures. Explicit `allowRealRequests: true` is only a networking opt-in, **not capability certification**. Parent must gate production dispatch on verified policy, owner authorization and connection revision. Do not inject native fetch to bypass this decision.

- Fixed HTTPS hosts/paths: `api.peopledatalabs.com`, `api.hunter.io`, `api.snov.io`, `api.openai.com`. Redirects and automatic retries are disabled. No SDK dependencies.
- Default 10s deadline bounds the **whole operation**, including OAuth and reading the response; configurable 1–120000ms. Caller cancellation also aborts IO. These are local protective bounds, not vendor-certified policies.
- Response body max 1MiB; resolved request serialized size max 64KiB; AI output-token request max 16384. Oversize inputs fail safely without truncation. Parent should preflight and record input-size skips before a paid dispatch. Select model-specific verified limits before release.
- HTTP errors (including 404), authorization and rates fail; no guessed 404=no-match. Timeouts/lost network acknowledgements are unknown and stop waterfalls. Only `no_result` permits continuation.
- PDL company fields are top-level, not `data`. Selected name must be nonblank; selected website must already be HTTP(S) with a host and without credentials. Bare websites are `no_result`; no undocumented scheme qualification.
- Empty/invalid selected enrichment output is `no_result`. Provider verification labels are provenance, not deliverability guarantees. OpenAI uses `/v1/responses` with `input`, `tools: []`, `store: false`, no background/tools/action dispatch. Refusal, incomplete or empty output fails.
- No raw payloads, errors, OAuth tokens or request/query URLs are returned or logged. Reflected credentials in normalized output cause a safe failure. Snov bearer tokens are per-operation only, never serialized/persisted.
- Hunter usage is only confirmed per-request `X-Credits-Used` + `X-Credits-Unit`; OpenAI reports `usage.total_tokens`. Missing usage remains unknown (omit consumption), never zero; no prices, account-quota sums, inferred Snov credits or assumed free polling. Parent owns authoritative usage attribution/projection, not summing repeated observations.

## Validation and remaining real-provider gates

Hunter validation performs only the documented **free** `GET /v2/account`, never Finder. Other providers return `unvalidated`, with zero requests; OAuth token acquisition is **not** advertised as a nonbillable account validation method. Hunter `ready` certifies that account check only, not production capability availability.

All providers still need authorized account/plan access, sanitized actual response fixtures, pinned no-match/error/usage semantics, rate/concurrency/deadline limits, retention policy, cancellation/revocation behavior and separately authorized bounded smoke tests. Additionally: PDL website formatting/schema; Snov access restrictions, bounded polls and polling-charge/cancelled-task retrieval policy; OpenAI model access, input/output bounds and cost attribution. Validation without a verified nonbillable mechanism stays unvalidated until an explicitly authorized alternative is established. No paid samples are implicit.

## Dependencies / verification

Runtime: `@leadwork/contracts: workspace:*` (transitive Zod from contracts). Dev: `typescript: 5.9.3`, `@types/node: 22.10.2`. Node 22. No root manifest or lockfile edits belong to this package task; parent performs workspace install and builds contracts first.

```sh
pnpm --filter @leadwork/contracts build
pnpm --dir packages/providers build
pnpm --dir packages/providers typecheck
pnpm --dir packages/providers test
```
