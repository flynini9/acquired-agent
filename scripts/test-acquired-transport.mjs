import assert from 'node:assert/strict';
import {newTrace,trackedFetch,traceStorage,settleTrace,summary} from '../lib/acquired/telemetry.ts';
import {localCooldownUntil,cooldownMessage} from '../lib/acquired/cooldown.ts';
const original=globalThis.fetch,base='https://hackathon.api.qloo.com/search';
const auth=key=>({headers:{'X-Api-Key':key}}),fast={minIntervalMs:0,cache:false};
const run=(t,url,key='dummy-transport-key')=>traceStorage.run(t,()=>trackedFetch(url,auth(key)));
const note=[];let calls=0;
try{
 let active=0,max=0;const starts=[];
 globalThis.fetch=async()=>{calls++;active++;max=Math.max(max,active);starts.push(Date.now());await new Promise(r=>setTimeout(r,5));active--;return Response.json({results:{ok:true}})};
 let t=newTrace({minIntervalMs:20,cache:false});await Promise.all(Array.from({length:8},(_,i)=>run(t,base+'?query=pacing-'+i)));
 assert.equal(calls,8);assert.equal(max,1);assert.ok(starts.slice(1).every((s,i)=>s-starts[i]>=18));assert.equal(summary(t).maxActive,1);note.push('8 queued requests: concurrency 1 and spaced starts');
 calls=0;globalThis.fetch=async()=>{calls++;return Response.json({results:{value:42}})};
 t=newTrace({minIntervalMs:0});const [a,b]=await Promise.all([run(t,base+'?b=2&a=dedup'),run(t,base+'?a=dedup&b=2')]);assert.deepEqual(await a.json(),await b.json());assert.equal(calls,1);assert.equal(t.cacheHits,1);
 let next=newTrace({minIntervalMs:0});const cached=await run(next,base+'?a=dedup&b=2');assert.equal(cached.headers.get('X-Acquired-Cache'),'hit');assert.equal(calls,1);assert.equal(next.calls.length,0);
 await run(newTrace({minIntervalMs:0}),base+'?a=dedup&b=2','other-worthless-key');assert.equal(calls,2);note.push('dedupe, success cache, cloned bodies, credential isolation');
 calls=0;globalThis.fetch=async()=>{calls++;return Response.json({results:{ok:true}})};
 await run(newTrace({minIntervalMs:0,cacheMaxAgeMs:1}),base+'?query=expiry');await new Promise(r=>setTimeout(r,8));await run(newTrace({minIntervalMs:0,cacheMaxAgeMs:1}),base+'?query=expiry');assert.equal(calls,2);note.push('expired success is fetched again');
 calls=0;globalThis.fetch=async()=>{calls++;return new Response('{}',{status:429})};
 t=newTrace(fast);const settled=await Promise.allSettled(Array.from({length:8},(_,i)=>run(t,base+'?query=limited-'+i)));await settleTrace(t);assert.equal(calls,1);assert.equal(settled.filter(x=>x.status==='rejected').length,7);assert.equal(t.queued,0);assert.equal(t.active,0);
 await run(newTrace(fast),base+'?query=limited-0');assert.equal(calls,2);note.push('first 429 cancels queued calls; failures are not cached');
 const cancelResponse=await run(newTrace(fast),base+'?query=cancel-error-body');
 await Promise.race([cancelResponse.body?.cancel()??Promise.resolve(),new Promise((_,reject)=>setTimeout(()=>reject(Error('error body cancellation hung')),200))]);
 assert.equal(cancelResponse.body,null);note.push('typed error response cancellation cannot deadlock on a cloned stream');
 calls=0;globalThis.fetch=async()=>{calls++;return Response.json({results:{ok:true}})};t=newTrace(fast);t.limit=2;await Promise.allSettled(Array.from({length:8},(_,i)=>run(t,base+'?query=budget-'+i)));assert.equal(calls,2);assert.equal(t.exhausted,true);assert.equal(t.upstreamFailure,undefined);note.push('queued calls respect actual-send budget');
 const until=localCooldownUntil(undefined,1000);assert.equal(until,61000);assert.equal(localCooldownUntil(120,1000),121000);assert.ok(cooldownMessage(until,1000).includes('不代表 Qloo 一定恢复'));note.push('local cooldown is explicit, minimum 60s, respects longer Retry-After');
 assert.equal(JSON.stringify(summary(next)).includes('dummy-transport-key'),false);assert.equal(JSON.stringify(summary(next)).includes('dedup'),false);
 console.log(JSON.stringify({passed:true,checks:note,liveQlooRequests:0}));
}finally{globalThis.fetch=original}
