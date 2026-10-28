import assert from 'node:assert/strict';
import {classifyQlooRejection,readQlooRejection,rejectionHeader} from '../lib/acquired/qloo-rejection.mjs';
import {newTrace,traceStorage,trackedFetch} from '../lib/acquired/telemetry.ts';
const observed={errors:[{message:'All of the provided signal.interests.entities were invalid. At least one valid signal or filter is required for entity insights.',path:'signal.interests.entities'}]};
assert.equal(classifyQlooRejection(observed),'invalid_entity_signals');
for(const value of [null,{},'untrusted',{errors:[]},{errors:[...observed.errors,...observed.errors]},{errors:[{...observed.errors[0],path:'filter.type'}]},{errors:[{...observed.errors[0],message:'untrusted secret'}]}])assert.equal(classifyQlooRejection(value),null);
assert.equal(await readQlooRejection(new Response('not JSON')),null);
assert.equal(await readQlooRejection(new Response(' '.repeat(16385)+JSON.stringify(observed))),null);
const original=globalThis.fetch;
const query='https://hackathon.api.qloo.com/v2/insights?filter.type=urn:entity:artist&signal.interests.entities=5D6B72E0-555F-4D4C-9578-96CB6CC63D26';
try{
 for(const status of [400,404,422,401,429,503]){
  globalThis.fetch=async()=>Response.json(observed,{status,headers:{[rejectionHeader]:'invalid_entity_signals'}});
  const trace=newTrace({minIntervalMs:0,cache:false});
  const response=await traceStorage.run(trace,()=>trackedFetch(query));
  assert.equal(trace.calls[0].rejection,status===400?'invalid_entity_signals':undefined);
  assert.equal(await response.text(),'','No provider body returned');
 }
 globalThis.fetch=async()=>Response.json({errors:[{message:'arbitrary-private-body',path:'take'}]},{status:400,headers:{[rejectionHeader]:'invalid_entity_signals'}});
 const trace=newTrace({minIntervalMs:0,cache:false});
 const response=await traceStorage.run(trace,()=>trackedFetch(query));
 assert.equal(response.headers.get(rejectionHeader),null,'Upstream header cannot spoof classification');
 assert.equal(trace.calls[0].rejection,undefined);
 assert.ok(!JSON.stringify(trace.calls).includes('arbitrary-private-body'));
 console.log('Exact rejection recognition, bounded body parsing, status isolation, header spoof rejection and no raw-body reflection passed. No live Qloo calls.');
}finally{globalThis.fetch=original}
