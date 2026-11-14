import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after, before, test} from 'node:test';
import {Database, ServiceError} from '../dist/db.js';
import {migrate} from '../dist/migrate.js';
import {TableService} from '../dist/tables.js';
import {TransferService} from '../dist/transfer.js';
import {Planner} from '../dist/planner.js';
import {capabilityCatalog} from '../../providers/dist/catalog.js';

const db = new Database(process.env.DATABASE_URL ?? 'postgresql://leadwork:leadwork-local-only@localhost:5432/leadwork');
const tables = new TableService(db);
const transfer = new TransferService(db);
const planner = new Planner(db, capabilityCatalog);
const text = value => ({type:'text', value});
const number = value => ({type:'number', value});
const ref = id => `{{${id}}}`;
const formula = (expression, referencedColumnIds, returnType='text') => ({kind:'formula', expression, referencedColumnIds, returnType});
const code = expected => error => error instanceof ServiceError && error.error.code === expected;
const domainCode = expected => error => error.code === expected;
const consent = {overwritePopulated:true, refreshStale:true, unknownPrice:true, possibleDuplicateCharge:true};
const importRequest = plan => ({planId:plan.id, expectedPlanRevision:plan.revision, idempotencyKey:randomUUID()});
const runRequest = preview => ({previewId:preview.id, expectedPreviewRevision:preview.revision, idempotencyKey:randomUUID(), consent});

before(async () => { await migrate(db); });
after(async () => { await db.close(); });

async function fixture(t) {
  const owner = randomUUID(), other = randomUUID();
  const ws = randomUUID(), otherWs = randomUUID();
  // Register cleanup before the first write; every DELETE is fixture-scoped.
  t.after(async () => {
    for (const id of [ws, otherWs]) {
      await db.pool.query('DELETE FROM app.usage_observations WHERE workspace_id=$1', [id]);
      await db.pool.query('DELETE FROM app.consumption WHERE workspace_id=$1', [id]);
      await db.pool.query('DELETE FROM app.tables WHERE workspace_id=$1', [id]);
      await db.pool.query('DELETE FROM app.connections WHERE workspace_id=$1', [id]);
      await db.pool.query('DELETE FROM app.workspaces WHERE id=$1', [id]);
    }
  });
  await db.pool.query('INSERT INTO app.workspaces(id,owner_id) VALUES($1,$2),($3,$4)', [ws,owner,otherWs,other]);
  const table = await tables.create(owner, `persistence-${randomUUID()}`);
  return {owner,other,ws,otherWs,table, data:() => tables.read(owner,table.id)};
}
async function patch(f, rowId, columnId, value) {
  const data = await f.data();
  return tables.patch(f.owner, f.table.id, {rowId,columnId,expectedVersion:data.rows.find(r=>r.id===rowId).cells[columnId].version,value});
}
async function runPreview(f, selectedColumnIds, rowScope={kind:'all'}) {
  return planner.preview(f.owner,{tableId:f.table.id,expectedTableRevision:(await f.data()).table.revision,rowScope,selectedColumnIds});
}
async function count(table, tableId) {
  // Table names are internal constants, never user input.
  return Number((await db.pool.query(`SELECT count(*) FROM app.${table} WHERE table_id=$1`,[tableId])).rows[0].count);
}
async function persistenceState(tableId) {
  return (await db.pool.query(`SELECT row_count,column_count,revision,
    (SELECT count(*) FROM app.rows WHERE table_id=t.id) AS rows,
    (SELECT count(*) FROM app.cells WHERE table_id=t.id) AS cells,
    (SELECT count(*) FROM app.columns WHERE table_id=t.id) AS columns,
    (SELECT count(*) FROM app.runs WHERE table_id=t.id) AS runs,
    (SELECT count(*) FROM app.steps WHERE table_id=t.id) AS steps,
    (SELECT count(*) FROM app.reservations WHERE table_id=t.id) AS reservations
    FROM app.tables t WHERE id=$1`,[tableId])).rows[0];
}
async function bulkRows(tableId, n) {
  const ids = Array.from({length:n},randomUUID);
  // One bulk SQL statement, with real row triggers; no fake capacity counters.
  await db.pool.query('INSERT INTO app.rows(id,table_id) SELECT unnest($1::uuid[]),$2::uuid',[ids,tableId]);
  return ids;
}
async function bulkColumns(tableId, n, offset=4) {
  const columns = Array.from({length:n},(_,i)=>({id:randomUUID(),name:`capacity-${i}-${randomUUID()}`,position:offset+i,definition:{kind:'editable',valueType:'text'}}));
  await db.pool.query(`INSERT INTO app.columns(id,table_id,name,position,definition)
    SELECT id,$2::uuid,name,position,definition FROM jsonb_to_recordset($1::jsonb)
    AS c(id uuid,name text,position int,definition jsonb)`,[JSON.stringify(columns),tableId]);
  return columns;
}
async function rollbackReject(sql, args, expected) {
  await assert.rejects(db.transaction(async tx => { await tx.query(sql,args); throw new Error('negative SQL unexpectedly succeeded'); }), expected);
}
const fkViolation = error => error.code === '23503';
const capacityViolation = error => error.code === '23514';

// No index.js import: worker/API exports can evolve independently of these tests.
test('new private tables have four editable defaults and deny a second owner every access path', async t => {
  const f = await fixture(t), data = await f.data();
  assert.deepEqual(data.columns.map(c=>c.name),['Person name','Company name','Company domain','Email address']);
  assert.ok(data.columns.every(c=>c.definition.kind==='editable' && c.definition.valueType==='text'));
  assert.deepEqual(data.rows,[]);
  assert.deepEqual(data.view.visibleColumnIds,data.columns.map(c=>c.id));
  assert.equal((await tables.list(f.other)).length,0);
  assert.equal((await tables.list(f.owner))[0].id,f.table.id);
  const row = await tables.addRow(f.owner,f.table.id), col = data.columns[0];
  const staged = await transfer.preview(f.owner,f.table.id,{csvText:'Name\nPrivate',mappings:[{sourceIndex:0,destination:{kind:'existing',columnId:col.id,valueType:'text'}}]});
  const output = await tables.saveColumn(f.owner,f.table.id,{name:'Private formula',definition:formula('"private"',[])});
  const preview = await runPreview(f,[output.id]);
  const saved = await persistenceState(f.table.id);
  for (const action of [
    () => tables.read(f.other,f.table.id),
    () => tables.addRow(f.other,f.table.id),
    () => tables.patch(f.other,f.table.id,{rowId:row.id,columnId:col.id,expectedVersion:'1',value:text('intruder')}),
    () => tables.saveColumn(f.other,f.table.id,{name:'intruder',definition:{kind:'editable',valueType:'text'}}),
    () => tables.saveView(f.other,f.table.id,data.view),
    () => tables.deleteColumn(f.other,f.table.id,col.id,col.revision),
    () => tables.remove(f.other,f.table.id,[row.id]),
    () => tables.remove(f.other,f.table.id),
    () => transfer.preview(f.other,f.table.id,{csvText:'Name\nintruder',mappings:staged.mappings}),
    () => transfer.correct(f.other,staged.id,{expectedPlanRevision:staged.revision,headers:['intruder']}),
    () => transfer.confirm(f.other,staged.id,importRequest(staged)),
    () => transfer.export(f.other,f.table.id,{tableId:f.table.id,rowScope:{kind:'all'},columnIds:[col.id],expectedViewRevision:'1',acknowledgeStoredOutputWarnings:true,neutralizeSpreadsheetText:true}),
    () => planner.preview(f.other,{tableId:f.table.id,expectedTableRevision:(preview.expectedTableRevision),rowScope:{kind:'all'},selectedColumnIds:[output.id]}),
    () => planner.confirm(f.other,runRequest(preview)),
  ]) await assert.rejects(action(),code('not_found'));
  assert.deepEqual(await persistenceState(f.table.id),saved);
});

test('CAS conflicts expose the current value and formula dependencies recompute after edits', async t => {
  const f = await fixture(t), source = (await f.data()).columns[0];
  const row = await tables.addRow(f.owner,f.table.id);
  const output = await tables.saveColumn(f.owner,f.table.id,{name:'Upper',definition:formula(`UPPER(${ref(source.id)})`,[source.id])});
  const next = await patch(f,row.id,source.id,text('Ada'));
  assert.equal(next.version,'2');
  assert.deepEqual((await f.data()).rows[0].cells[output.id].value,text('ADA'));
  await assert.rejects(tables.patch(f.owner,f.table.id,{rowId:row.id,columnId:source.id,expectedVersion:'1',value:text('lost update')}),error=>{
    assert.ok(code('version_conflict')(error));
    assert.deepEqual(error.extra.current,next);
    return true;
  });
  await patch(f,row.id,source.id,text('Grace'));
  const cell = (await f.data()).rows[0].cells[output.id];
  assert.deepEqual(cell.value,text('GRACE'));
  assert.equal(cell.outcome,'succeeded');
  assert.equal(cell.stale,false);
});

test('saved views filter and sort exact decimal numbers, paginate ties, and reject stale cursors', async t => {
  const f = await fixture(t);
  const col = await tables.saveColumn(f.owner,f.table.id,{name:'Exact number',definition:{kind:'editable',valueType:'number'}});
  const amounts = ['9007199254740993','2','10','9007199254740992','2',null];
  const ids = [];
  for (const amount of amounts) {
    const row = await tables.addRow(f.owner,f.table.id); ids.push(row.id);
    if (amount!==null) await patch(f,row.id,col.id,number(amount));
  }
  let view = (await f.data()).view;
  view = await tables.saveView(f.owner,f.table.id,{...view,filters:[{columnId:col.id,operator:'greater_than',value:number('1')}],sort:[{columnId:col.id,direction:'asc'}]});
  const pages = [];
  let cursor;
  do {
    const page = await tables.read(f.owner,f.table.id,cursor,2);
    pages.push(...page.rows.map(r=>r.id)); cursor = page.nextCursor;
  } while(cursor);
  assert.deepEqual(pages,[ids[1],ids[4],ids[2],ids[3],ids[0]]);
  const first = await tables.read(f.owner,f.table.id,undefined,2);
  await tables.saveView(f.owner,f.table.id,{...view,filters:[{columnId:col.id,operator:'equals',value:number('9007199254740993')}]});
  assert.deepEqual((await f.data()).rows.map(r=>r.id),[ids[0]]);
  await assert.rejects(tables.read(f.owner,f.table.id,first.nextCursor,2),code('version_conflict'));
  await assert.rejects(tables.read(f.owner,f.table.id,'not-a-cursor',2),code('invalid_value'));
  const current = (await f.data()).view;
  await tables.saveView(f.owner,f.table.id,{...current,filters:[]});
  const page = await tables.read(f.owner,f.table.id,undefined,2);
  await patch(f,ids[1],col.id,number('3'));
  await assert.rejects(tables.read(f.owner,f.table.id,page.nextCursor,2),code('version_conflict'));
});

test('CSV headers and invalid values correct the same staged plan and exact retries never append twice', async t => {
  const f = await fixture(t), beforeState = await persistenceState(f.table.id);
  let plan = await transfer.preview(f.owner,f.table.id,{csvText:',Value\nAda,not-a-number',mappings:[
    {sourceIndex:0,destination:{kind:'existing',columnId:(await f.data()).columns[0].id,valueType:'text'}},
    {sourceIndex:1,destination:{kind:'new',name:'Imported number',valueType:'number'}},
  ]});
  const id = plan.id, fingerprint = plan.sourceFingerprint;
  assert.equal(plan.state,'needs_correction');
  assert.ok(plan.issues.some(i=>i.code==='blank_header'));
  assert.ok(plan.issues.some(i=>i.code==='invalid_number'));
  await assert.rejects(transfer.confirm(f.owner,id,importRequest(plan)),code('invalid_mapping'));
  assert.deepEqual(await persistenceState(f.table.id),beforeState);
  plan = await transfer.correct(f.owner,id,{expectedPlanRevision:plan.revision,headers:['Name','Value'],corrections:[{rowIndex:0,sourceIndex:1,replacementText:'9007199254740993.125'}]});
  assert.equal(plan.id,id); assert.equal(plan.revision,'2'); assert.equal(plan.state,'ready');
  assert.deepEqual(plan.issues,[]); assert.notEqual(plan.sourceFingerprint,fingerprint);
  assert.equal(await count('plans',f.table.id),1);
  await assert.rejects(transfer.correct(f.owner,id,{expectedPlanRevision:'1',headers:['Name','Value']}),code('version_conflict'));
  const request = importRequest(plan);
  const results = await Promise.all(Array.from({length:4},()=>transfer.confirm(f.owner,id,request)));
  const result = results[0];
  for (const retry of results) assert.deepEqual(retry,result);
  assert.deepEqual(await transfer.confirm(f.owner,id,request),result);
  await assert.rejects(transfer.confirm(f.owner,id,{...request,idempotencyKey:randomUUID()}),code('idempotency_conflict'));
  await assert.rejects(transfer.confirm(f.owner,id,{...request,expectedPlanRevision:'1'}),code('idempotency_conflict'));
  const data = await f.data();
  assert.equal(data.table.rowCount,1); assert.equal(data.table.columnCount,5);
  assert.deepEqual(data.rows[0].cells[result.createdColumnIds[0]].value,number('9007199254740993.125'));
  assert.equal(await count('cells',f.table.id),5);
});

test('capacity is enforced at 5000 rows and 50 columns by both service and SQL, without partial writes', async t => {
  const f = await fixture(t);
  await bulkRows(f.table.id,5000);
  await bulkColumns(f.table.id,46);
  const saved = await persistenceState(f.table.id);
  assert.equal(saved.row_count,5000); assert.equal(saved.column_count,50);
  await assert.rejects(tables.addRow(f.owner,f.table.id),code('capacity_exceeded'));
  await assert.rejects(tables.saveColumn(f.owner,f.table.id,{name:'51st',definition:{kind:'editable',valueType:'text'}}),code('capacity_exceeded'));
  await rollbackReject('INSERT INTO app.rows(id,table_id) VALUES($1,$2)',[randomUUID(),f.table.id],capacityViolation);
  await rollbackReject('INSERT INTO app.columns(id,table_id,name,position,definition) VALUES($1,$2,$3,50,$4)',[randomUUID(),f.table.id,'51st SQL',{kind:'editable',valueType:'text'}],capacityViolation);
  assert.deepEqual(await persistenceState(f.table.id),saved);
});

test('failed import confirmation at row capacity is atomic and the same uncommitted request can retry', async t => {
  const f = await fixture(t);
  const mapping = {sourceIndex:0,destination:{kind:'new',name:'Atomic new column',valueType:'text'}};
  const plan = await transfer.preview(f.owner,f.table.id,{csvText:'New\nkept',mappings:[mapping]});
  const request = importRequest(plan);
  const ids = await bulkRows(f.table.id,5000); // SQL changes capacity without touching table revision.
  const saved = await persistenceState(f.table.id);
  const planBefore = (await db.pool.query('SELECT * FROM app.plans WHERE id=$1',[plan.id])).rows[0];
  await assert.rejects(transfer.confirm(f.owner,plan.id,request),code('capacity_exceeded'));
  assert.deepEqual(await persistenceState(f.table.id),saved);
  assert.deepEqual((await db.pool.query('SELECT * FROM app.plans WHERE id=$1',[plan.id])).rows[0],planBefore);
  await db.pool.query('DELETE FROM app.rows WHERE id=$1 AND table_id=$2',[ids[0],f.table.id]);
  const result = await transfer.confirm(f.owner,plan.id,request);
  assert.equal(result.appendedRows,1); assert.equal(result.createdColumnIds.length,1);
  assert.deepEqual(await transfer.confirm(f.owner,plan.id,request),result);
  assert.equal((await persistenceState(f.table.id)).row_count,5000);
  await assert.rejects(transfer.confirm(f.owner,plan.id,{...request,idempotencyKey:randomUUID()}),code('idempotency_conflict'));
});

test('failed import confirmation at column capacity is atomic, then retries the same key', async t => {
  const f = await fixture(t);
  const plan = await transfer.preview(f.owner,f.table.id,{csvText:'Extra\nvalue',mappings:[{sourceIndex:0,destination:{kind:'new',name:'Imported extra',valueType:'text'}}]});
  const request = importRequest(plan), columns = await bulkColumns(f.table.id,46);
  const saved = await persistenceState(f.table.id);
  await assert.rejects(transfer.confirm(f.owner,plan.id,request),code('capacity_exceeded'));
  assert.deepEqual(await persistenceState(f.table.id),saved);
  assert.equal((await db.pool.query('SELECT committed_result FROM app.plans WHERE id=$1',[plan.id])).rows[0].committed_result,null);
  await db.pool.query('DELETE FROM app.columns WHERE id=$1 AND table_id=$2',[columns[0].id,f.table.id]);
  const result = await transfer.confirm(f.owner,plan.id,request);
  assert.deepEqual(await transfer.confirm(f.owner,plan.id,request),result);
  const state = await persistenceState(f.table.id);
  assert.equal(state.column_count,50); assert.equal(state.row_count,1); assert.equal(state.cells,'50');
});

test('column configuration rejects reference mismatches/cycles and deletion of referenced columns', async t => {
  const f = await fixture(t), source = (await f.data()).columns[0];
  const output = await tables.saveColumn(f.owner,f.table.id,{name:'Dependent',definition:formula(`UPPER(${ref(source.id)})`,[source.id])});
  const saved = await persistenceState(f.table.id);
  await assert.rejects(tables.saveColumn(f.owner,f.table.id,{name:'Bad refs',definition:formula(ref(source.id),[])}),domainCode('reference_mismatch'));
  const missing = randomUUID();
  await assert.rejects(tables.saveColumn(f.owner,f.table.id,{name:'Unknown',definition:formula(ref(missing),[missing])}),domainCode('invalid_reference'));
  await assert.rejects(tables.saveColumn(f.owner,f.table.id,{expectedRevision:source.revision,definition:formula(ref(output.id),[output.id])},source.id),domainCode('dependency_cycle'));
  await assert.rejects(tables.deleteColumn(f.owner,f.table.id,source.id,source.revision),error=>{
    assert.ok(code('invalid_value')(error)); assert.deepEqual(error.extra.dependentColumnIds,[output.id]); return true;
  });
  assert.deepEqual(await persistenceState(f.table.id),saved);
  await tables.deleteColumn(f.owner,f.table.id,output.id,output.revision);
  await tables.deleteColumn(f.owner,f.table.id,source.id,source.revision);
  assert.equal((await f.data()).columns.length,3);
});

test('run preview performs zero external I/O and default-disabled provider policy blocks confirmation', async t => {
  const f = await fixture(t), connectionId = randomUUID();
  assert.ok(capabilityCatalog.every(p=>p.enabledForRealRequests===false));
  // SQL-only synthetic ready connection: do not call credential validation/auth endpoints.
  await db.pool.query("INSERT INTO app.connections(id,workspace_id,provider_key,status,ciphertext) VALUES($1,$2,'pdl','ready','fixture-no-credentials')",[connectionId,f.ws]);
  const output = await tables.saveColumn(f.owner,f.table.id,{name:'Company',definition:{kind:'company',connection:{id:connectionId,revision:'1'},domainInput:{kind:'fixed',value:'synthetic.example'},output:'name'}});
  await tables.addRow(f.owner,f.table.id);
  const saved = await persistenceState(f.table.id);
  const priorFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('preview must not access vendors/auth'); };
  t.after(()=>{globalThis.fetch=priorFetch;});
  const preview = await runPreview(f,[output.id]);
  assert.equal(calls,0);
  assert.deepEqual(preview.blockers,['unverified_provider_policy']);
  assert.equal(preview.cells.eligible,1); assert.equal(preview.maximumExternalRequests,1);
  assert.equal(preview.requiredConsent.unknownPrice,true);
  assert.deepEqual(await persistenceState(f.table.id),saved);
  assert.equal(await count('plans',f.table.id),1);
  await assert.rejects(planner.confirm(f.owner,runRequest(preview)),code('provider_not_ready'));
  assert.equal(calls,0);
  assert.deepEqual(await persistenceState(f.table.id),saved);
  assert.equal(Number((await db.pool.query('SELECT count(*) FROM app.attempts WHERE connection_id=$1',[connectionId])).rows[0].count),0);
  assert.equal(Number((await db.pool.query('SELECT count(*) FROM app.usage_observations WHERE workspace_id=$1',[f.ws])).rows[0].count),0);
});

async function reusedRun(t) {
  const f = await fixture(t), source = (await f.data()).columns[0];
  const first = await tables.addRow(f.owner,f.table.id), second = await tables.addRow(f.owner,f.table.id);
  await patch(f,first.id,source.id,text('private first'));
  await patch(f,second.id,source.id,text('private second'));
  const output = await tables.saveColumn(f.owner,f.table.id,{name:'Fresh uppercase',definition:formula(`UPPER(${ref(source.id)})`,[source.id])});
  const preview = await runPreview(f,[output.id]);
  assert.deepEqual(preview.cells,{eligible:0,reused:2,skipped:0});
  assert.deepEqual(preview.providers,[]); assert.equal(preview.maximumExternalRequests,0);
  const request = runRequest(preview);
  const runs = await Promise.all(Array.from({length:4},()=>planner.confirm(f.owner,request)));
  const run = runs[0];
  for (const retry of runs) assert.deepEqual(retry,run);
  return {...f,source,output,first,second,preview,request,run};
}

test('fresh formulas are reused, run confirmation is idempotent, and SQL snapshots are immutable', async t => {
  const f = await reusedRun(t);
  assert.equal(f.run.status,'completed');
  assert.deepEqual(await planner.confirm(f.owner,f.request),f.run);
  await assert.rejects(planner.confirm(f.owner,{...f.request,consent:{...consent,unknownPrice:false}}),code('idempotency_conflict'));
  assert.equal(await count('runs',f.table.id),1);
  assert.equal(await count('run_rows',f.table.id),2);
  assert.equal(await count('steps',f.table.id),2);
  assert.equal(await count('reservations',f.table.id),0);
  const steps = (await db.pool.query('SELECT outcome,result FROM app.steps WHERE run_id=$1 ORDER BY row_id',[f.run.id])).rows;
  assert.ok(steps.every(s=>s.outcome==='reused'));
  assert.deepEqual(steps.map(s=>s.result.value).sort(),['PRIVATE FIRST','PRIVATE SECOND']);
  const snapshot = (await db.pool.query('SELECT * FROM app.run_rows WHERE run_id=$1 AND row_id=$2',[f.run.id,f.first.id])).rows[0];
  assert.deepEqual(snapshot.values[f.source.id],text('private first'));
  await patch(f,f.first.id,f.source.id,text('changed after confirmation'));
  assert.deepEqual(await planner.confirm(f.owner,f.request),f.run);
  assert.deepEqual((await db.pool.query('SELECT * FROM app.run_rows WHERE run_id=$1 AND row_id=$2',[f.run.id,f.first.id])).rows[0],snapshot);
  await rollbackReject("UPDATE app.runs SET snapshot='{}'::jsonb WHERE id=$1",[f.run.id],/immutable_run/);
  await rollbackReject('UPDATE app.runs SET request_fingerprint=$2 WHERE id=$1',[f.run.id,'changed'],/immutable_run/);
  await rollbackReject('UPDATE app.runs SET idempotency_key=$2 WHERE id=$1',[f.run.id,randomUUID()],/immutable_run/);
  await rollbackReject("UPDATE app.run_rows SET values='{}'::jsonb WHERE run_id=$1 AND row_id=$2",[f.run.id,f.first.id],/immutable_row_snapshot/);
  await rollbackReject("UPDATE app.run_rows SET source_versions='{}'::jsonb WHERE run_id=$1 AND row_id=$2",[f.run.id,f.first.id],/immutable_row_snapshot/);
  assert.deepEqual((await db.pool.query('SELECT * FROM app.run_rows WHERE run_id=$1 AND row_id=$2',[f.run.id,f.first.id])).rows[0],snapshot);
});

test('active reservations block column type changes/deletion and row/table deletion', async t => {
  const f = await fixture(t);
  const output = await tables.saveColumn(f.owner,f.table.id,{name:'Reserved formula',definition:formula('"ready"',[])});
  const row = await tables.addRow(f.owner,f.table.id);
  // A queued local formula run needs no vendor, worker, or API.
  await db.pool.query('UPDATE app.cells SET stale=true WHERE row_id=$1 AND column_id=$2',[row.id,output.id]);
  const preview = await runPreview(f,[output.id]);
  assert.equal(preview.cells.eligible,1);
  const run = await planner.confirm(f.owner,runRequest(preview));
  assert.equal(run.status,'queued');
  assert.equal(await count('reservations',f.table.id),1);
  const saved = await persistenceState(f.table.id);
  await assert.rejects(tables.deleteColumn(f.owner,f.table.id,output.id,output.revision),code('active_work'));
  await assert.rejects(tables.saveColumn(f.owner,f.table.id,{expectedRevision:output.revision,definition:{kind:'editable',valueType:'number'}},output.id),code('active_work'));
  await assert.rejects(tables.remove(f.owner,f.table.id,[row.id]),code('active_work'));
  await assert.rejects(tables.remove(f.owner,f.table.id),code('active_work'));
  const blocked = await runPreview(f,[output.id]);
  assert.ok(blocked.blockers.includes('active_work'));
  await assert.rejects(planner.confirm(f.owner,runRequest(blocked)),code('provider_not_ready'));
  assert.deepEqual(await persistenceState(f.table.id),saved);
});

test('composite foreign keys reject cross-table cells, runs, steps, reservations, plans and snapshots', async t => {
  const f = await reusedRun(t);
  const otherTable = await tables.create(f.other,`foreign-${randomUUID()}`);
  const otherRow = await tables.addRow(f.other,otherTable.id);
  const otherColumn = (await tables.read(f.other,otherTable.id)).columns[0];
  const stepId = (await db.pool.query('SELECT id FROM app.steps WHERE run_id=$1 LIMIT 1',[f.run.id])).rows[0].id;
  const before = await persistenceState(f.table.id), otherBefore = await persistenceState(otherTable.id);
  for (const [sql,args] of [
    ['INSERT INTO app.cells(row_id,column_id,table_id,value) VALUES($1,$2,$3,$4)',[otherRow.id,f.source.id,f.table.id,text('cross-row')]],
    ['INSERT INTO app.cells(row_id,column_id,table_id,value) VALUES($1,$2,$3,$4)',[f.first.id,otherColumn.id,f.table.id,text('cross-column')]],
    ["INSERT INTO app.plans(id,workspace_id,table_id,kind,expires_at,payload) VALUES($1,$2,$3,'run',now(),'{}')",[randomUUID(),f.otherWs,f.table.id]],
    ["INSERT INTO app.runs(id,workspace_id,table_id,status,idempotency_key,request_fingerprint,snapshot) VALUES($1,$2,$3,'queued',$4,'fixture','{}')",[randomUUID(),f.otherWs,f.table.id,randomUUID()]],
    ["INSERT INTO app.runs(id,workspace_id,table_id,parent_run_id,status,idempotency_key,request_fingerprint,snapshot) VALUES($1,$2,$3,$4,'queued',$5,'fixture','{}')",[randomUUID(),f.otherWs,otherTable.id,f.run.id,randomUUID()]],
    ["INSERT INTO app.steps(id,run_id,table_id,row_id,column_id,outcome) VALUES($1,$2,$3,$4,$5,'queued')",[randomUUID(),f.run.id,otherTable.id,otherRow.id,otherColumn.id]],
    ["INSERT INTO app.steps(id,run_id,table_id,row_id,column_id,outcome) VALUES($1,$2,$3,$4,$5,'queued')",[randomUUID(),f.run.id,f.table.id,otherRow.id,f.source.id]],
    ["INSERT INTO app.steps(id,run_id,table_id,row_id,column_id,outcome) VALUES($1,$2,$3,$4,$5,'queued')",[randomUUID(),f.run.id,f.table.id,f.first.id,otherColumn.id]],
    ['INSERT INTO app.reservations(row_id,column_id,step_id,table_id) VALUES($1,$2,$3,$4)',[otherRow.id,f.source.id,stepId,f.table.id]],
    ['INSERT INTO app.reservations(row_id,column_id,step_id,table_id) VALUES($1,$2,$3,$4)',[f.first.id,otherColumn.id,stepId,f.table.id]],
    ["INSERT INTO app.run_rows(run_id,table_id,row_id,values,source_versions) VALUES($1,$2,$3,'{}','{}')",[f.run.id,f.table.id,otherRow.id]],
    ["INSERT INTO app.run_rows(run_id,table_id,row_id,values,source_versions) VALUES($1,$2,$3,'{}','{}')",[f.run.id,otherTable.id,otherRow.id]],
  ]) await rollbackReject(sql,args,fkViolation);
  assert.deepEqual(await persistenceState(f.table.id),before);
  assert.deepEqual(await persistenceState(otherTable.id),otherBefore);
});

test('row deletion redacts normalized snapshots and steps but preserves the other row snapshot', async t => {
  const f = await reusedRun(t);
  const retained = (await db.pool.query('SELECT * FROM app.run_rows WHERE run_id=$1 AND row_id=$2',[f.run.id,f.second.id])).rows[0];
  const runBefore = (await db.pool.query('SELECT snapshot FROM app.runs WHERE id=$1',[f.run.id])).rows[0].snapshot;
  assert.equal(JSON.stringify(runBefore).includes('private first'),false);
  assert.equal(JSON.stringify(runBefore).includes('PRIVATE FIRST'),false);
  await tables.remove(f.owner,f.table.id,[f.first.id]);
  assert.equal(await count('run_rows',f.table.id),1);
  assert.equal(await count('steps',f.table.id),1);
  assert.equal((await db.pool.query('SELECT count(*) FROM app.run_rows WHERE row_id=$1',[f.first.id])).rows[0].count,'0');
  assert.equal((await db.pool.query('SELECT count(*) FROM app.cells WHERE row_id=$1',[f.first.id])).rows[0].count,'0');
  assert.deepEqual((await db.pool.query('SELECT * FROM app.run_rows WHERE run_id=$1 AND row_id=$2',[f.run.id,f.second.id])).rows[0],retained);
  assert.deepEqual((await db.pool.query('SELECT snapshot FROM app.runs WHERE id=$1',[f.run.id])).rows[0].snapshot,runBefore);
  assert.equal(await count('plans',f.table.id),0);
  assert.deepEqual((await f.data()).rows.map(r=>r.id),[f.second.id]);
});

test('duplicate CSV headers remain staged until corrected and export returns stored exact values', async t => {
  const f = await fixture(t), columns = (await f.data()).columns;
  let plan = await transfer.preview(f.owner,f.table.id,{csvText:'Name,name\n"Ada, Jr",example.test',mappings:[
    {sourceIndex:0,destination:{kind:'existing',columnId:columns[0].id,valueType:'text'}},
    {sourceIndex:1,destination:{kind:'existing',columnId:columns[2].id,valueType:'text'}},
  ]});
  assert.equal(plan.state,'needs_correction');
  assert.ok(plan.issues.some(i=>i.code==='duplicate_header'));
  plan = await transfer.correct(f.owner,plan.id,{expectedPlanRevision:plan.revision,headers:['Name','Domain']});
  assert.equal(plan.state,'ready');
  await transfer.confirm(f.owner,plan.id,importRequest(plan));
  const data = await f.data();
  const csv = await transfer.export(f.owner,f.table.id,{tableId:f.table.id,rowScope:{kind:'all'},columnIds:[columns[0].id,columns[2].id],expectedViewRevision:data.view.revision,acknowledgeStoredOutputWarnings:false,neutralizeSpreadsheetText:true});
  assert.equal(csv,'Person name,Company domain\r\n"Ada, Jr",example.test\r\n');
});
