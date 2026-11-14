import test from 'node:test';
import assert from 'node:assert/strict';
import { api, RequestError, typedValue, scope, validateColumn, canConfirm, freshConsent, text } from '../lib/client.ts';
import { RunPreviewRequestSchema, RunConfirmRequestSchema, CellPatchSchema, ExportRequestSchema, ImportConfirmRequestSchema, TableViewSchema } from '@leadwork/contracts';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const view = {revision:'9007199254740993',filters:[],sort:[],visibleColumnIds:[id(1)]};
const column = {id:id(1),revision:'1',name:'Domain',definition:{kind:'editable',valueType:'text'}};
const makePreview = () => ({id:id(5),revision:'2',tableId:id(9),expectedTableRevision:'1',expiresAt:'2099-01-01T00:00:00Z',inputFingerprint:'a'.repeat(64),parentRunId:null,rowIds:[id(2)],selectedColumnIds:[id(3)],prerequisiteColumnIds:[],cells:{eligible:1,reused:0,skipped:0},providers:[],maximumExternalRequests:0,requiredConsent:freshConsent(),blockers:[]});
test('typed values preserve exact decimals and distinguish blank, false and zero', () => {
  assert.deepEqual(typedValue('number','9007199254740993.01'),{type:'number',value:'9007199254740993.01'});
  assert.deepEqual(typedValue('boolean','false'),{type:'boolean',value:false});
  assert.deepEqual(typedValue('number',''),{type:'number',value:null});
  assert.deepEqual(typedValue('number','0'),{type:'number',value:'0'});
  assert.deepEqual(typedValue('date','2024-02-29'),{type:'date',value:'2024-02-29'});
  for (const [type,input] of [['number','1,000'],['number','1e3'],['date','2025-02-29'],['boolean','TRUE']]) assert.throws(() => typedValue(type,input));
});
test('scope requires explicit selection and represents full server-filtered scope', () => {
  assert.throws(() => scope('',[],view)); assert.throws(() => scope('selected',[],view));
  assert.deepEqual(scope('selected',[id(2)],view),{kind:'selected',rowIds:[id(2)]});
  assert.deepEqual(scope('filtered',[],view),{kind:'filtered',viewRevision:'9007199254740993',filters:[]});
  assert.deepEqual(scope('all',[],view),{kind:'all'});
});
test('configuration rejects duplicate names, missing stable IDs, reference mismatch and cycles', () => {
  assert.throws(() => validateColumn(' domain ',{kind:'editable',valueType:'text'},[column]));
  assert.throws(() => validateColumn(' ',{kind:'editable',valueType:'text'},[column]));
  assert.throws(() => validateColumn('Formula',{kind:'formula',returnType:'text',expression:`LOWER({{${id(7)}}})`,referencedColumnIds:[id(7)]},[column]));
  assert.throws(() => validateColumn('Formula',{kind:'formula',returnType:'text',expression:`LOWER({{${id(1)}}})`,referencedColumnIds:[]},[column]));
  const existing = {...column,definition:{kind:'formula',returnType:'text',expression:`LOWER({{${id(1)}}})`,referencedColumnIds:[id(1)]}};
  assert.throws(() => validateColumn('Domain',existing.definition,[existing],existing));
  assert.deepEqual(validateColumn('Formula',{kind:'formula',returnType:'text',expression:`LOWER({{${id(1)}}})`,referencedColumnIds:[id(1)]},[column]).referencedColumnIds,[id(1)]);
});
test('AI empty/over-limit templates and Snov full-name mappings are rejected', () => {
  const connection = {id:id(20),revision:'2'};
  for (const instructionTemplate of ['', 'a'.repeat(2001)]) assert.throws(() => validateColumn('Draft',{kind:'ai',connection,model:'model',instructionTemplate,referencedColumnIds:[]},[column]));
  const definition = {kind:'email',domainInput:{kind:'fixed',value:'example.com'},providers:[{providerKey:'snov',connection,nameMapping:{mode:'full_name',fullNameInput:{kind:'fixed',value:'Ada Lovelace'}}}]};
  assert.throws(() => validateColumn('Email',definition,[column]));
  definition.providers[0].nameMapping = {mode:'mapped_parts',givenNameInput:{kind:'fixed',value:'Ada'},familyNameInput:{kind:'fixed',value:'Lovelace'},source:'owner_mapped'};
  assert.equal(validateColumn('Email',definition,[column]).kind,'email');
});
test('every required consent remains independent, expired/blocked previews cannot confirm', () => {
  const preview = makePreview(); for (const key of Object.keys(freshConsent())) preview.requiredConsent[key] = true;
  const consent = freshConsent(); assert.equal(canConfirm(preview,consent),false);
  for (const key of ['unknownPrice','overwritePopulated','refreshStale']) { consent[key] = true; assert.equal(canConfirm(preview,consent),false); }
  consent.possibleDuplicateCharge = true; assert.equal(canConfirm(preview,consent),true);
  preview.blockers = ['provider_not_ready']; assert.equal(canConfirm(preview,consent),false);
  preview.blockers = []; assert.equal(canConfirm(preview,consent,Date.parse(preview.expiresAt)),false);
});
test('CAS, run, import, export and saved view payloads conform to shared schemas', () => {
  assert.equal(CellPatchSchema.parse({rowId:id(2),columnId:id(1),expectedVersion:'9007199254740993',value:typedValue('text','draft')}).expectedVersion,'9007199254740993');
  assert.ok(RunPreviewRequestSchema.parse({tableId:id(9),expectedTableRevision:'1',rowScope:scope('selected',[id(2)],view),selectedColumnIds:[id(3)]}));
  assert.ok(RunConfirmRequestSchema.parse({previewId:id(5),expectedPreviewRevision:'2',idempotencyKey:'same-key-on-retry',consent:freshConsent()}));
  assert.ok(ImportConfirmRequestSchema.parse({planId:id(6),expectedPlanRevision:'1',idempotencyKey:'same-import-key'}));
  assert.ok(ExportRequestSchema.parse({tableId:id(9),rowScope:scope('filtered',[],view),columnIds:[id(1)],expectedViewRevision:view.revision,acknowledgeStoredOutputWarnings:false,neutralizeSpreadsheetText:true}));
  assert.ok(TableViewSchema.parse(view));
});
test('API reads exact empty arrays and emits same-origin JSON, not an invented wrapper', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url,init) => { calls.push({url,init}); return new Response(JSON.stringify([]),{headers:{'Content-Type':'application/json'}}); };
  try { assert.deepEqual(await api('/tables'),[]); await api('/tables','POST',{name:'Leads'}); assert.equal(calls[1].url,'/api/tables'); assert.equal(calls[1].init.credentials,'same-origin'); assert.deepEqual(JSON.parse(calls[1].init.body),{name:'Leads'}); assert.equal(calls[0].init.cache,'no-store'); }
  finally { globalThis.fetch = original; }
});
test('failed loading is an error, never an empty dataset; CAS conflict exposes current', async () => {
  const original = globalThis.fetch;
  const current = {value:{type:'text',value:'Newer value'},version:'4',stale:false,outcome:null};
  globalThis.fetch = async () => new Response(JSON.stringify({error:{code:'version_conflict',message:'Saved data changed.'},current}),{status:409,headers:{'Content-Type':'application/json'}});
  try { await assert.rejects(api('/tables/one/cells','PATCH',{}),e => e instanceof RequestError && e.code === 'version_conflict' && e.body.current.version === '4'); }
  finally { globalThis.fetch = original; }
});
test('interrupted mutation is explicitly uncertain; aborts stay aborts', async () => {
  const original = globalThis.fetch;
  try { globalThis.fetch = async () => { throw new TypeError('network'); }; await assert.rejects(api('/tables','POST',{}),e => e.code === 'network' && /uncertain/.test(e.message));
    globalThis.fetch = async () => { throw new DOMException('aborted','AbortError'); }; await assert.rejects(api('/tables'),e => e.name === 'AbortError'); }
  finally { globalThis.fetch = original; }
});
test('CSV export returns a download blob without a provider request', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url) => { calls.push(url); return new Response('Domain\r\nexample.com\r\n',{headers:{'Content-Type':'text/csv'}}); };
  try { const blob = await api('/tables/one/export','POST',{}); assert.ok(blob instanceof Blob); assert.match(await blob.text(),/example.com/); assert.deepEqual(calls,['/api/tables/one/export']); }
  finally { globalThis.fetch = original; }
});
test('missing and unavailable output stays blank, false is displayed as false', () => {
  assert.equal(text(), ''); assert.equal(text({value:{type:'boolean',value:false}}),'false'); assert.equal(text({value:{type:'number',value:null}}),'');
});
