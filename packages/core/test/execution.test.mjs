import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {after, before, test as nodeTest} from 'node:test';
import {Database} from '../dist/db.js';
import {createApp} from '../dist/app.js';
import {Worker} from '../dist/worker.js';
import {usageSummary} from '../dist/ledger.js';
import {capabilityCatalog} from '../../providers/dist/catalog.js';
import {NormalizedProviderResultSchema, ProviderRequestSchema, ProviderCapabilitiesSchema} from '../../contracts/dist/index.js';

// Fixture evidence ONLY: these flags never certify providers or enable a real gateway.
const test = (name, fn) => nodeTest(name, {timeout: 15_000}, fn);
const db = new Database(process.env.DATABASE_URL ?? 'postgresql://leadwork:leadwork-local-only@localhost:5432/leadwork');
// Apply bounds to every subsequently created pg client, not just one pooled session.
db.pool.options.statement_timeout=5000;
db.pool.options.connectionTimeoutMillis=2000;
const text = value => ({type:'text', value});
const ref = id => `{{${id}}}`;
const consent = {overwritePopulated:true, refreshStale:true, unknownPrice:true, possibleDuplicateCharge:true};
const request = preview => ({previewId:preview.id, expectedPreviewRevision:preview.revision, idempotencyKey:randomUUID(), consent});
const code = value => error => error.error?.code === value;
const zero = {units:{amount:'0', unitKind:'fixture_credit'}, reportedMoney:{amount:'0', currency:'USD'}};
const deferred = () => {let resolve; const promise = new Promise(r => {resolve=r;}); return {promise, resolve};};
async function enteredOrFailed(entered, tick) {
  await Promise.race([entered.promise, tick.then(() => assert.fail('Worker ended before reaching fixture dispatch/poll'))]);
}
const success = (providerKey, capability, value, consumption) => ({result:{status:'succeeded', providerKey, retrievedAt:new Date().toISOString(), requestId:null, output:{capability, ...(capability==='company'?{output:'name'}:{}), value}, verification:null}, ...(consumption?{consumption}:{})});
const noResult = (providerKey, capability='email') => ({result:{status:'no_result', providerKey, capability, retrievedAt:new Date().toISOString(), requestId:null}});
const pending = () => ({result:{status:'pending', task:{providerKey:'snov', taskId:'fixture-task'}}});
const failed = providerKey => ({result:{status:'failed', providerKey, reason:'provider_error'}});
const unknown = providerKey => ({result:{status:'unknown', providerKey, reason:'timeout'}});

// Do not migrate/truncate shared schema. Require the parent's initialized 001/002 DB.
before(async () => {
  await db.pool.query("SET statement_timeout='5s'");
  await db.pool.query('SELECT source_versions FROM app.run_rows LIMIT 0');
});
after(async () => {await db.close();});

// Production claims/recovery scan globally. Add only a fixture workspace predicate
// at the DB boundary, retaining production Worker transitions/SQL/locking intact.
function scopedWorkerDb(ws) {
  assert.match(ws, /^[a-f0-9-]{36}$/);
  return {transaction: fn => db.transaction(tx => fn(new Proxy(tx, {get(target, property) {
    if(property!=='query')return Reflect.get(target, property);
    return (sql, args) => {
      if(sql.startsWith('SELECT s.id,r.id AS run_id'))sql=sql.replace("WHERE s.outcome='queued'", `WHERE r.workspace_id='${ws}'::uuid AND s.outcome='queued'`);
      if(sql.startsWith('SELECT s.id,r.table_id'))sql=sql.replace("WHERE s.outcome='running'", `WHERE r.workspace_id='${ws}'::uuid AND s.outcome='running'`);
      if(sql.startsWith('DELETE FROM app.plans WHERE expires_at'))sql+=` AND workspace_id='${ws}'::uuid`;
      return target.query(sql,args);
    };
  }})))};
}
async function fixture(t, execute, poll) {
  const owner=randomUUID(), ws=randomUUID(), other=randomUUID(), otherWs=randomUUID();
  const calls=[], polls=[];
  const policies=structuredClone(capabilityCatalog).map(({name, authMechanism, gateReason, ...p}) => ProviderCapabilitiesSchema.parse({...p, evidence:'live_verified', enabledForRealRequests:true, policy:{deadlineMs:1000, maxConcurrent:2, requestsPerMinute:1000, maxPolls:2, pollingCost:p.execution==='asynchronous'?'known':'not_applicable'}}));
  let validationCalls=0;
  const gateway={
    async execute(key, input, credentials, context) {
      ProviderRequestSchema.parse(input);
      assert.ok(credentials.apiKey || credentials.clientSecret, 'AAD-encrypted fixture credentials decrypt');
      calls.push({key,input:structuredClone(input)});
      const result=await (execute?execute(key,input,context):success(key,input.capability,input.capability==='email'?'ada@fixture.example':'Fixture Co'));
      NormalizedProviderResultSchema.parse(result.result); return result;
    },
    async poll(key, task, credentials, context) {
      polls.push({key,task:structuredClone(task)});
      const result=await (poll?poll(key,task,context):pending());
      NormalizedProviderResultSchema.parse(result.result); return result;
    },
    async validate() {validationCalls++; throw Error('No credential-validation requests permitted in fixtures');},
  };
  const key=randomBytes(32).toString('base64');
  t.after(async () => {
    assert.equal(validationCalls,0);
    for(const id of [ws,otherWs]) {
      await db.pool.query('DELETE FROM app.tables WHERE workspace_id=$1',[id]);
      // Source deletion intentionally retains sanitized usage; cleanup it explicitly.
      await db.pool.query('DELETE FROM app.usage_observations WHERE workspace_id=$1',[id]);
      await db.pool.query('DELETE FROM app.consumption WHERE workspace_id=$1',[id]);
      await db.pool.query('DELETE FROM app.connections WHERE workspace_id=$1',[id]);
      await db.pool.query('DELETE FROM app.workspaces WHERE id=$1',[id]);
    }
  });
  await db.pool.query('INSERT INTO app.workspaces(id,owner_id) VALUES($1,$2),($3,$4)',[ws,owner,otherWs,other]);
  const app=createApp({db,key,gateway,policies});
  const worker=new Worker(scopedWorkerDb(ws),key,gateway,policies,5000);
  const table=await app.tables.create(owner,`execution-${randomUUID()}`);
  const f={...app, worker, owner,ws,other,table,calls,polls,policies, data:()=>app.tables.read(owner,table.id)};
  f.connect=async providerKey => {
    const c=await app.connections.create(owner,{providerKey,credentials:providerKey==='snov'?{clientId:'fixture-id',clientSecret:'fixture-secret'}:{apiKey:'fixture-only-secret'},acknowledgeDirectBilling:true});
    // Restricted synthetic readiness, NOT live validation/certification evidence.
    await db.pool.query("UPDATE app.connections SET status='ready',validated_at=now(),validation_evidence_id=$2 WHERE id=$1 AND workspace_id=$3",[c.id,randomUUID(),ws]);
    return {id:c.id,revision:c.revision};
  };
  f.column=(name,definition)=>app.tables.saveColumn(owner,table.id,{name,definition});
  f.patch=async (rowId,columnId,value)=>app.tables.patch(owner,table.id,{rowId,columnId,expectedVersion:(await f.data()).rows.find(r=>r.id===rowId).cells[columnId].version,value:text(value)});
  f.preview=async ids=>app.planner.preview(owner,{tableId:table.id,expectedTableRevision:(await f.data()).table.revision,rowScope:{kind:'all'},selectedColumnIds:ids});
  f.confirm=async ids=>app.planner.confirm(owner,request(await f.preview(ids)));
  f.detail=id=>app.runs.detail(owner,id);
  f.drain=async id=> {
    for(let i=0;i<12;i++) {const d=await f.detail(id); if(['completed','canceled'].includes(d.progress.status))return d; await worker.tick();}
    assert.fail('Run did not terminalize within 12 bounded ticks');
  };
  return f;
}
async function company(t, execute) {
  const f=await fixture(t,execute);
  const domain=(await f.data()).columns[2];
  const connection=await f.connect('pdl');
  const output=await f.column('Enriched company',{kind:'company', connection, domainInput:{kind:'column',columnId:domain.id}, output:'name'});
  const row=await f.tables.addRow(f.owner,f.table.id);
  await f.patch(row.id,domain.id,'fixture.example');
  return {...f,domain,connection,output,row};
}
async function email(t, execute, poll, oneProvider=false) {
  const f=await fixture(t,execute,poll), providers=[];
  for(const providerKey of oneProvider?['snov']:['hunter','snov'])providers.push({providerKey,connection:await f.connect(providerKey),nameMapping:{mode:'mapped_parts',givenNameInput:{kind:'fixed',value:'Ada'},familyNameInput:{kind:'fixed',value:'Lovelace'},source:'owner_mapped'}});
  const output=await f.column('Discovered email',{kind:'email',domainInput:{kind:'fixed',value:'fixture.example'},providers});
  const row=await f.tables.addRow(f.owner,f.table.id);
  return {...f,output,row};
}
function outcome(detail, column) {return detail.results.find(r=>r.columnId===column.id);}
async function reservations(f) {return Number((await db.pool.query('SELECT count(*) FROM app.reservations WHERE table_id=$1',[f.table.id])).rows[0].count);}

test('manual company → formula → AI uses fresh same-run values; ordered provenance and unknown/zero usage persist', async t => {
  const f=await company(t,(key,input)=>key==='pdl'?success(key,'company','Fresh Company'):success(key,'ai',`Draft: ${input.resolvedInstructions}`,zero));
  const formula=await f.column('Upper company',{kind:'formula',expression:`UPPER(${ref(f.output.id)})`,referencedColumnIds:[f.output.id],returnType:'text'});
  const ai=await f.column('Draft',{kind:'ai',connection:await f.connect('openai'),model:'fixture-model',instructionTemplate:`Hello ${ref(formula.id)}`,referencedColumnIds:[formula.id]});
  // Import/edit/read/reopen/formula computation never authorize external work.
  const plan=await f.transfer.preview(f.owner,f.table.id,{csvText:'Person\nGrace',mappings:[{sourceIndex:0,destination:{kind:'existing',columnId:(await f.data()).columns[0].id,valueType:'text'}}]});
  await f.transfer.confirm(f.owner,plan.id,{planId:plan.id,expectedPlanRevision:plan.revision,idempotencyKey:randomUUID()});
  const imported=(await f.data()).rows.find(r=>r.id!==f.row.id);
  await f.tables.remove(f.owner,f.table.id,[imported.id]);
  await f.patch(f.row.id,f.domain.id,'fresh.example');
  await f.runs.list(f.owner,f.table.id); await f.data();
  assert.equal(f.calls.length,0);
  const preview=await f.preview([ai.id]);
  assert.deepEqual(new Set(preview.prerequisiteColumnIds),new Set([f.output.id,formula.id]));
  assert.equal(preview.maximumExternalRequests,2);
  const req=request(preview);
  const runs=await Promise.all([f.planner.confirm(f.owner,req),f.planner.confirm(f.owner,req)]);
  assert.equal(runs[0].id,runs[1].id); assert.equal(f.calls.length,0);
  const d=await f.drain(runs[0].id);
  assert.equal(d.progress.counts.succeeded,3);
  assert.deepEqual(f.calls.map(c=>c.key),['pdl','openai']);
  assert.equal(f.calls[1].input.resolvedInstructions,'Hello FRESH COMPANY');
  const output=outcome(d,ai);
  assert.equal(output.storedValue.value,'Draft: Hello FRESH COMPANY');
  assert.equal(output.provenance.providerKey,'openai'); assert.ok(output.provenance.retrievedAt);
  assert.equal(output.provenance.verificationLabel,null);
  assert.deepEqual(d.attempts.map(a=>a.id),[...outcome(d,f.output).provenance.attemptIds,...output.provenance.attemptIds]);
  const usage=await usageSummary(db,f.ws,undefined,runs[0].id);
  assert.equal(usage.externalStarts,2);
  const pdl=usage.totals.find(r=>r.providerKey==='pdl'); assert.deepEqual(pdl.units,{kind:'unknown'}); assert.deepEqual(pdl.reportedMoney,{kind:'unknown'});
  assert.ok(usage.totals.some(r=>r.providerKey==='openai'&&r.units.kind==='known'&&r.units.amount==='0'));
  assert.ok(usage.totals.some(r=>r.providerKey==='openai'&&r.reportedMoney.kind==='known'&&r.reportedMoney.amount==='0'));
  assert.equal(await reservations(f),0); assert.ok(d.progress.completedAt);
  await f.worker.tick(); await f.detail(runs[0].id); await f.data(); assert.equal(f.calls.length,2);
  await assert.rejects(f.runs.detail(f.other,runs[0].id),code('not_found'));
  await assert.rejects(f.connections.disconnect(f.other,f.connection.id),code('not_found'));
  assert.equal(JSON.stringify(d).includes('fixture-only-secret'),false);
});

for(const first of ['no_result','failed','unknown'])test(`email waterfall advances only on no_result: first=${first}`, async t => {
  const f=await email(t,key=>key==='hunter'?(first==='no_result'?noResult(key):first==='failed'?failed(key):unknown(key)):success(key,'email','ada@fixture.example',zero));
  const run=await f.confirm([f.output.id]), d=await f.drain(run.id);
  assert.equal(outcome(d,f.output).outcome,first==='no_result'?'succeeded':first);
  assert.deepEqual(f.calls.map(c=>c.key),first==='no_result'?['hunter','snov']:['hunter']);
  assert.deepEqual(d.attempts.map(a=>a.waterfallPosition),first==='no_result'?[0,1]:[0]);
  assert.deepEqual(d.attempts.map(a=>a.outcome),first==='no_result'?['no_result','succeeded']:[first]);
  await f.worker.tick(); assert.equal(f.calls.length,first==='no_result'?2:1);
});

for(const value of [null,'not a domain'])test(`missing/invalid company input skips with zero provider I/O: ${value}`,async t=>{
  const f=await company(t); await f.patch(f.row.id,f.domain.id,value);
  const preview=await f.preview([f.output.id]); assert.equal(preview.cells.skipped,1); assert.equal(preview.maximumExternalRequests,0);
  const run=await f.planner.confirm(f.owner,request(preview)); const d=await f.drain(run.id);
  assert.equal(outcome(d,f.output).outcome,'skipped'); assert.equal(f.calls.length,0); assert.equal(d.attempts.length,0);
});

for(const boundary of ['revocation','policy'])test(`${boundary} immediately before dispatch authorization stops I/O`,async t=>{
  const f=await company(t), run=await f.confirm([f.output.id]);
  const authorize=f.worker.authorize.bind(f.worker);
  f.worker.authorize=async (...args)=>{
    if(boundary==='revocation')await f.connections.disconnect(f.owner,f.connection.id);
    else f.policies.find(p=>p.providerKey==='pdl').enabledForRealRequests=false;
    return authorize(...args);
  };
  const d=await f.drain(run.id); assert.equal(outcome(d,f.output).outcome,'failed'); assert.equal(f.calls.length,0); assert.equal(d.attempts.length,0); assert.equal(await reservations(f),0);
});

test('queued cancellation prevents dispatch and releases reservations',async t=>{
  const f=await company(t),run=await f.confirm([f.output.id]); assert.equal(await reservations(f),1);
  await f.runs.cancel(f.owner,run.id); const d=await f.drain(run.id);
  assert.equal(d.progress.status,'canceled'); assert.equal(outcome(d,f.output).outcome,'canceled'); assert.equal(f.calls.length,0); assert.equal(await reservations(f),0);
});

test('cancel retains already-authorized in-flight completion but prevents queued downstream AI',async t=>{
  const entered=deferred(), release=deferred(); t.after(()=>release.resolve(success('pdl','company','Completed in flight',zero)));
  const f=await company(t,async()=>{entered.resolve();return release.promise;});
  const ai=await f.column('Draft',{kind:'ai',connection:await f.connect('openai'),model:'fixture-model',instructionTemplate:ref(f.output.id),referencedColumnIds:[f.output.id]});
  const run=await f.confirm([ai.id]), tick=f.worker.tick(); await enteredOrFailed(entered,tick);
  await f.runs.cancel(f.owner,run.id); const pending=await f.detail(run.id);
  assert.equal(pending.progress.status,'cancel_requested'); assert.equal(pending.progress.counts.running,1); assert.equal(outcome(pending,ai).outcome,'canceled');
  release.resolve(success('pdl','company','Completed in flight',zero)); await tick;
  const d=await f.drain(run.id); assert.equal(d.progress.status,'canceled'); assert.equal(outcome(d,f.output).outcome,'succeeded'); assert.equal(f.calls.length,1); assert.equal(await reservations(f),0);
});

for(const edit of ['input','settings'])test(`${edit} edited in flight marks output stale; frozen request and snapshots remain immutable`,async t=>{
  const entered=deferred(),release=deferred();t.after(()=>release.resolve(success('pdl','company','Frozen company')));
  const f=await company(t,async()=>{entered.resolve();return release.promise;});const run=await f.confirm([f.output.id]);
  const before=(await db.pool.query('SELECT values,source_versions FROM app.run_rows WHERE run_id=$1',[run.id])).rows;
  const tick=f.worker.tick(); await enteredOrFailed(entered,tick);
  if(edit==='input')await f.patch(f.row.id,f.domain.id,'edited.example');
  else await f.tables.saveColumn(f.owner,f.table.id,{expectedRevision:f.output.revision,definition:{...f.output.definition,domainInput:{kind:'fixed',value:'settings.example'}}},f.output.id);
  release.resolve(success('pdl','company','Frozen company'));await tick;const d=await f.drain(run.id);
  assert.equal(outcome(d,f.output).stale,true); assert.equal(f.calls[0].input.domain,'fixture.example');
  assert.deepEqual((await db.pool.query('SELECT values,source_versions FROM app.run_rows WHERE run_id=$1',[run.id])).rows,before);
  assert.equal(outcome(d,f.output).storedValue.value,'Frozen company'); assert.equal(f.calls.length,1);
});

test('timeout is terminal unknown with no redispatch; manual retry uses latest input and duplicate-charge consent',async t=>{
  let dispatches=0;
  const f=await company(t,async(key,input,{signal})=>{
    if(++dispatches>1)return success(key,'company',`Retried ${input.domain}`,zero);
    await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});}); return unknown(key);
  });
  const run=await f.confirm([f.output.id]),d=await f.drain(run.id);assert.equal(outcome(d,f.output).outcome,'unknown');
  for(let i=0;i<3;i++)await f.worker.tick();assert.equal(f.calls.length,1);
  await f.patch(f.row.id,f.domain.id,'retry.example');
  const preview=await f.planner.retry(f.owner,run.id,{includeOutcomes:['unknown']}); assert.equal(preview.requiredConsent.possibleDuplicateCharge,true);
  const req=request(preview);await assert.rejects(f.planner.confirm(f.owner,{...req,consent:{...consent,possibleDuplicateCharge:false}}),code('consent_required'));
  const retry=await f.planner.confirm(f.owner,req); assert.notEqual(retry.id,run.id);
  const snapshot=(await db.pool.query('SELECT values FROM app.run_rows WHERE run_id=$1',[retry.id])).rows[0]; assert.equal(snapshot.values[f.domain.id].value,'retry.example');
  const retried=await f.drain(retry.id);assert.equal(retried.progress.parentRunId,run.id);
  assert.equal(outcome(retried,f.output).storedValue.value,'Retried retry.example');assert.equal(f.calls[1].input.domain,'retry.example');assert.equal(f.calls.length,2);
  const original=await f.detail(run.id);assert.deepEqual(original.progress,d.progress);assert.deepEqual(original.attempts,d.attempts);
  assert.equal(outcome(original,f.output).outcome,'unknown');assert.equal(outcome(original,f.output).storedValue,null);
  assert.equal((await db.pool.query('SELECT values FROM app.run_rows WHERE run_id=$1',[run.id])).rows[0].values[f.domain.id].value,'fixture.example');
});

test('expired unstarted lease requeues safely; recovered dispatch intent is unknown and late response only updates usage',async t=>{
  const entered=deferred(),release=deferred();t.after(()=>release.resolve(success('pdl','company','Late forbidden cell',zero)));
  const f=await company(t,async()=>{entered.resolve();return release.promise;});const run=await f.confirm([f.output.id]);
  const job=await f.worker.claim();assert.ok(job);assert.equal(f.calls.length,0);
  await db.pool.query("UPDATE app.steps SET lease_until=now()-interval '1 second' WHERE id=$1",[job.step.id]);
  await f.worker.recover();const queued=await f.detail(run.id);assert.equal(outcome(queued,f.output).outcome,'queued');assert.equal(queued.attempts.length,0);
  const tick=f.worker.tick();await enteredOrFailed(entered,tick);
  const intent=await f.detail(run.id);assert.equal(intent.attempts[0].dispatchState,'dispatch_intent');
  await db.pool.query("UPDATE app.steps SET lease_until=now()-interval '1 second' WHERE id=$1",[job.step.id]);
  await f.worker.recover();const recovered=await f.detail(run.id);assert.equal(outcome(recovered,f.output).outcome,'unknown');assert.equal(await reservations(f),0);
  const cell=(await f.data()).rows[0].cells[f.output.id];
  release.resolve(success('pdl','company','Late forbidden cell',zero));await tick;
  assert.deepEqual(await f.detail(run.id),recovered);assert.deepEqual((await f.data()).rows[0].cells[f.output.id],cell);
  const usage=await usageSummary(db,f.ws,undefined,run.id);assert.equal(usage.externalStarts,1);assert.ok(usage.totals.some(x=>x.units.kind==='known'&&x.units.amount==='0'));
  await f.worker.tick();assert.equal(f.calls.length,1);
});

test('overlapping reservation blocks confirmation and terminal completion releases it for safe fresh reuse',async t=>{
  const f=await company(t),run=await f.confirm([f.output.id]);const preview=await f.preview([f.output.id]);assert.ok(preview.blockers.includes('active_work'));
  await assert.rejects(f.planner.confirm(f.owner,request(preview)),code('provider_not_ready'));assert.equal(f.calls.length,0);assert.equal(await reservations(f),1);
  await f.drain(run.id);assert.equal(await reservations(f),0);
  const reused=await f.preview([f.output.id]);assert.deepEqual(reused.blockers,[]);assert.equal(reused.cells.reused,1);
  const second=await f.planner.confirm(f.owner,request(reused));const d=await f.drain(second.id);assert.equal(outcome(d,f.output).outcome,'reused');assert.ok(outcome(d,f.output).sourceResultId);assert.equal(f.calls.length,1);
});

test('rate-bound second waterfall provider must fail, never requeue/restart previously called provider',async t=>{
  const f=await email(t,key=>key==='hunter'?noResult(key):success(key,'email','ada@fixture.example'));
  const run=await f.confirm([f.output.id]);f.policies.find(p=>p.providerKey==='snov').policy.requestsPerMinute=0; // Force boundary after valid preview/confirmation.
  const d=await f.drain(run.id);assert.equal(outcome(d,f.output).outcome,'failed');assert.deepEqual(f.calls.map(c=>c.key),['hunter']);assert.equal(await reservations(f),0);
  f.policies.find(p=>p.providerKey==='snov').policy.requestsPerMinute=1000;
  for(let i=0;i<3;i++)await f.worker.tick();assert.deepEqual(f.calls.map(c=>c.key),['hunter']);
});

test('async task is persisted before retrieval and bounded to two polls without a second lookup start',async t=>{
  let f;
  f=await email(t,()=>pending(),async(key,task)=>{
    const taskRows=(await db.pool.query("SELECT a.task FROM app.attempts a JOIN app.steps s ON s.id=a.step_id WHERE s.table_id=$1",[f.table.id])).rows;
    assert.deepEqual(taskRows[0].task,task);return pending();
  },true);
  const run=await f.confirm([f.output.id]);const preview=(await f.preview([f.output.id]));assert.equal(preview.maximumExternalRequests,3);
  const d=await f.drain(run.id);assert.equal(outcome(d,f.output).outcome,'unknown');assert.equal(f.calls.length,1);assert.equal(f.polls.length,2);
  assert.deepEqual(f.polls.map(p=>p.task.taskId),['fixture-task','fixture-task']);assert.equal(d.attempts.length,1);assert.equal((await usageSummary(db,f.ws,undefined,run.id)).externalStarts,1);
  await f.worker.tick();assert.equal(f.polls.length,2);
});

test('cancel during an in-flight async poll allows its completion but authorizes no subsequent poll',async t=>{
  const entered=deferred(),release=deferred();t.after(()=>release.resolve(pending()));
  const f=await email(t,()=>pending(),async()=>{entered.resolve();return release.promise;},true);
  const run=await f.confirm([f.output.id]),tick=f.worker.tick();await enteredOrFailed(entered,tick);await f.runs.cancel(f.owner,run.id);release.resolve(pending());await tick;
  const d=await f.drain(run.id);assert.equal(d.progress.status,'canceled');assert.equal(outcome(d,f.output).outcome,'unknown');assert.equal(f.calls.length,1);assert.equal(f.polls.length,1);await f.worker.tick();assert.equal(f.polls.length,1);
});

test('cancel after async authorization but during poll wait must not issue a new poll',async t=>{
  const f=await email(t,()=>pending(),()=>pending(),true);const run=await f.confirm([f.output.id]);
  // Observe the actual authorization transaction (not a wall-clock race), then
  // commit cancellation while the production worker awaits its 50ms poll delay.
  const original=f.worker.db.transaction;const authorized=deferred();let armed=true;
  f.worker.db.transaction=async fn=>{
    const value=await original(fn);
    if(armed&&value===true){armed=false;authorized.resolve();await f.runs.cancel(f.owner,run.id);}
    return value;
  };
  const tick=f.worker.tick();await enteredOrFailed(authorized,tick);await tick;const d=await f.drain(run.id);
  assert.equal(d.progress.status,'canceled');assert.equal(outcome(d,f.output).outcome,'unknown');assert.equal(f.calls.length,1);
  assert.equal(f.polls.length,0,'REGRESSION: poll issued after cancellation committed during the authorization-to-poll wait');
});
