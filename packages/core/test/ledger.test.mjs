import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {Database, ServiceError} from '../dist/db.js';
import {migrate} from '../dist/migrate.js';
import {recordObservation, recordObservationTx, usageSummary} from '../dist/ledger.js';

const db=new Database(process.env.DATABASE_URL??'postgresql://leadwork:leadwork-local-only@localhost:5432/leadwork');
const unknown={kind:'unknown'};
const units=(amount,unitKind='credits')=>({kind:'known',amount,unitKind});
const money=(amount,currency='USD')=>({kind:'known',amount,currency});
before(async()=>{await migrate(db);});
after(async()=>{await db.close();});
async function fixture(t) {
  const workspaceId=randomUUID();
  await db.pool.query('INSERT INTO app.workspaces(id,owner_id) VALUES($1,$2)',[workspaceId,randomUUID()]);
  t.after(async()=>{
    // No schema reset, TRUNCATE, or deletion of another test/worker's data.
    await db.pool.query('DELETE FROM app.usage_observations WHERE workspace_id=$1',[workspaceId]);
    await db.pool.query('DELETE FROM app.consumption WHERE workspace_id=$1',[workspaceId]);
    await db.pool.query('DELETE FROM app.tables WHERE workspace_id=$1',[workspaceId]);
    await db.pool.query('DELETE FROM app.connections WHERE workspace_id=$1',[workspaceId]);
    await db.pool.query('DELETE FROM app.workspaces WHERE id=$1',[workspaceId]);
  });
  const observation=(patch={})=>({
    id:randomUUID(),attributionKey:randomUUID(),runId:null,attemptId:null,providerKey:'pdl',capability:'company',
    observedAt:'2026-11-14T12:00:00Z',sourceObservationKey:randomUUID(),sourceRevision:null,
    semantics:'unknown',units:unknown,reportedMoney:unknown,estimatedMoney:unknown,...patch,
  });
  return {workspaceId,observation};
}
async function runFixture(workspaceId) {
  const tableId=randomUUID(),rowId=randomUUID(),columnId=randomUUID(),runId=randomUUID(),stepId=randomUUID(),attemptId=randomUUID(),connectionId=randomUUID();
  await db.pool.query('INSERT INTO app.tables(id,workspace_id,name) VALUES($1,$2,$3)',[tableId,workspaceId,'ledger test']);
  await db.pool.query('INSERT INTO app.rows(id,table_id) VALUES($1,$2)',[rowId,tableId]);
  await db.pool.query('INSERT INTO app.columns(id,table_id,name,position,definition) VALUES($1,$2,$3,0,$4)',[columnId,tableId,'value',{}]);
  await db.pool.query("INSERT INTO app.runs(id,workspace_id,table_id,status,idempotency_key,request_fingerprint,snapshot,completed_at) VALUES($1,$2,$3,'completed',$4,$5,$6,now())",[runId,workspaceId,tableId,randomUUID(),'a'.repeat(64),{}]);
  await db.pool.query("INSERT INTO app.steps(id,run_id,table_id,row_id,column_id,outcome,reason) VALUES($1,$2,$3,$4,$5,'unknown','request_unknown')",[stepId,runId,tableId,rowId,columnId]);
  await db.pool.query("INSERT INTO app.connections(id,workspace_id,provider_key,status,ciphertext) VALUES($1,$2,'pdl','ready','fixture-only')",[connectionId,workspaceId]);
  await db.pool.query("INSERT INTO app.attempts(id,step_id,connection_id,connection_revision,provider_key,position,dispatch_state,deadline_at) VALUES($1,$2,$3,1,'pdl',0,'unknown',now())",[attemptId,stepId,connectionId]);
  await db.pool.query("INSERT INTO app.cells(row_id,column_id,table_id,value,outcome,version) VALUES($1,$2,$3,$4,'unknown',7)",[rowId,columnId,tableId,{type:'text',value:null}]);
  return {tableId,rowId,columnId,runId,stepId,attemptId};
}
const unitTotal=s=>s.totals.find(x=>x.units.kind==='known')?.units;
const reported=(s,currency='USD')=>s.totals.find(x=>x.reportedMoney.kind==='known' && x.reportedMoney.currency===currency)?.reportedMoney;
const safeError=code=>error=>error instanceof ServiceError && error.error.code===code && !error.message.includes('SQL');

test('deduplicates source keys and serializes concurrent delta writes; NUMERIC is exact',async t=>{
  const f=await fixture(t),attributionKey=randomUUID();
  const a=f.observation({attributionKey,semantics:'delta',units:units('9007199254740993.123456789012345678901'),reportedMoney:money('0.100000000000000000001')});
  await Promise.all(Array.from({length:8},()=>recordObservation(db,f.workspaceId,{...a,id:randomUUID()})));
  await recordObservation(db,f.workspaceId,f.observation({attributionKey,semantics:'delta',units:units('0.000000000000000000009'),reportedMoney:money('0.200000000000000000002')}));
  const s=await usageSummary(db,f.workspaceId,'2026-11');
  assert.equal(s.externalStarts,1);
  assert.equal(unitTotal(s).amount,'9007199254740993.123456789012345678910');
  assert.equal(reported(s).amount,'0.300000000000000000003');
  assert.ok(s.totals.every(x=>x.unknownAttempts===0));
  assert.equal((await db.pool.query('SELECT count(*) FROM app.usage_observations WHERE workspace_id=$1',[f.workspaceId])).rows[0].count,'2');
});

test('cumulative reports supersede only newer revisions, including known zero and old corrections',async t=>{
  const f=await fixture(t),attributionKey=randomUUID();
  const send=(sourceRevision,amount,observedAt='2026-11-14T12:00:00Z')=>recordObservation(db,f.workspaceId,f.observation({attributionKey,semantics:'cumulative',sourceRevision,observedAt,units:units(amount),reportedMoney:money(amount)}));
  await send('2','10');await send('1','100','2026-11-15T12:00:00Z');await send('2','999','2026-11-16T12:00:00Z');
  let s=await usageSummary(db,f.workspaceId,'2026-11');assert.equal(unitTotal(s).amount,'10');
  await send('3','0');await send('1','500','2026-12-20T12:00:00Z');
  s=await usageSummary(db,f.workspaceId,'2026-11');assert.deepEqual(unitTotal(s),units('0'));assert.deepEqual(reported(s),money('0'));assert.equal(s.externalStarts,1);
  assert.equal((await usageSummary(db,f.workspaceId,'2026-12')).externalStarts,0);
  assert.equal((await db.pool.query('SELECT count(*) FROM app.usage_observations WHERE workspace_id=$1',[f.workspaceId])).rows[0].count,'5');
});

test('a cumulative checkpoint covers older deltas; later deltas contribute once',async t=>{
  const f=await fixture(t),attributionKey=randomUUID();
  const send=(semantics,sourceRevision,amount)=>recordObservation(db,f.workspaceId,f.observation({attributionKey,semantics,sourceRevision,units:units(amount)}));
  await send('delta','1','2');await send('cumulative','2','5');await send('delta','3','1');
  assert.equal(unitTotal(await usageSummary(db,f.workspaceId,'2026-11')).amount,'6');
  await send('cumulative','4','8');await send('delta','1','2');
  assert.equal(unitTotal(await usageSummary(db,f.workspaceId,'2026-11')).amount,'8');
});

test('unknown is never zero; estimates do not become charges; confirmed data removes placeholders',async t=>{
  const f=await fixture(t),attributionKey=randomUUID();
  await recordObservation(db,f.workspaceId,f.observation({attributionKey}));
  let s=await usageSummary(db,f.workspaceId,'2026-11');
  assert.equal(s.externalStarts,1);assert.deepEqual(s.totals[0].units,unknown);assert.deepEqual(s.totals[0].reportedMoney,unknown);assert.equal(s.totals[0].unknownAttempts,1);
  await recordObservation(db,f.workspaceId,f.observation({attributionKey,semantics:'estimate',estimatedMoney:money('3.25')}));
  s=await usageSummary(db,f.workspaceId,'2026-11');assert.equal(s.totals.length,1);assert.deepEqual(s.totals[0].estimatedMoney,money('3.25'));assert.deepEqual(s.totals[0].reportedMoney,unknown);
  await recordObservation(db,f.workspaceId,f.observation({attributionKey,semantics:'cumulative',sourceRevision:'1',units:units('0'),reportedMoney:money('0')}));
  s=await usageSummary(db,f.workspaceId,'2026-11');assert.equal(s.externalStarts,1);assert.equal(s.totals.length,2);assert.deepEqual(unitTotal(s),units('0'));assert.deepEqual(reported(s),money('0'));assert.ok(s.totals.every(x=>x.unknownAttempts===0));
  assert.equal((await db.pool.query("SELECT count(*) FROM app.consumption WHERE workspace_id=$1 AND unit_kind='' AND currency=''",[f.workspaceId])).rows[0].count,'0');
});

test('separates incompatible unit and currency dimensions without multiplying quantities',async t=>{
  const f=await fixture(t),attributionKey=randomUUID();
  await recordObservation(db,f.workspaceId,f.observation({attributionKey,semantics:'delta',units:units('2','credits'),reportedMoney:money('1','USD')}));
  await recordObservation(db,f.workspaceId,f.observation({attributionKey,semantics:'delta',units:units('3','tokens'),reportedMoney:money('2','EUR')}));
  await recordObservation(db,f.workspaceId,f.observation({attributionKey,semantics:'delta',units:units('4','credits'),reportedMoney:money('3','EUR')}));
  const s=await usageSummary(db,f.workspaceId,'2026-11');
  assert.equal(s.externalStarts,1);assert.equal(s.totals.length,4);
  assert.deepEqual(s.totals.filter(x=>x.units.kind==='known').map(x=>x.units).sort((a,b)=>a.unitKind.localeCompare(b.unitKind)),[units('6'),units('3','tokens')]);
  assert.deepEqual(reported(s,'USD'),money('1','USD'));assert.deepEqual(reported(s,'EUR'),money('5','EUR'));
});

test('partial aggregates retain known quantities and flag missing consumption',async t=>{
  const f=await fixture(t);
  await recordObservation(db,f.workspaceId,f.observation({semantics:'delta',units:units('2'),reportedMoney:money('1')}));
  await recordObservation(db,f.workspaceId,f.observation({semantics:'delta',units:units('3')}));
  await recordObservation(db,f.workspaceId,f.observation({semantics:'estimate',estimatedMoney:money('2')}));
  const s=await usageSummary(db,f.workspaceId,'2026-11');assert.equal(s.externalStarts,3);assert.equal(unitTotal(s).amount,'5');assert.equal(reported(s).amount,'1');assert.ok(s.totals.every(x=>x.unknownAttempts===1));
});

test('enforces UTC calendar bounds and unique attribution counts instead of poll counts',async t=>{
  const f=await fixture(t),attributionKey=randomUUID();
  for(const observedAt of ['2026-10-31T23:59:59.999Z','2026-12-01T00:00:00Z','2026-11-01T01:00:00+02:00']) await recordObservation(db,f.workspaceId,f.observation({observedAt}));
  await recordObservation(db,f.workspaceId,f.observation({attributionKey,observedAt:'2026-11-01T00:00:00Z'}));
  for(let i=0;i<3;i++) await recordObservation(db,f.workspaceId,f.observation({attributionKey,observedAt:'2026-12-01T00:00:00Z',semantics:'cumulative',sourceRevision:String(i),units:units(String(i))}));
  const s=await usageSummary(db,f.workspaceId,'2026-11');assert.equal(s.periodStart,'2026-11-01T00:00:00.000Z');assert.equal(s.periodEnd,'2026-12-01T00:00:00.000Z');assert.equal(s.externalStarts,1);
  assert.equal((await usageSummary(db,f.workspaceId,'2026-10')).externalStarts,2);
  assert.equal((await usageSummary(db,f.workspaceId,'2026-12')).externalStarts,1);
  const current=await usageSummary(db,f.workspaceId);assert.equal(current.periodStart.slice(0,7),new Date().toISOString().slice(0,7));
  for(const month of ['2026-00','2026-13','2026-1','2026-11-01','0000-01','9999-12']) await assert.rejects(usageSummary(db,f.workspaceId,month),safeError('invalid_value'));
});

test('strict validation and ownership reject foreign run/attempt references without writes',async t=>{
  const f=await fixture(t),other=await fixture(t),a=await runFixture(f.workspaceId),b=await runFixture(other.workspaceId);
  for(const patch of [{runId:b.runId},{attemptId:b.attemptId},{runId:a.runId,attemptId:b.attemptId}]) await assert.rejects(recordObservation(db,f.workspaceId,f.observation(patch)),safeError('not_found'));
  const a2=await runFixture(f.workspaceId);
  await assert.rejects(recordObservation(db,f.workspaceId,f.observation({runId:a.runId,attemptId:a2.attemptId})),safeError('invalid_value'));
  await assert.rejects(usageSummary(db,f.workspaceId,'2026-11',b.runId),safeError('not_found'));
  await assert.rejects(recordObservation(db,f.workspaceId,{...f.observation(),leadEmail:'never store'}),safeError('invalid_value'));
  await assert.rejects(recordObservation(db,f.workspaceId,f.observation({semantics:'estimate',reportedMoney:money('1')})),safeError('invalid_value'));
  await assert.rejects(recordObservation(db,f.workspaceId,f.observation({sourceRevision:'9223372036854775808'})),safeError('invalid_value'));
  assert.equal((await usageSummary(db,f.workspaceId,'2026-11')).externalStarts,0);
  const good=f.observation({runId:a.runId,attemptId:a.attemptId});await recordObservation(db,f.workspaceId,good);
  await assert.rejects(recordObservation(db,f.workspaceId,f.observation({attributionKey:good.attributionKey,runId:a2.runId})),safeError('invalid_value'));
  assert.equal((await usageSummary(db,f.workspaceId,'2026-11',a.runId)).externalStarts,1);
  assert.equal((await usageSummary(db,f.workspaceId,'2026-11',a2.runId)).externalStarts,0);
});

test('transaction recording rolls back with caller and late usage never reopens run or updates cells',async t=>{
  const f=await fixture(t),r=await runFixture(f.workspaceId),attributionKey=randomUUID();
  const beforeState=async()=>({
    run:(await db.pool.query('SELECT * FROM app.runs WHERE id=$1',[r.runId])).rows[0],
    step:(await db.pool.query('SELECT * FROM app.steps WHERE id=$1',[r.stepId])).rows[0],
    cell:(await db.pool.query('SELECT * FROM app.cells WHERE row_id=$1 AND column_id=$2',[r.rowId,r.columnId])).rows[0],
    attempt:(await db.pool.query('SELECT * FROM app.attempts WHERE id=$1',[r.attemptId])).rows[0],
  });
  const state=await beforeState();
  await assert.rejects(db.transaction(async tx=>{await recordObservationTx(tx,f.workspaceId,f.observation({runId:r.runId,attemptId:r.attemptId,attributionKey}));throw new Error('fixture rollback');}),/fixture rollback/);
  assert.equal((await usageSummary(db,f.workspaceId,'2026-11')).externalStarts,0);
  await db.transaction(async tx=>{
    await tx.query('SELECT id FROM app.steps WHERE id=$1 FOR UPDATE',[r.stepId]);
    await recordObservationTx(tx,f.workspaceId,f.observation({runId:r.runId,attemptId:r.attemptId,attributionKey}));
  });
  await recordObservation(db,f.workspaceId,f.observation({runId:r.runId,attemptId:r.attemptId,attributionKey,observedAt:'2026-12-03T00:00:00Z',semantics:'cumulative',sourceRevision:'1',units:units('5'),reportedMoney:money('0.5')}));
  assert.deepEqual(await beforeState(),state);
  const s=await usageSummary(db,f.workspaceId,'2026-11',r.runId);assert.equal(s.externalStarts,1);assert.equal(unitTotal(s).amount,'5');
  // FK redaction on table deletion retains only sanitized usage attribution.
  await db.pool.query('DELETE FROM app.tables WHERE id=$1',[r.tableId]);
  assert.equal((await usageSummary(db,f.workspaceId,'2026-11')).externalStarts,1);
  const records=(await db.pool.query('SELECT run_id,attempt_id FROM app.usage_observations WHERE workspace_id=$1',[f.workspaceId])).rows;
  assert.ok(records.every(x=>x.run_id===null && x.attempt_id===null));
  await assert.rejects(usageSummary(db,f.workspaceId,'2026-11',r.runId),safeError('not_found'));
});


test('placeholder replacement preserves the original month even for an older late report',async t=>{
  const f=await fixture(t),attributionKey=randomUUID();
  await recordObservation(db,f.workspaceId,f.observation({attributionKey}));
  await recordObservation(db,f.workspaceId,f.observation({attributionKey,observedAt:'2026-10-01T00:00:00Z',semantics:'cumulative',sourceRevision:'1',units:units('1')}));
  assert.equal((await usageSummary(db,f.workspaceId,'2026-11')).externalStarts,1);
  assert.equal((await usageSummary(db,f.workspaceId,'2026-10')).externalStarts,0);
});

test('rejects a dual-currency history record rather than assigning an estimate the wrong currency',async t=>{
  const f=await fixture(t);
  await assert.rejects(recordObservation(db,f.workspaceId,f.observation({semantics:'cumulative',reportedMoney:money('1','USD'),estimatedMoney:money('2','EUR')})),safeError('invalid_value'));
  assert.equal((await usageSummary(db,f.workspaceId,'2026-11')).externalStarts,0);
});
