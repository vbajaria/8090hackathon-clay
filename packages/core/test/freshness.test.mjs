import {test} from 'node:test';import assert from 'node:assert/strict';import {fingerprint} from '../dist/planner.js';import {inputSignature} from '../dist/tables.js';
test('preview fingerprint ignores object and connection query ordering but detects actual changes',()=>{
 const data={table:{revision:'1'},columns:[{id:'source',definition:{kind:'editable',valueType:'text'}}],view:{revision:'1'}};
 const a=[{id:'row',cells:{source:{value:{type:'text',value:'Lead'},version:'1'},second:{value:null,version:'1'}}}];
 const b=[{id:'row',cells:{second:{version:'1',value:null},source:{version:'1',value:{value:'Lead',type:'text'}}}}];
 const connections=[{id:'a',revision:1,status:'ready'},{id:'b',revision:2,status:'ready'}];
 assert.equal(fingerprint(data,a,connections),fingerprint(data,b,[...connections].reverse()));b[0].cells.source.version='2';assert.notEqual(fingerprint(data,a,connections),fingerprint(data,b,connections));
});
test('result signature is JSONB-order independent and includes actual direct inputs and source versions',()=>{
 const source='00000000-0000-4000-8000-000000000001',output='00000000-0000-4000-8000-000000000002';
 const columns=[{id:source,name:'Source',revision:'1',definition:{kind:'editable',valueType:'text'}},{id:output,name:'Output',revision:'1',definition:{kind:'formula',expression:`UPPER({{${source}}})`,referencedColumnIds:[source],returnType:'text'}}];
 const a=inputSignature(columns,output,{[source]:{type:'text',value:'Lead'}},{[source]:'1'});
 assert.equal(a,inputSignature(columns,output,{[source]:{value:'Lead',type:'text'}},{[source]:'1'}));
 assert.notEqual(a,inputSignature(columns,output,{[source]:{type:'text',value:'Changed'}},{[source]:'1'}));assert.notEqual(a,inputSignature(columns,output,{[source]:{type:'text',value:'Lead'}},{[source]:'2'}));
});
