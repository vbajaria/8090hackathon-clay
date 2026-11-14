import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {after, before, test as nodeTest} from 'node:test';
import {z} from 'zod';
import {createApp} from '../dist/app.js';
import {Database} from '../dist/db.js';
import {Worker} from '../dist/worker.js';
import {capabilityCatalog} from '../../providers/dist/catalog.js';
import {createGateway, decryptCredentials} from '../../providers/dist/index.js';
import {apiError, CellSchema, IdSchema, RowSchema, RunProgressSchema} from '../../contracts/dist/index.js';

const test = (name, fn) => nodeTest(name, {timeout:15_000, concurrency:false}, fn);
const origin = 'http://localhost:3000';
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://leadwork:leadwork-local-only@localhost:5432/leadwork';
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(databaseUrl).hostname), 'HTTP fixtures require local PostgreSQL, never a cloud database');
assert.notEqual(process.env.NODE_ENV, 'production', 'Explicit development-auth tests require nonproduction mode');
const db = new Database(databaseUrl);
db.pool.options.statement_timeout = 5000;
db.pool.options.connectionTimeoutMillis = 2000;
// HTTP cell DTO adds a safe nullable provenance ID to the shared domain cell.
const HttpCellSchema = CellSchema.extend({sourceStepId:IdSchema.nullable()});
const HttpRowSchema = RowSchema.extend({cells:z.record(IdSchema,HttpCellSchema)});
const text = value => ({type:'text', value});
const consent = {overwritePopulated:true, refreshStale:true, unknownPrice:true, possibleDuplicateCharge:true};
const importRequest = plan => ({planId:plan.id, expectedPlanRevision:plan.revision, idempotencyKey:randomUUID()});
const runRequest = preview => ({previewId:preview.id, expectedPreviewRevision:preview.revision, idempotencyKey:randomUUID(), consent});
let externalCalls = 0;
let originalFetch;

before(async () => {
  // Do not migrate, truncate, start services, or touch nonfixture records.
  await db.pool.query('SELECT source_versions FROM app.run_rows LIMIT 0');
  await db.pool.query('SELECT attempt_id FROM app.request_authorizations LIMIT 0');
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { externalCalls++; throw new Error('HTTP tests prohibit external network I/O'); };
});
after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  await db.close();
  assert.equal(externalCalls, 0, 'No Supabase, authorization, provider dispatch, or polling calls');
});

async function fixture(t) {
  const key = randomBytes(32).toString('base64');
  const authOptions = {authMode:'development', nodeEnv:'test', sessionSecret:randomBytes(32).toString('hex'), appOrigin:origin};
  // Pin shipped disabled policy and gateway rather than inheriting deployment toggles.
  const policies = structuredClone(capabilityCatalog);
  assert.ok(policies.every(p => p.enabledForRealRequests === false));
  const gateway = createGateway({allowRealRequests:false});
  const app = createApp({db, key, authOptions, policies, gateway});
  const owners = [];
  const callsBefore = externalCalls;
  t.after(async () => {
    // Login-derived identities are unique per fixture secret. Never delete by email/name.
    for (const owner of owners) {
      const workspaces = (await db.pool.query('SELECT id FROM app.workspaces WHERE owner_id=$1',[owner])).rows;
      for (const {id} of workspaces) {
        await db.pool.query('DELETE FROM app.usage_observations WHERE workspace_id=$1',[id]);
        await db.pool.query('DELETE FROM app.consumption WHERE workspace_id=$1',[id]);
        await db.pool.query('DELETE FROM app.tables WHERE workspace_id=$1',[id]);
        await db.pool.query('DELETE FROM app.connections WHERE workspace_id=$1',[id]);
        await db.pool.query('DELETE FROM app.workspaces WHERE id=$1',[id]);
      }
    }
    assert.equal(externalCalls, callsBefore, 'Fixture performed zero external calls');
  });
  async function http(path, {method='GET', cookie, body, raw, requestOrigin=origin, headers={}}={}) {
    const h = new Headers(headers);
    if (cookie) h.set('cookie', cookie);
    if (!['GET','HEAD'].includes(method)) {
      if (requestOrigin !== null) h.set('origin', requestOrigin);
      if (!h.has('content-type')) h.set('content-type','application/json');
    }
    const response = await app.handle(new Request(`${origin}/api${path}`, {method, headers:h,
      ...(!['GET','HEAD'].includes(method) ? {body:raw ?? JSON.stringify(body ?? {})} : {})}));
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    const rawBody = await response.text();
    const data = response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(rawBody) : rawBody;
    return {response, status:response.status, data, rawBody, request:`${method} /api${path}`};
  }
  async function ok(path, options) {
    const result = await http(path, options);
    assert.equal(result.status, 200, `${result.request}: ${result.status} ${result.rawBody}`);
    return result.data;
  }
  async function login(email) {
    const result = await http('/auth/login', {method:'POST', body:{email}});
    assert.equal(result.status,200, result.rawBody);
    assert.deepEqual(result.data,{ok:true,mode:'development'});
    // Node 22 Headers API: never split a combined Set-Cookie header on commas.
    const cookies = result.response.headers.getSetCookie();
    assert.equal(cookies.length,1);
    assert.match(cookies[0], /HttpOnly/i);
    assert.match(cookies[0], /SameSite=Lax/i);
    const cookie = cookies[0].split(';',1)[0];
    const session = await ok('/auth/session',{cookie});
    assert.equal(session.mode,'development');
    assert.equal(session.user.email,email.trim().toLowerCase());
    owners.push(session.user.id);
    return {cookie, user:session.user};
  }
  const a = await login('alice@http-fixture.example');
  const b = await login('bob@http-fixture.example');
  assert.notEqual(a.user.id,b.user.id);
  const table = await ok('/tables',{method:'POST',cookie:a.cookie,body:{name:`HTTP fixture ${randomUUID()}`}});
  const tablePath = `/tables/${table.id}`;
  const data = () => ok(tablePath,{cookie:a.cookie});
  const workspace = async () => (await db.pool.query('SELECT workspace_id FROM app.tables WHERE id=$1',[table.id])).rows[0].workspace_id;
  return {app, key, authOptions, policies, gateway, a, b, table, tablePath, data, workspace, http, ok};
}
function error(result, code) {
  assert.equal(result.status, apiError(code).status, `${result.request}: ${result.status} ${result.rawBody}`);
  assert.deepEqual(result.data.error, apiError(code));
}
async function addRow(f) { return f.ok(`${f.tablePath}/rows`,{method:'POST',cookie:f.a.cookie}); }
async function patch(f,rowId,columnId,value,expectedVersion) {
  if (expectedVersion === undefined) expectedVersion = (await f.data()).rows.find(r=>r.id===rowId).cells[columnId].version;
  return f.ok(`${f.tablePath}/cells`,{method:'PATCH',cookie:f.a.cookie,body:{rowId,columnId,value,expectedVersion}});
}
async function column(f,name,definition) {
  return f.ok(`${f.tablePath}/columns`,{method:'POST',cookie:f.a.cookie,body:{name,definition}});
}
async function preview(f,columnId,replacePopulated=false) {
  const current = await f.data();
  return f.ok('/runs/preview',{method:'POST',cookie:f.a.cookie,body:{tableId:f.table.id,expectedTableRevision:current.table.revision,rowScope:{kind:'all'},selectedColumnIds:[columnId],replacePopulated}});
}

// Workers scan globally in production. Restrict only claim/recovery/expiry candidates
// to this fixture, retaining the real Worker implementation and SQL transitions.
function scopedWorkerDb(ws) {
  assert.match(ws,/^[a-f0-9-]{36}$/);
  return {transaction: fn => db.transaction(tx => fn(new Proxy(tx,{get(target,property) {
    if (property !== 'query') return Reflect.get(target,property);
    return (sql,args) => {
      if (sql.startsWith('SELECT s.id,r.id AS run_id')) sql = sql.replace("WHERE s.outcome='queued'",`WHERE r.workspace_id='${ws}'::uuid AND s.outcome='queued'`);
      if (sql.startsWith('SELECT s.id,r.table_id')) sql = sql.replace("WHERE s.outcome='running'",`WHERE r.workspace_id='${ws}'::uuid AND s.outcome='running'`);
      if (sql.startsWith('DELETE FROM app.plans WHERE expires_at')) sql += ` AND workspace_id='${ws}'::uuid`;
      return target.query(sql,args);
    };
  }})))};
}

test('signed local login: session tampering, logout replay, and unauthenticated API access deny', async t => {
  const f = await fixture(t);
  for (const [path,method] of [['/tables','GET'],[f.tablePath,'GET'],['/connections','GET'],['/runs','GET'],['/usage','GET'],['/tables','POST']]) {
    error(await f.http(path,{method,body:{name:'unauthenticated'}}),'unauthenticated');
  }
  const [name,token] = f.a.cookie.split('=');
  const [payload,signature] = token.split('.');
  const tampered = `${name}=${payload}.${signature[0]==='A'?'B':'A'}${signature.slice(1)}`;
  assert.equal((await f.ok('/auth/session',{cookie:tampered})).user,null);
  error(await f.http(f.tablePath,{cookie:tampered}),'unauthenticated');
  const logout = await f.http('/auth/logout',{method:'POST',cookie:f.a.cookie});
  assert.equal(logout.status,200,logout.rawBody);
  assert.match(logout.response.headers.getSetCookie()[0], /Max-Age=0/i);
  assert.equal((await f.ok('/auth/session',{cookie:f.a.cookie})).user,null);
  error(await f.http(f.tablePath,{cookie:f.a.cookie}),'unauthenticated');
  assert.equal((await f.ok('/auth/session',{cookie:f.b.cookie})).user.id,f.b.user.id);
});

test('every mutation requires matching Origin, including login and logout', async t => {
  const f = await fixture(t);
  for (const requestOrigin of [null,'http://attacker.example','http://127.0.0.1:3000']) {
    for (const [path,method,body] of [
      ['/auth/login','POST',{email:'origin@http-fixture.example'}],
      ['/auth/logout','POST',{}],['/tables','POST',{name:'rejected'}],
      [`${f.tablePath}/cells`,'PATCH',{}],[`/connections/${randomUUID()}`,'DELETE',{}],
    ]) error(await f.http(path,{method,body,cookie:f.a.cookie,requestOrigin}),'unauthenticated');
  }
  assert.equal((await f.ok('/auth/session',{cookie:f.a.cookie})).user.id,f.a.user.id);
  assert.equal((await f.ok('/tables',{cookie:f.a.cookie})).length,1);
});

test('table and typed cells persist; stale edits return current latest; client identity cannot override owner', async t => {
  const f = await fixture(t), data = await f.data(), col = data.columns[0];
  assert.equal(data.columns.length,4);
  const row = await addRow(f);
  HttpRowSchema.parse(row);
  const saved = await patch(f,row.id,col.id,text('Ada'),row.cells[col.id].version);
  HttpCellSchema.parse(saved);
  const latest = await patch(f,row.id,col.id,text('Latest private value'),saved.version);
  const conflict = await f.http(`${f.tablePath}/cells`,{method:'PATCH',cookie:f.a.cookie,body:{rowId:row.id,columnId:col.id,expectedVersion:saved.version,value:text('lost update')}});
  error(conflict,'version_conflict');
  assert.deepEqual(conflict.data.current,latest);
  assert.deepEqual((await f.data()).rows[0].cells[col.id],latest);
  // A fresh app instance reads persisted values, not a process-local table cache.
  const reopened = createApp({db,key:f.key,authOptions:f.authOptions,policies:f.policies,gateway:f.gateway});
  const reopenedResponse = await reopened.handle(new Request(`${origin}/api${f.tablePath}`,{headers:{cookie:f.a.cookie}}));
  assert.equal(reopenedResponse.status,200);
  assert.deepEqual((await reopenedResponse.json()).rows[0].cells[col.id],latest);
  const persisted = (await db.pool.query('SELECT value,version::text FROM app.cells WHERE row_id=$1 AND column_id=$2',[row.id,col.id])).rows[0];
  assert.deepEqual(persisted,{value:latest.value,version:latest.version});
  error(await f.http('/tables',{method:'POST',cookie:f.b.cookie,body:{name:'spoof',ownerId:f.a.user.id}}),'invalid_value');
  error(await f.http(`${f.tablePath}?ownerId=${f.a.user.id}`,{cookie:f.b.cookie,headers:{'x-owner-id':f.a.user.id}}),'not_found');
  error(await f.http(`${f.tablePath}/cells`,{method:'PATCH',cookie:f.b.cookie,body:{rowId:row.id,columnId:col.id,expectedVersion:latest.version,value:text('intruder')}}),'not_found');
  assert.deepEqual(await f.ok('/tables',{cookie:f.b.cookie}),[]);
  assert.equal((await db.pool.query('SELECT owner_id FROM app.workspaces WHERE id=$1',[await f.workspace()])).rows[0].owner_id,f.a.user.id);
});

test('CSV correction, explicit idempotent confirmation, and raw export use current typed values', async t => {
  const f = await fixture(t), col = (await f.data()).columns[0];
  let plan = await f.ok(`${f.tablePath}/import/preview`,{method:'POST',cookie:f.a.cookie,body:{csvText:',Value\n"Ada, Jr",bad-number',mappings:[
    {sourceIndex:0,destination:{kind:'existing',columnId:col.id,valueType:'text'}},
    {sourceIndex:1,destination:{kind:'new',name:'Exact number',valueType:'number'}},
  ]}});
  assert.equal(plan.state,'needs_correction');
  assert.ok(plan.issues.some(i=>i.code==='blank_header'));
  assert.ok(plan.issues.some(i=>i.code==='invalid_number'));
  assert.equal((await f.data()).table.rowCount,0);
  error(await f.http(`/imports/${plan.id}/confirm`,{method:'POST',cookie:f.a.cookie,body:importRequest(plan)}),'invalid_mapping');
  const oldRevision = plan.revision;
  plan = await f.ok(`/imports/${plan.id}/correct`,{method:'POST',cookie:f.a.cookie,body:{expectedPlanRevision:oldRevision,headers:['Name','Value'],corrections:[{rowIndex:0,sourceIndex:1,replacementText:'9007199254740993.125'}]}});
  assert.equal(plan.state,'ready');
  assert.deepEqual(plan.issues,[]);
  error(await f.http(`/imports/${plan.id}/correct`,{method:'POST',cookie:f.a.cookie,body:{expectedPlanRevision:oldRevision,headers:['Name','Value']}}),'version_conflict');
  const request = importRequest(plan);
  for (const action of ['correct','confirm']) error(await f.http(`/imports/${plan.id}/${action}`,{method:'POST',cookie:f.b.cookie,body:action==='correct'?{expectedPlanRevision:plan.revision,headers:['Name','Value']}:request}),'not_found');
  const result = await f.ok(`/imports/${plan.id}/confirm`,{method:'POST',cookie:f.a.cookie,body:request});
  assert.deepEqual(await f.ok(`/imports/${plan.id}/confirm`,{method:'POST',cookie:f.a.cookie,body:request}),result);
  error(await f.http(`/imports/${plan.id}/confirm`,{method:'POST',cookie:f.a.cookie,body:{...request,idempotencyKey:randomUUID()}}),'idempotency_conflict');
  const current = await f.data(), numberId = result.createdColumnIds[0];
  assert.equal(current.table.rowCount,1);
  assert.deepEqual(current.rows[0].cells[numberId].value,{type:'number',value:'9007199254740993.125'});
  await patch(f,current.rows[0].id,col.id,text('Changed, current'));
  const exported = await f.http(`${f.tablePath}/export`,{method:'POST',cookie:f.a.cookie,body:{tableId:f.table.id,rowScope:{kind:'all'},columnIds:[col.id,numberId],expectedViewRevision:current.view.revision,acknowledgeStoredOutputWarnings:false,neutralizeSpreadsheetText:true}});
  assert.equal(exported.status,200,exported.rawBody);
  assert.match(exported.response.headers.get('content-type'),/^text\/csv/);
  assert.match(exported.response.headers.get('content-disposition'),/attachment/);
  assert.equal(exported.data,'Person name,Exact number\r\n"Changed, current",9007199254740993.125\r\n');
});

test('connections expose no secrets, encrypt DB credentials, validate disabled without I/O, and disconnect revisions', async t => {
  const f = await fixture(t), credentials = {apiKey:`fixture-secret-${randomUUID()}`};
  const connection = await f.ok('/connections',{method:'POST',cookie:f.a.cookie,body:{providerKey:'hunter',credentials,acknowledgeDirectBilling:true}});
  assert.equal(connection.status,'unvalidated');
  assert.ok(!JSON.stringify(connection).includes(credentials.apiKey));
  assert.ok(!Object.hasOwn(connection,'ciphertext'));
  const stored = (await db.pool.query('SELECT ciphertext FROM app.connections WHERE id=$1',[connection.id])).rows[0];
  assert.ok(stored.ciphertext.length > 0);
  assert.ok(!stored.ciphertext.includes(credentials.apiKey));
  assert.deepEqual(decryptCredentials(stored.ciphertext,f.key,JSON.stringify([await f.workspace(),connection.id])),credentials);
  const listed = await f.ok('/connections',{cookie:f.a.cookie});
  assert.deepEqual(listed.connections,[connection]);
  assert.ok(listed.catalog.every(p=>p.enabledForRealRequests===false));
  assert.ok(!JSON.stringify(listed).includes(credentials.apiKey));
  const validated = await f.ok(`/connections/${connection.id}/validate`,{method:'POST',cookie:f.a.cookie});
  assert.equal(validated.status,'unvalidated');
  assert.deepEqual((await f.ok('/connections',{cookie:f.b.cookie})).connections,[]);
  for (const [path,method] of [[`/connections/${connection.id}/validate`,'POST'],[`/connections/${connection.id}`,'DELETE']]) error(await f.http(path,{method,cookie:f.b.cookie}),'not_found');
  await f.ok(`/connections/${connection.id}`,{method:'DELETE',cookie:f.a.cookie});
  const disconnected = (await f.ok('/connections',{cookie:f.a.cookie})).connections[0];
  assert.equal(disconnected.status,'disconnected');
  assert.equal(disconnected.revision,String(BigInt(connection.revision)+1n));
  assert.equal((await db.pool.query('SELECT ciphertext FROM app.connections WHERE id=$1',[connection.id])).rows[0].ciphertext,'');
  error(await f.http(`/connections/${connection.id}/validate`,{method:'POST',cookie:f.a.cookie}),'not_found');
});

test('AI instruction preview resolves stored inputs without external calls', async t => {
  const f = await fixture(t), source = (await f.data()).columns[0], row = await addRow(f);
  await patch(f,row.id,source.id,text('Ada fixture'));
  const connection = await f.ok('/connections',{method:'POST',cookie:f.a.cookie,body:{providerKey:'openai',credentials:{apiKey:'synthetic-ai-key'},acknowledgeDirectBilling:true}});
  const ai = await column(f,'AI draft',{kind:'ai',connection:{id:connection.id,revision:connection.revision},model:'fixture-model',instructionTemplate:`Write to {{${source.id}}}`,referencedColumnIds:[source.id]});
  const request = {columnId:ai.id,rowId:row.id};
  const resolved = await f.ok(`${f.tablePath}/ai-preview`,{method:'POST',cookie:f.a.cookie,body:request});
  assert.deepEqual(resolved,{resolvedInstructions:'Write to Ada fixture',missingColumnIds:[]});
  error(await f.http(`${f.tablePath}/ai-preview`,{method:'POST',cookie:f.b.cookie,body:request}),'not_found');
  assert.equal((await db.pool.query('SELECT count(*) FROM app.runs WHERE table_id=$1',[f.table.id])).rows[0].count,'0');
});

test('formula preview/confirm and GET progress are read-only dispatch; explicit scoped worker tick completes', async t => {
  const f = await fixture(t), source = (await f.data()).columns[0], row = await addRow(f);
  await patch(f,row.id,source.id,text('Ada'));
  const formula = await column(f,'Uppercase',{kind:'formula',expression:`UPPER({{${source.id}}})`,referencedColumnIds:[source.id],returnType:'text'});
  const fresh = await preview(f,formula.id);
  assert.deepEqual(fresh.cells,{eligible:0,reused:1,skipped:0});
  assert.deepEqual(fresh.providers,[]);
  assert.equal(fresh.maximumExternalRequests,0);
  const reused = await f.ok('/runs/confirm',{method:'POST',cookie:f.a.cookie,body:runRequest(fresh)});
  assert.equal(reused.status,'completed');
  // Live formula edits auto-compute. Mark ONLY this fixture cell stale to exercise queued work.
  await db.pool.query('UPDATE app.cells SET stale=true WHERE row_id=$1 AND column_id=$2',[row.id,formula.id]);
  const staged = await preview(f,formula.id,true), request = runRequest(staged);
  assert.deepEqual(staged.cells,{eligible:1,reused:0,skipped:0});
  assert.equal(staged.maximumExternalRequests,0);
  error(await f.http('/runs/confirm',{method:'POST',cookie:f.b.cookie,body:request}),'not_found');
  const run = await f.ok('/runs/confirm',{method:'POST',cookie:f.a.cookie,body:request});
  assert.equal(run.status,'queued');
  assert.deepEqual(await f.ok('/runs/confirm',{method:'POST',cookie:f.a.cookie,body:request}),run);
  const before = (await db.pool.query('SELECT outcome,fencing::text FROM app.steps WHERE run_id=$1',[run.id])).rows;
  for (let i=0;i<3;i++) {
    const detail = await f.ok(`/runs/${run.id}`,{cookie:f.a.cookie});
    // Handoff explicitly permits these HTTP read metadata fields.
    const {createdAt,completedAt,...progress} = detail.progress;
    assert.ok(Number.isFinite(Date.parse(createdAt)));
    assert.equal(completedAt,null);
    RunProgressSchema.parse(progress);
    assert.equal(detail.progress.counts.queued,1);
    assert.deepEqual(detail.attempts,[]);
    assert.ok((await f.ok(`/runs?tableId=${f.table.id}`,{cookie:f.a.cookie})).some(r=>r.id===run.id));
  }
  assert.deepEqual((await db.pool.query('SELECT outcome,fencing::text FROM app.steps WHERE run_id=$1',[run.id])).rows,before);
  for (const [path,method] of [[`/runs/${run.id}`,'GET'],[`/runs/${run.id}/cancel`,'POST'],[`/runs/${run.id}/retry-preview`,'POST'],[`/usage?runId=${run.id}`,'GET']]) error(await f.http(path,{method,cookie:f.b.cookie}),'not_found');
  assert.deepEqual(await f.ok('/runs',{cookie:f.b.cookie}),[]);
  const worker = new Worker(scopedWorkerDb(await f.workspace()),f.key,f.gateway,f.policies);
  assert.equal(await worker.tick(),true);
  const complete = await f.ok(`/runs/${run.id}`,{cookie:f.a.cookie});
  assert.equal(complete.progress.status,'completed');
  assert.equal(complete.progress.counts.succeeded,1);
  assert.deepEqual(complete.attempts,[]);
  assert.deepEqual((await f.data()).rows[0].cells[formula.id].value,text('ADA'));
  const usage = await f.ok(`/usage?runId=${run.id}`,{cookie:f.a.cookie});
  assert.equal(usage.externalStarts,0);
  assert.deepEqual(usage.totals,[]);
});

test('malformed JSON, UUIDs, mappings, and UTF-8 body size fail safely rather than 500', async t => {
  const f = await fixture(t);
  error(await f.http('/tables',{method:'POST',cookie:f.a.cookie,raw:'{"name":'}),'invalid_value');
  error(await f.http('/tables',{method:'POST',cookie:f.a.cookie,raw:'{"name":"x"}',headers:{'content-type':'text/plain'}}),'invalid_value');
  for (const path of ['/tables/not-a-uuid','/runs/not-a-uuid','/runs?tableId=not-a-uuid','/usage?runId=not-a-uuid']) error(await f.http(path,{cookie:f.a.cookie}),'invalid_value');
  for (const [path,body] of [[`${f.tablePath}/cells`,{rowId:'bad',columnId:'bad',expectedVersion:'1',value:text('private invalid')}],
    [`${f.tablePath}/import/preview`,{csvText:'Name\nAda',mappings:[{sourceIndex:0,destination:{kind:'existing',columnId:'bad',valueType:'text'}}]}]]) error(await f.http(path,{method:path.endsWith('/cells')?'PATCH':'POST',cookie:f.a.cookie,body}),'invalid_value');
  // One oversized allocation: characters <21MB but UTF-8 bytes >21,000,000.
  // Misleading Content-Length must not bypass the streaming byte limit.
  const raw = JSON.stringify({name:'é'.repeat(10_500_000)});
  assert.ok(raw.length < 21_000_000);
  assert.ok(Buffer.byteLength(raw) > 21_000_000);
  error(await f.http('/tables',{method:'POST',cookie:f.a.cookie,raw,headers:{'content-length':'1'}}),'capacity_exceeded');
  assert.equal((await f.ok('/tables',{cookie:f.a.cookie})).length,1);
});

test('unexpected database/provider failures return only the canonical safe error envelope', async t => {
  const f = await fixture(t);
  const rawDiagnostic = 'SQL SELECT private lead; provider raw payload; apiKey=fixture-credential; postgresql://user:password@db';
  // Inject one failure at the transaction boundary, not a fake persistence database.
  // All positive flows above use the real local PostgreSQL Database instance.
  const brokenDb = {pool:db.pool, transaction:async () => { throw new Error(rawDiagnostic); }};
  const broken = createApp({db:brokenDb,key:f.key,authOptions:f.authOptions,policies:f.policies,gateway:f.gateway});
  const response = await broken.handle(new Request(`${origin}/api/tables`,{headers:{cookie:f.a.cookie}}));
  assert.equal(response.status,500);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body),{error:apiError('internal_error')});
  assert.ok(!body.includes(rawDiagnostic));
  assert.ok(!body.includes('fixture-credential'));
  const connection = await f.ok('/connections',{method:'POST',cookie:f.a.cookie,body:{providerKey:'hunter',credentials:{apiKey:'fixture-credential'},acknowledgeDirectBilling:true}});
  const failingGateway = {...f.gateway,validate:async () => {throw new Error(rawDiagnostic);}};
  const providerFailureApp = createApp({db,key:f.key,authOptions:f.authOptions,policies:f.policies,gateway:failingGateway});
  const providerResponse = await providerFailureApp.handle(new Request(`${origin}/api/connections/${connection.id}/validate`,{method:'POST',headers:{cookie:f.a.cookie,origin,'content-type':'application/json'},body:'{}'}));
  assert.equal(providerResponse.status,500);
  assert.deepEqual(await providerResponse.json(),{error:apiError('internal_error')});
});

test('valid JSON with malformed import mapping shapes returns safe 4xx', async t => {
  const f = await fixture(t);
  const failures = [];
  for (const mappings of [{},[null],[42]]) {
    const result = await f.http(`${f.tablePath}/import/preview`,{method:'POST',cookie:f.a.cookie,body:{csvText:'Name\nAda',mappings}});
    if (result.status >= 500) failures.push({request:result.request,body:{csvText:'Name\nAda',mappings},status:result.status,response:result.data});
    else assert.ok(result.status >= 400 && result.status < 500, `${result.request}: ${result.rawBody}`);
  }
  assert.deepEqual(failures,[],JSON.stringify(failures,null,2));
});

test('concurrent progress and usage polling are read-only and do not exhaust the connection pool', async t => {
  const f=await fixture(t);await addRow(f);const output=await column(f,'Read-only formula',{kind:'formula',expression:'"ready"',referencedColumnIds:[],returnType:'text'});
  const p=await preview(f,output.id);const run=await f.ok('/runs/confirm',{method:'POST',cookie:f.a.cookie,body:runRequest(p)});
  const owner=(await f.ok('/auth/session',{cookie:f.a.cookie})).user.id;
  const before=(await db.pool.query('SELECT xmin::text AS version FROM app.workspaces WHERE owner_id=$1',[owner])).rows[0].version;
  const requests=Array.from({length:30},(_,i)=>f.http(i%3===0?'/usage':i%3===1?`/runs/${run.id}`:`/runs?tableId=${f.table.id}`,{cookie:f.a.cookie}));
  const results=await Promise.all(requests);assert.ok(results.every(r=>r.status===200));
  const after=(await db.pool.query('SELECT xmin::text AS version FROM app.workspaces WHERE owner_id=$1',[owner])).rows[0].version;assert.equal(after,before);
});

test('historical reused results stay stale after later automatic formula recomputation', async t => {
  const f=await fixture(t);const source=(await f.data()).columns[0];const row=await addRow(f);await patch(f,row.id,source.id,text('Before'));
  const output=await column(f,'Historical formula',{kind:'formula',expression:`UPPER({{${source.id}}})`,referencedColumnIds:[source.id],returnType:'text'});
  const p=await preview(f,output.id);const run=await f.ok('/runs/confirm',{method:'POST',cookie:f.a.cookie,body:runRequest(p)});
  await patch(f,row.id,source.id,text('After'));const detail=await f.ok(`/runs/${run.id}`,{cookie:f.a.cookie});assert.equal(detail.results[0].storedValue.value,'BEFORE');assert.equal(detail.results[0].stale,true);
});

test('legacy stored results without fingerprints are conservatively stale, not certified fresh', async t => {
  const f=await fixture(t);await addRow(f);const output=await column(f,'Legacy result',{kind:'formula',expression:'"legacy"',referencedColumnIds:[],returnType:'text'});
  const p=await preview(f,output.id);const run=await f.ok('/runs/confirm',{method:'POST',cookie:f.a.cookie,body:runRequest(p)});
  await db.pool.query('UPDATE app.steps SET input_fingerprint=NULL WHERE run_id=$1',[run.id]);
  const detail=await f.ok(`/runs/${run.id}`,{cookie:f.a.cookie});assert.equal(detail.results[0].storedValue.value,'legacy');assert.equal(detail.results[0].stale,true);
});
