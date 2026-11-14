import { ProviderRequestSchema, SelectedProviderOutputSchema, TaskHandleSchema, type ProviderRequest, type NormalizedProviderResult } from '@leadwork/contracts';
import type { Credentials } from './credentials.js';

export type TaskHandle = { providerKey: 'pdl' | 'hunter' | 'snov' | 'openai' | 'tomba'; taskId: string };
export type RequestContext = { signal?: AbortSignal };
export type GatewayOptions = { fetch?: typeof fetch; deadlineMs?: number; allowRealRequests?: boolean };
export type ValidationResult = { status: 'ready' | 'unvalidated' | 'invalid'; reason: string };
export type ProviderEnvelope = {
  result: NormalizedProviderResult;
  consumption?: { units?: { amount: string; unitKind: string }; reportedMoney?: { amount: string; currency: string } };
  requestId?: string;
};
type Key = TaskHandle['providerKey'];
type Json = Record<string, any>;
const hosts = new Set(['api.peopledatalabs.com', 'api.hunter.io', 'api.snov.io', 'api.openai.com']);
const MAX_BODY = 1_048_576;
const failed = (providerKey: Key, reason: Extract<NormalizedProviderResult, { status: 'failed' }>['reason'] = 'provider_error'): ProviderEnvelope => ({ result: { status: 'failed', providerKey, reason } });
const unknown = (providerKey: Key, timeout: boolean): ProviderEnvelope => ({ result: { status: 'unknown', providerKey, reason: timeout ? 'timeout' : 'lost_acknowledgement' } });
const obj = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined;
const id = (v: unknown): string | undefined => typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v) ? v : undefined;
const secretValues = (credentials: Credentials) => Object.values(credentials).filter((v): v is string => typeof v === 'string' && v.length > 0);
function containsSecret(value: unknown, credentials: Credentials): boolean {
  const serialized = JSON.stringify(value);
  return secretValues(credentials).some(secret => serialized.includes(secret) || serialized.includes(JSON.stringify(secret).slice(1, -1)));
}
function usable(providerKey: Key, output: unknown, requestId: string | undefined, verification: unknown = null): ProviderEnvelope {
  const parsed = SelectedProviderOutputSchema.safeParse(output);
  const base = { providerKey, retrievedAt: new Date().toISOString(), requestId: requestId ?? null };
  if (!parsed.success) {
    const capability = obj(output).capability;
    return capability === 'ai' ? failed(providerKey, 'invalid_output') : { result: { ...base, status: 'no_result', capability } };
  }
  const providerLabel = text(verification);
  return { result: { ...base, status: 'succeeded', output: parsed.data, verification: providerLabel && providerLabel.length <= 256 ? { providerLabel, source: providerKey } : null }, ...(requestId ? { requestId } : {}) };
}
class Interrupted extends Error {}
class LostAcknowledgement extends Error {}
class HttpFailure extends Error {
  constructor(readonly status: number) { super('Provider request failed'); }
}
function httpFailure(providerKey: Key, status: number): ProviderEnvelope {
  return failed(providerKey, status === 401 || status === 403 ? 'invalid_authorization' : status === 429 ? 'rate_limited' : 'provider_error');
}
function credentialsPresent(providerKey: Key, credentials: Credentials): boolean {
  return providerKey === 'snov' ? !!text(credentials.clientId) && !!text(credentials.clientSecret) : !!text(credentials.apiKey);
}

export function createGateway(options: GatewayOptions = {}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  // Injected fixtures are permitted; real networking requires deliberate parent opt-in and policy enforcement.
  const permitted = options.fetch !== undefined || options.allowRealRequests === true;
  const deadlineMs = options.deadlineMs ?? 10000;
  if (!Number.isFinite(deadlineMs) || deadlineMs < 1 || deadlineMs > 120000) throw new Error('Invalid provider deadline');

  async function bounded<T>(context: RequestContext | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const stop = new Promise<never>((_, reject) => {
      abort = () => { controller.abort(); reject(new Interrupted('Provider operation interrupted')); };
      timer = setTimeout(abort, deadlineMs);
      context?.signal?.addEventListener('abort', abort, { once: true });
      if (context?.signal?.aborted) abort();
    });
    try {
      if (controller.signal.aborted) return await stop;
      return await Promise.race([operation(controller.signal), stop]);
    } finally {
      clearTimeout(timer); context?.signal?.removeEventListener('abort', abort);
    }
  }
  async function send(url: URL, init: RequestInit, signal: AbortSignal): Promise<{ body: Json; response: Response }> {
    if (!hosts.has(url.hostname) || url.protocol !== 'https:' || url.port || url.username || url.password) throw new Error('Provider host denied');
    signal.throwIfAborted();
    let response: Response;
    try { response = await fetcher(url, { ...init, redirect: 'error', signal }); }
    catch { if (signal.aborted) throw new Interrupted('Provider operation interrupted'); throw new LostAcknowledgement('Provider acknowledgement unavailable'); }
    if (response.status < 200 || response.status >= 300) throw new HttpFailure(response.status);
    if (Number(response.headers.get('content-length')) > MAX_BODY) throw new Error('Provider response too large');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Provider response missing');
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) throw new Error('Provider response too large');
        chunks.push(value);
      }
    } catch (error) { void reader.cancel().catch(() => {}); throw error; }
    finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid provider response');
    return { body: obj(parsed), response };
  }
  async function token(credentials: Credentials, signal: AbortSignal): Promise<string> {
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: credentials.clientId!, client_secret: credentials.clientSecret! });
    const { body } = await send(new URL('https://api.snov.io/v1/oauth/access_token'), { method: 'POST', body: form }, signal);
    if (!text(body.access_token) || body.access_token.length > 8192 || /[\r\n]/.test(body.access_token)) throw new Error('Invalid OAuth response');
    return body.access_token;
  }
  function snovResult(body: Json, task: TaskHandle): ProviderEnvelope {
    if (body.status === 'not_enough_credits') return failed('snov');
    if (body.status === 'in_progress') return { result: { status: 'pending', task } };
    if (body.status !== 'completed') return failed('snov');
    const rows: unknown[] = Array.isArray(body.data) ? body.data : [];
    for (const row of rows) {
      const results: unknown[] = Array.isArray(obj(row).result) ? obj(row).result : [];
      for (const result of results) {
        const r = obj(result);
        const normalized = usable('snov', { capability: 'email', value: text(r.email) ?? '' }, undefined, r.smtp_status);
        if (normalized.result.status === 'succeeded') return normalized;
      }
    }
    return usable('snov', { capability: 'email', value: '' }, undefined);
  }
  async function dispatch(providerKey: Key, request: ProviderRequest, credentials: Credentials, signal: AbortSignal): Promise<ProviderEnvelope> {
    if (providerKey === 'pdl' && request.capability === 'company') {
      const url = new URL('https://api.peopledatalabs.com/v5/company/enrich'); url.searchParams.set('website', request.domain);
      const { body, response } = await send(url, { headers: { 'X-Api-Key': credentials.apiKey! } }, signal);
      if (body.status !== undefined && body.status !== 200) return httpFailure(providerKey, Number(body.status));
      // No scheme invention: bare provider website strings are not certified HTTP(S) URLs.
      return usable('pdl', { capability: 'company', output: request.output, value: text(body[request.output]) ?? '' }, id(response.headers.get('x-request-id')));
    }
    if (providerKey === 'hunter' && request.capability === 'email') {
      const url = new URL('https://api.hunter.io/v2/email-finder');
      url.searchParams.set('api_key', credentials.apiKey!); url.searchParams.set('domain', request.domain);
      if (request.personName.mode === 'full_name') url.searchParams.set('full_name', request.personName.fullName);
      else { url.searchParams.set('first_name', request.personName.givenName); url.searchParams.set('last_name', request.personName.familyName); }
      const { body, response } = await send(url, {}, signal);
      if (Array.isArray(body.errors) && body.errors.length) return failed(providerKey);
      const data = obj(body.data);
      const envelope = usable('hunter', { capability: 'email', value: text(data.email) ?? '' }, id(response.headers.get('x-request-id')), obj(data.verification).status);
      const amount = response.headers.get('x-credits-used'), unitKind = response.headers.get('x-credits-unit');
      if (amount && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount) && unitKind && /^[a-z][a-z0-9_]{0,63}$/.test(unitKind)) envelope.consumption = { units: { amount, unitKind } };
      return envelope;
    }
    if (providerKey === 'snov' && request.capability === 'email' && request.personName.mode === 'mapped_parts') {
      const accessToken = await token(credentials, signal);
      const { body } = await send(new URL('https://api.snov.io/v2/emails-by-domain-by-name/start'), {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: [{ first_name: request.personName.givenName, last_name: request.personName.familyName, domain: request.domain }] }),
      }, signal);
      const taskId = id(obj(body.data).task_hash);
      if (!taskId || containsSecret(taskId, { ...credentials, apiKey: accessToken })) return failed(providerKey);
      return { result: { status: 'pending', task: { providerKey: 'snov', taskId } } };
    }
    if (providerKey === 'openai' && request.capability === 'ai') {
      const { body, response } = await send(new URL('https://api.openai.com/v1/responses'), {
        method: 'POST', headers: { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: request.model, input: request.resolvedInstructions, max_output_tokens: request.maxOutputTokens, tools: [], store: false }),
      }, signal);
      if (body.error) return failed(providerKey);
      const content: unknown[] = (Array.isArray(body.output) ? body.output : []).filter((item: unknown) => obj(item).type === 'message').flatMap((item: unknown) => Array.isArray(obj(item).content) ? obj(item).content : []);
      if (content.some(item => obj(item).type === 'refusal')) return failed(providerKey, 'refused');
      if (body.status !== 'completed') return failed(providerKey, 'invalid_output');
      const draft = content.filter(item => obj(item).type === 'output_text').map(item => typeof obj(item).text === 'string' ? obj(item).text : '').join('');
      const envelope = usable(providerKey, { capability: 'ai', value: draft }, id(response.headers.get('x-request-id')));
      const total = obj(body.usage).total_tokens;
      if (Number.isSafeInteger(total) && total >= 0) envelope.consumption = { units: { amount: String(total), unitKind: 'tokens' } };
      return envelope;
    }
    return failed(providerKey);
  }
  async function execute(providerKey: Key, request: ProviderRequest, credentials: Credentials, context?: RequestContext): Promise<ProviderEnvelope> {
    try {
      if (!permitted || !['pdl', 'hunter', 'snov', 'openai'].includes(providerKey)) return failed(providerKey);
      const parsed = ProviderRequestSchema.safeParse(request);
      if (!parsed.success) return failed(providerKey);
      if (!credentialsPresent(providerKey, credentials)) return failed(providerKey, 'invalid_authorization');
      if (JSON.stringify(parsed.data).length > 65536 || (parsed.data.capability === 'ai' && parsed.data.maxOutputTokens > 16384)) return failed(providerKey, 'input_too_large');
      const envelope = await bounded(context, signal => dispatch(providerKey, parsed.data, credentials, signal));
      return containsSecret(envelope, credentials) ? failed(providerKey, 'invalid_output') : envelope;
    } catch (error) {
      return error instanceof HttpFailure ? httpFailure(providerKey, error.status) : error instanceof Interrupted ? unknown(providerKey, !context?.signal?.aborted) : error instanceof LostAcknowledgement ? unknown(providerKey, false) : failed(providerKey, 'invalid_output');
    }
  }
  async function poll(providerKey: Key, task: TaskHandle, credentials: Credentials, context?: RequestContext): Promise<ProviderEnvelope> {
    try {
      if (!permitted || providerKey !== 'snov' || !TaskHandleSchema.safeParse(task).success || task.providerKey !== providerKey || !id(task.taskId)) return failed(providerKey);
      if (!credentialsPresent(providerKey, credentials)) return failed(providerKey, 'invalid_authorization');
      const envelope = await bounded(context, async signal => {
        const accessToken = await token(credentials, signal);
        const url = new URL('https://api.snov.io/v2/emails-by-domain-by-name/result'); url.searchParams.set('task_hash', task.taskId);
        const { body } = await send(url, { headers: { Authorization: `Bearer ${accessToken}` } }, signal);
        const result = snovResult(body, task);
        return containsSecret(result, { ...credentials, apiKey: accessToken }) ? failed(providerKey, 'invalid_output') : result;
      });
      return containsSecret(envelope, credentials) ? failed(providerKey, 'invalid_output') : envelope;
    } catch (error) { return error instanceof HttpFailure ? httpFailure(providerKey, error.status) : error instanceof Interrupted ? unknown(providerKey, !context?.signal?.aborted) : error instanceof LostAcknowledgement ? unknown(providerKey, false) : failed(providerKey, 'invalid_output'); }
  }
  async function validate(providerKey: Key, credentials: Credentials): Promise<ValidationResult> {
    try {
      if (!credentialsPresent(providerKey, credentials)) return { status: 'invalid', reason: 'Required credentials missing' };
      if (providerKey !== 'hunter') return { status: 'unvalidated', reason: 'No verified nonbillable authorization mechanism; no sample lookup performed' };
      if (!permitted) return { status: 'unvalidated', reason: 'Real requests disabled; free account check requires authorization' };
      return await bounded(undefined, async signal => {
        const url = new URL('https://api.hunter.io/v2/account'); url.searchParams.set('api_key', credentials.apiKey!);
        const { body } = await send(url, {}, signal);
        if (Array.isArray(body.errors) && body.errors.length) return { status: 'invalid', reason: 'Provider rejected account check' };
        if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data) || !Object.keys(body.data).length) return { status: 'unvalidated', reason: 'Account check response not recognized' };
        return { status: 'ready', reason: 'Documented free account check accepted authorization; production capability remains gated' };
      });
    } catch (error) {
      return error instanceof HttpFailure && [401, 403].includes(error.status)
        ? { status: 'invalid', reason: 'Provider rejected authorization' }
        : { status: 'unvalidated', reason: 'Account check could not be confirmed' };
    }
  }
  return { execute, poll, validate };
}
