import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, capabilityCatalog } from '../dist/index.js';
import { NormalizedProviderResultSchema, ProviderCapabilitiesSchema } from '@leadwork/contracts';
const credentials = { apiKey: 'API_SECRET_123456', clientId: 'CLIENT_123456', clientSecret: 'CLIENT_SECRET_123456' };
const company = { capability: 'company', domain: 'example.com', output: 'name' };
const email = { capability: 'email', domain: 'example.com', personName: { mode: 'mapped_parts', givenName: 'Ada', familyName: 'Lovelace', source: 'owner_mapped' } };
const ai = { capability: 'ai', model: 'owner-selected-model', resolvedInstructions: 'Write a draft for Ada at Example', maxOutputTokens: 200, tools: [], store: false };
const task = { providerKey: 'snov', taskId: 'task_123' };
const oauth = { access_token: 'OAUTH_TOKEN_DO_NOT_RETURN', token_type: 'Bearer' };
function fixture(...responses) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input); calls.push({ url, init });
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    assert.ok(['api.peopledatalabs.com', 'api.hunter.io', 'api.snov.io', 'api.openai.com'].includes(url.hostname));
    assert.equal(url.protocol, 'https:');
    assert.ok(responses.length, 'Unexpected extra request (retry or new task)');
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(input, init);
    const transport = Object.hasOwn(next, 'body');
    return new Response(JSON.stringify(transport ? next.body : next), { status: transport ? next.status ?? 200 : 200, headers: { 'content-type': 'application/json', ...(next.headers ?? {}) } });
  };
  return { fetch, calls };
}
function normalized(envelope) {
  assert.ok(NormalizedProviderResultSchema.safeParse(envelope.result).success, JSON.stringify(envelope));
  for (const value of [...Object.values(credentials), oauth.access_token]) assert.equal(JSON.stringify(envelope).includes(value), false);
  assert.equal(JSON.stringify(envelope).includes('?api_key='), false);
  return envelope.result;
}

test('catalog is documented but real-disabled, with explicit name/auth/policy gates', () => {
  assert.deepEqual(capabilityCatalog.map(c => c.providerKey), ['pdl', 'hunter', 'snov', 'openai']);
  for (const c of capabilityCatalog) {
    const { name, authMechanism, gateReason, ...contract } = c;
    assert.ok(name && authMechanism && gateReason);
    assert.ok(ProviderCapabilitiesSchema.safeParse(contract).success);
    assert.equal(c.enabledForRealRequests, false);
  }
  assert.deepEqual(capabilityCatalog.find(c => c.providerKey === 'snov').nameModes, ['mapped_parts']);
});
test('default gateway never performs live execution or validation', async () => {
  const gateway = createGateway();
  assert.equal((await gateway.execute('hunter', email, credentials)).result.status, 'failed');
  assert.equal((await gateway.validate('hunter', credentials)).status, 'unvalidated');
});
test('PDL uses top-level name and website and X-Api-Key', async () => {
  const f = fixture({ status: 200, name: 'Example', data: { name: 'WRONG_ENVELOPE' } }, { status: 200, website: 'https://example.com' });
  const gateway = createGateway({ fetch: f.fetch });
  const first = normalized(await gateway.execute('pdl', company, credentials));
  assert.equal(first.output.value, 'Example');
  assert.equal(f.calls[0].url.pathname, '/v5/company/enrich');
  assert.equal(f.calls[0].url.searchParams.get('website'), 'example.com');
  assert.equal(f.calls[0].init.headers['X-Api-Key'], credentials.apiKey);
  const second = normalized(await gateway.execute('pdl', { ...company, output: 'website' }, credentials));
  assert.equal(second.output.value, 'https://example.com');
});
for (const value of ['', '  ', null, 'example.com', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://']) {
  test(`PDL unusable website ${JSON.stringify(value)} is no_result, without scheme invention`, async () => {
    const f = fixture({ website: value });
    assert.equal(normalized(await createGateway({ fetch: f.fetch }).execute('pdl', { ...company, output: 'website' }, credentials)).status, 'no_result');
  });
}
test('PDL blank name / incorrect nested profile do not succeed; 404 is failure not presumed no-match', async () => {
  for (const body of [{ name: ' ' }, { data: { name: 'Example' } }]) {
    assert.equal((await createGateway({ fetch: fixture(body).fetch }).execute('pdl', company, credentials)).result.status, 'no_result');
  }
  assert.equal((await createGateway({ fetch: fixture({ status: 404, body: {} }).fetch }).execute('pdl', company, credentials)).result.status, 'failed');
});
test('Hunter full name and mapped parts use explicit fields and preserve reported verification/usage', async () => {
  for (const name of [email.personName, { mode: 'full_name', fullName: 'Ada Lovelace' }]) {
    const f = fixture({ body: { data: { email: 'ada@example.com', verification: { status: 'accept_all' } } }, headers: { 'x-credits-used': '1', 'x-credits-unit': 'email', 'x-request-id': 'request_123' } });
    const envelope = await createGateway({ fetch: f.fetch }).execute('hunter', { ...email, personName: name }, credentials);
    const result = normalized(envelope);
    assert.equal(result.output.value, 'ada@example.com'); assert.equal(result.verification.providerLabel, 'accept_all');
    assert.deepEqual(envelope.consumption, { units: { amount: '1', unitKind: 'email' } });
    assert.equal(envelope.requestId, 'request_123'); assert.equal(envelope.consumption.reportedMoney, undefined);
    const params = f.calls[0].url.searchParams;
    assert.equal(params.get('domain'), 'example.com');
    assert.equal(params.get('api_key'), credentials.apiKey);
    if (name.mode === 'full_name') { assert.equal(params.get('full_name'), name.fullName); assert.equal(params.has('first_name'), false); }
    else { assert.equal(params.get('first_name'), 'Ada'); assert.equal(params.get('last_name'), 'Lovelace'); assert.equal(params.has('full_name'), false); }
  }
});
for (const value of [null, '', 'bad', 'a@@example.com', '@example.com', 'a@', 'a b@example.com']) {
  test(`Hunter invalid selected email ${JSON.stringify(value)} is no_result`, async () => {
    const envelope = await createGateway({ fetch: fixture({ data: { email: value } }).fetch }).execute('hunter', email, credentials);
    assert.equal(normalized(envelope).status, 'no_result'); assert.equal(envelope.consumption, undefined);
  });
}
test('absence of verification and consumption stays unknown, not inferred', async () => {
  const envelope = await createGateway({ fetch: fixture({ data: { email: 'ada@example.com' } }).fetch }).execute('hunter', email, credentials);
  assert.equal(normalized(envelope).verification, null); assert.equal(envelope.consumption, undefined);
});
test('Hunter validation uses only the documented free /account endpoint', async () => {
  const f = fixture({ data: { email: 'owner@example.com' } });
  const gateway = createGateway({ fetch: f.fetch });
  assert.equal((await gateway.validate('hunter', credentials)).status, 'ready');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url.pathname, '/v2/account');
  for (const key of ['pdl', 'snov', 'openai']) assert.equal((await gateway.validate(key, credentials)).status, 'unvalidated');
  assert.equal(f.calls.length, 1);
  assert.equal((await createGateway({ fetch: fixture({ status: 401, body: {} }).fetch }).validate('hunter', credentials)).status, 'invalid');
  assert.equal((await createGateway({ fetch: fixture({}).fetch }).validate('hunter', credentials)).status, 'unvalidated');
});
test('Snov OAuth starts exactly once; subsequent polls retrieve persisted task with ephemeral bearer', async () => {
  const f = fixture(oauth, { data: { task_hash: task.taskId } }, oauth, { status: 'in_progress' }, oauth, { status: 'completed', data: [{ result: [{ email: 'ada@example.com', smtp_status: 'valid' }] }] });
  const gateway = createGateway({ fetch: f.fetch });
  const start = normalized(await gateway.execute('snov', email, credentials)); assert.deepEqual(start, { status: 'pending', task });
  const pending = normalized(await gateway.poll('snov', JSON.parse(JSON.stringify(start.task)), credentials)); assert.equal(pending.status, 'pending');
  const envelope = await gateway.poll('snov', pending.task, credentials); const result = normalized(envelope);
  assert.equal(result.output.value, 'ada@example.com'); assert.equal(result.verification.providerLabel, 'valid');
  assert.equal(envelope.consumption, undefined);
  assert.equal(f.calls.filter(c => c.url.pathname.endsWith('/start')).length, 1);
  assert.equal(f.calls.filter(c => c.url.pathname.endsWith('/result')).length, 2);
  for (const call of f.calls.filter(c => c.url.pathname.endsWith('/result'))) assert.equal(call.url.searchParams.get('task_hash'), task.taskId);
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { rows: [{ first_name: 'Ada', last_name: 'Lovelace', domain: 'example.com' }] });
  assert.equal(f.calls[1].init.headers.Authorization, `Bearer ${oauth.access_token}`);
  const form = f.calls[0].init.body;
  assert.equal(form.get('grant_type'), 'client_credentials'); assert.equal(form.get('client_id'), credentials.clientId); assert.equal(form.get('client_secret'), credentials.clientSecret);
});
test('Snov rejects full name without decomposition and mismatched/unsafe tasks before fetch', async () => {
  const f = fixture(); const gateway = createGateway({ fetch: f.fetch });
  assert.equal((await gateway.execute('snov', { ...email, personName: { mode: 'full_name', fullName: 'Ada Lovelace' } }, credentials)).result.status, 'failed');
  assert.equal((await gateway.poll('snov', { ...task, providerKey: 'hunter' }, credentials)).result.status, 'failed');
  assert.equal((await gateway.poll('snov', { ...task, taskId: 'https://evil.test/task' }, credentials)).result.status, 'failed');
  assert.equal(f.calls.length, 0);
});
for (const body of [{ status: 'completed', data: [] }, { status: 'completed', data: [{ result: [] }] }, { status: 'completed', data: [{ result: [{ email: 'bad' }] }] }]) {
  test('Snov completed empty/invalid output is no_result and missing charge observations stay unknown', async () => {
    const f = fixture(oauth, body); const envelope = await createGateway({ fetch: f.fetch }).poll('snov', task, credentials);
    assert.equal(normalized(envelope).status, 'no_result'); assert.equal(envelope.consumption, undefined);
  });
}
test('Snov credit failure never advances waterfall', async () => {
  const envelope = await createGateway({ fetch: fixture(oauth, { status: 'not_enough_credits' }).fetch }).poll('snov', task, credentials);
  assert.equal(normalized(envelope).status, 'failed');
});
test('OpenAI sends Responses input, tools=[], store=false and reads message output_text', async () => {
  const f = fixture({ id: 'resp_123', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello Ada' }] }], usage: { total_tokens: 42 } });
  const envelope = await createGateway({ fetch: f.fetch }).execute('openai', ai, credentials);
  assert.equal(normalized(envelope).output.value, 'Hello Ada');
  assert.deepEqual(envelope.consumption, { units: { amount: '42', unitKind: 'tokens' } });
  assert.equal(f.calls[0].url.pathname, '/v1/responses');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { model: ai.model, input: ai.resolvedInstructions, max_output_tokens: 200, tools: [], store: false });
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${credentials.apiKey}`);
});
for (const [body, reason] of [[{ status: 'completed', output: [] }, 'invalid_output'], [{ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '  ' }] }] }, 'invalid_output'], [{ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] }, 'refused'], [{ status: 'incomplete', output: [] }, 'invalid_output']]) {
  test(`OpenAI empty/refused/incomplete is failed/${reason}`, async () => {
    assert.equal(normalized(await createGateway({ fetch: fixture(body).fetch }).execute('openai', ai, credentials)).reason, reason);
  });
}
for (const [key, request] of [['pdl', company], ['hunter', email], ['snov', email], ['openai', ai]]) {
  for (const [status, reason] of [[401, 'invalid_authorization'], [403, 'invalid_authorization'], [429, 'rate_limited'], [500, 'provider_error'], [302, 'provider_error']]) {
    test(`${key} HTTP ${status} fails without automatic retries or secret errors`, async () => {
      const f = fixture({ status, body: { error: credentials.apiKey, url: `https://api.hunter.io/?api_key=${credentials.apiKey}` } });
      const result = normalized(await createGateway({ fetch: f.fetch }).execute(key, request, credentials));
      assert.equal(result.status, 'failed'); assert.equal(result.reason, reason); assert.equal(f.calls.length, 1);
    });
  }
  test(`${key} deadline bounds even an injected fetch ignoring AbortSignal`, async () => {
    let signal;
    const fetch = async (_, init) => { signal = init.signal; return new Promise(() => {}); };
    const result = normalized(await createGateway({ fetch, deadlineMs: 5 }).execute(key, request, credentials));
    assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'timeout'); assert.equal(signal.aborted, true);
  });
}
test('caller cancellation interrupts pending work and pre-abort never dispatches', async () => {
  const controller = new AbortController(); let calls = 0;
  const gateway = createGateway({ fetch: async () => { calls++; return new Promise(() => {}); } });
  const promise = gateway.execute('hunter', email, credentials, { signal: controller.signal }); controller.abort();
  assert.equal((await promise).result.status, 'unknown'); assert.equal(calls, 1);
  await gateway.execute('hunter', email, credentials, { signal: controller.signal }); assert.equal(calls, 1);
});
test('network acknowledgement lost and raw secret errors are not exposed', async () => {
  const envelope = await createGateway({ fetch: fixture(new Error(`?api_key=${credentials.apiKey}`)).fetch }).execute('hunter', email, credentials);
  const result = normalized(envelope); assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'lost_acknowledgement');
});
test('malformed and oversized responses fail safely', async () => {
  for (const fetch of [async () => new Response('not-json'), async () => new Response(JSON.stringify({ name: 'x'.repeat(1_048_577) }))]) {
    assert.equal(normalized(await createGateway({ fetch }).execute('pdl', company, credentials)).status, 'failed');
  }
});
test('bounded response reading times out as uncertain', async () => {
  const fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }));
  assert.equal((await createGateway({ fetch, deadlineMs: 5 }).execute('pdl', company, credentials)).result.status, 'unknown');
});
test('invalid/missing/oversize inputs and unsupported providers never dispatch', async () => {
  const f = fixture(); const gateway = createGateway({ fetch: f.fetch });
  for (const req of [{ ...company, domain: 'https://example.com' }, { ...ai, resolvedInstructions: 'x'.repeat(65537) }, { ...ai, tools: [{ type: 'web_search' }] }, { ...ai, store: true }]) assert.equal((await gateway.execute(req.capability === 'ai' ? 'openai' : 'pdl', req, credentials)).result.status, 'failed');
  assert.equal((await gateway.execute('hunter', email, {})).result.reason, 'invalid_authorization');
  assert.equal((await gateway.execute('tomba', email, credentials)).result.status, 'failed');
  assert.equal(f.calls.length, 0);
});
test('reflected credentials, returned OAuth tokens and query URL identifiers never leak', async () => {
  for (const key of ['pdl', 'openai']) {
    const body = key === 'pdl' ? { name: credentials.apiKey } : { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: credentials.clientSecret }] }] };
    assert.equal(normalized(await createGateway({ fetch: fixture(body).fetch }).execute(key, key === 'pdl' ? company : ai, credentials)).status, 'failed');
  }
  const f = fixture({ body: { data: { email: 'ada@example.com' } }, headers: { 'x-request-id': `https://api.hunter.io/?api_key=${credentials.apiKey}` } });
  const envelope = await createGateway({ fetch: f.fetch }).execute('hunter', email, credentials); normalized(envelope); assert.equal(envelope.requestId, undefined);
  const poll = await createGateway({ fetch: fixture(oauth, { status: 'completed', data: [{ result: [{ email: `${oauth.access_token}@example.com` }] }] }).fetch }).poll('snov', task, credentials);
  assert.equal(normalized(poll).status, 'failed');
  const start = await createGateway({ fetch: fixture(oauth, { data: { task_hash: oauth.access_token } }).fetch }).execute('snov', email, credentials);
  assert.equal(normalized(start).status, 'failed');
});
