import assert from 'node:assert/strict';
import {newTrace,trackedFetch,traceStorage,summary} from '../lib/acquired/telemetry.ts';
const original=globalThis.fetch;let called=0;
try{
 globalThis.fetch=async()=>{called++;return new Response('{}',{status:200})};
 const a=newTrace({minIntervalMs:0,cache:false}),b=newTrace({minIntervalMs:0,cache:false});
 await Promise.all([traceStorage.run(a,()=>trackedFetch('https://hackathon.api.qloo.com/search?query=x')),
 traceStorage.run(b,()=>trackedFetch('https://hackathon.api.qloo.com/v2/insights?filter.results.entities=x'))]);
 assert.equal(summary(a).categories.search,1);assert.equal(summary(b).categories.oracle,1);assert.equal(a.calls.length,1);
 a.limit=1;await assert.rejects(traceStorage.run(a,()=>trackedFetch('https://hackathon.api.qloo.com/search')));assert.equal(called,2);assert.equal(a.exhausted,true);
 await assert.rejects(traceStorage.run(b,()=>trackedFetch('https://example.com/')));assert.equal(called,2);
 const d=newTrace({minIntervalMs:0,cache:false});d.deadline=Date.now()-1;await assert.rejects(traceStorage.run(d,()=>trackedFetch('https://hackathon.api.qloo.com/search')));assert.equal(called,2);
 assert.equal(JSON.stringify(a.calls).includes('query=x'),false);
 const rejected=newTrace({minIntervalMs:0,cache:false});
 const entityId='C7C4CD90-A5B1-4D5D-A350-BD83B5681DB5';
 globalThis.fetch=async()=>new Response('untrusted provider secret',{status:400});
 await traceStorage.run(rejected,()=>trackedFetch('https://hackathon.api.qloo.com/v2/insights?filter.type=urn:entity:book&signal.interests.entities='+entityId+',arbitrary-secret&filter.results.entities=not-an-id&api_key=hidden-secret&query=private-search'));
 assert.deepEqual(rejected.calls[0].failedQuery,{resultType:'urn:entity:book',signalEntityIds:[entityId],resultEntityIds:[]});
 assert.equal(/secret|private-search|untrusted|api_key/.test(JSON.stringify(rejected.calls)),false,'Failure diagnostics contain only allowed catalogue IDs/type');
 console.log('Telemetry checks passed: per-request isolation, categories, count/deadline ceilings, destination allowlist, no query logging. No live requests.');
}finally{globalThis.fetch=original}
