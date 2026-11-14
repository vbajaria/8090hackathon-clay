import test from 'node:test';
import assert from 'node:assert/strict';
import { validateColumnConfiguration as validate, columnDependencies as dependencies, topologicalColumns as order, DomainError } from '../dist/index.js';
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ref = n => `{{${id(n)}}}`;
const column = (n, definition, name = `Column ${n}`) => ({id:id(n),revision:'1',name,definition});
const editable = (n,type='text') => column(n,{kind:'editable',valueType:type});
const formula = (n,ids,expression=ids.map(i=>ref(i)).join('+')) => column(n,{kind:'formula',returnType:'text',expression,referencedColumnIds:ids.map(id)});
const connection = {id:id(50),revision:'1'};
const mapping = n => ({kind:'column',columnId:id(n)});
const fixed = value => ({kind:'fixed',value});
const ai = (n,ids) => column(n,{kind:'ai',connection,model:'synthetic',instructionTemplate:'Draft '+ids.map(ref).join(' '),referencedColumnIds:ids.map(id)});
const email = (n,providers) => column(n,{kind:'email',domainInput:mapping(1),providers});
const parts = {mode:'mapped_parts',givenNameInput:mapping(2),familyNameInput:mapping(3),source:'owner_mapped'};
const full = {mode:'full_name',fullNameInput:mapping(2)};
const provider = (providerKey,nameMapping) => ({providerKey,connection,nameMapping});
const code = expected => error => error instanceof DomainError && error.code === expected;
test('stable references, fixed inputs, dependency de-duplication and computed prerequisite closure', () => {
  const cols = [ai(5,[4,1]), formula(4,[3],'UPPER('+ref(3)+')'),formula(3,[1],'LOWER('+ref(1)+')'),editable(1),editable(2)];
  validate(cols);
  assert.deepEqual(dependencies(cols[0]),[id(4),id(1)]);
  assert.deepEqual(order(cols,[id(5)]).map(c=>c.id),[id(3),id(4),id(5)]);
  assert.deepEqual(order(cols,[id(2)]),[]);
  assert.deepEqual(order(cols,[]),[]);
  const enrichment = email(6,[provider('hunter',parts),provider('snov',{...parts,givenNameInput:fixed('Synthetic')})]);
  assert.deepEqual(dependencies(enrichment),[id(1),id(2),id(3)]);
  validate([editable(1),editable(2),editable(3),enrichment]);
});
test('renaming a column preserves references while duplicate names/IDs fail', () => {
  const input = {...editable(1),name:'Renamed'};
  validate([input,formula(2,[1],ref(1))]);
  assert.throws(() => validate([input,{...editable(2),name:' renamed '}]),code('duplicate_column'));
  assert.throws(() => validate([input,input]),code('duplicate_column'));
  assert.throws(() => validate([{...input,id:'display-name'}]),code('invalid_configuration'));
});
test('unknown references and exact selected-ID mismatch fail before save', () => {
  assert.throws(() => validate([formula(2,[1],ref(1))]),code('invalid_reference'));
  assert.throws(() => validate([editable(1),formula(2,[],ref(1))]),code('reference_mismatch'));
  assert.throws(() => validate([editable(1),formula(2,[1],'1')]),code('reference_mismatch'));
  assert.throws(() => validate([editable(1),{...ai(2,[1]),definition:{...ai(2,[1]).definition,referencedColumnIds:[]}}]),code('reference_mismatch'));
  assert.throws(() => order([editable(1)],[id(99)]),code('invalid_reference'));
  assert.throws(() => validate([editable(1),formula(2,[1],'{{Column 1}}')]),error=>error instanceof DomainError);
});
test('direct and transitive mixed-kind cycles are rejected', () => {
  assert.throws(() => validate([formula(1,[1],ref(1))]),code('dependency_cycle'));
  assert.throws(() => validate([formula(1,[2],ref(2)),ai(2,[1])]),code('dependency_cycle'));
  const company = column(3,{kind:'company',connection,domainInput:mapping(2),output:'name'});
  assert.throws(() => validate([ai(2,[3]),company]),code('dependency_cycle'));
});
test('explicit name mappings reject Snov full name and uncertified Tomba without splitting', () => {
  validate([editable(1),editable(2),email(4,[provider('hunter',full)])]);
  assert.throws(() => validate([editable(1),editable(2),email(4,[provider('snov',full)])]),code('incompatible_provider'));
  assert.throws(() => validate([editable(1),editable(2),editable(3),email(4,[provider('tomba',parts)])]),code('incompatible_provider'));
  assert.throws(() => validate([editable(1),editable(2,'number'),editable(3),email(4,[provider('hunter',parts)])]),code('invalid_configuration'));
  assert.throws(() => validate([editable(1),editable(2),editable(3),email(4,[provider('hunter',{...parts,source:'auto_split'})])]),code('invalid_configuration'));
});
test('missing input mappings, invalid outputs and per-column run conditions are rejected', () => {
  const company = column(2,{kind:'company',connection,domainInput:fixed('synthetic.example'),output:'website'});
  validate([company]);
  assert.deepEqual(dependencies(company),[]);
  assert.throws(() => validate([{...company,definition:{...company.definition,output:'email'}}]),code('invalid_configuration'));
  assert.throws(() => validate([{...company,definition:{...company.definition,runCondition:'true'}}]),code('invalid_configuration'));
  assert.throws(() => validate([column(2,{kind:'company',connection,domainInput:mapping(99),output:'name'})]),code('invalid_reference'));
});
