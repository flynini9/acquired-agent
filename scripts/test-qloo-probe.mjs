import assert from 'node:assert/strict';
import { probeQlooKey } from '../lib/qloo-probe.ts';
const dummy='dummy-for-offline-contract-only';
let calls=0;
const missing=await probeQlooKey(undefined,async()=>{calls++;throw Error('should not call')});
assert.equal(missing.status,503);assert.equal(calls,0);
const ok=await probeQlooKey(dummy,async(url,init)=>{
 calls++;assert.equal(url,'https://hackathon.api.qloo.com/search?query=jazz&take=1');
 assert.equal(init.headers['X-Api-Key'],dummy);assert.equal(init.redirect,'manual');
 return Response.json({results:[{name:'jazz',secret:dummy}]});
});
assert.equal(calls,1);assert.equal(ok.data.authenticated,true);assert.equal(ok.data.entityCount,1);assert.ok(!JSON.stringify(ok).includes(dummy));
const rejected=await probeQlooKey(dummy,async()=>new Response(dummy,{status:401}));
assert.equal(rejected.data.upstreamStatus,401);assert.equal(rejected.data.authenticated,false);assert.ok(!JSON.stringify(rejected).includes(dummy));
const network=await probeQlooKey(dummy,async()=>{throw new Error(dummy)});
assert.equal(network.status,502);assert.ok(!JSON.stringify(network).includes(dummy));
console.log('4 offline cases passed: missing key/no call, fixed single request, reflected upstream error, credential-bearing exception. No live Qloo calls.');
