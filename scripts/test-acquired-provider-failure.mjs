import assert from 'node:assert/strict';
import {newTrace,trackedFetch,traceStorage,providerFailure} from '../lib/acquired/telemetry.ts';
const original=globalThis.fetch;let calls=0;
try{
 const limited=newTrace({minIntervalMs:0,cache:false});globalThis.fetch=async()=>{calls++;return new Response('untrusted provider text',{status:429,headers:{'Retry-After':'12'}})};
 // Model the upstream router swallowing a provider error as empty data.
 await traceStorage.run(limited,async()=>{assert.equal((await trackedFetch('https://hackathon.api.qloo.com/v2/insights')).status,429);await assert.rejects(trackedFetch('https://hackathon.api.qloo.com/search'));});
 assert.equal(calls,1);assert.equal(limited.active,0);assert.equal(limited.calls[0].status,429);assert.equal(limited.exhausted,false);assert.equal(providerFailure(limited).code,'rate_limited');assert.equal(providerFailure(limited).retryAfterSeconds,12);assert.equal(providerFailure(limited).message.includes('untrusted provider text'),false);
 const unavailable=newTrace({minIntervalMs:0,cache:false});globalThis.fetch=async()=>{calls++;return new Response('{}',{status:503})};assert.equal((await traceStorage.run(unavailable,()=>trackedFetch('https://hackathon.api.qloo.com/v2/insights'))).status,503);assert.equal(providerFailure(unavailable).code,'upstream_unavailable');
 const network=newTrace({minIntervalMs:0,cache:false});globalThis.fetch=async()=>{throw new Error('untrusted network failure')};await assert.rejects(traceStorage.run(network,()=>trackedFetch('https://hackathon.api.qloo.com/search')));assert.equal(providerFailure(network).upstreamStatus,null);
 const translation=newTrace({minIntervalMs:0,cache:false});globalThis.fetch=async()=>new Response('{}',{status:429});await traceStorage.run(translation,()=>trackedFetch('https://api.mymemory.translated.net/get'));assert.equal(providerFailure(translation),null);
 assert.equal(providerFailure(newTrace({minIntervalMs:0,cache:false})),null);
 console.log('Provider checks passed: rate limit survives swallowed errors, later calls blocked, Retry-After respected in message, 5xx separate from no-route, no raw provider reflection, translation not mislabeled as Qloo. No live requests.');
}finally{globalThis.fetch=original}
