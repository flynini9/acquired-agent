// Offline integration tests: execute the shipped core and Sites HTTP boundary
// with a dummy Secret, mocked fetch and an in-memory DB adapter. No real I/O.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import {newTrace,traceStorage,trackedFetch,settleTrace,runExplanation,measuredDeliveryAllowed,currentPhase} from '../lib/acquired/telemetry.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=await mkdtemp(path.join(root,'node_modules/.acquired-errors-'));
const originalFetch=globalThis.fetch;
globalThis.__acquiredTestEnv={QLOO_API_KEY:'worthless-offline-fixture-secret'};
const evidence=[];let fetches=0,routeWrites=0;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const seed={id:id(1),name:'Fixture Seed',type:'tv_show'};
const dest={id:id(2),name:'Fixture Target',type:'tv_show'};
const cand={id:id(3),name:'Fixture Bridge',type:'tv_show'};
const raw=e=>({entity_id:e.id,name:e.name,subtype:'urn:entity:'+e.type,query:{affinity:.85},properties:{release_year:2020}});
const bundle={schema:'acquired-route/2',route_id:'offline-fixture',meta:{destination_entity_id:dest.id,seed_entities:[seed]},config:{primary_metric:'好感'},steps:[{...cand,entity_id:cand.id,alternates:[{entity_id:id(4),name:'Fixture Alternative',type:'tv_show'}]},{...dest,entity_id:dest.id}]};
const session=JSON.stringify({routeData:JSON.stringify(bundle),steps:[{ratings:[{'好感':1}],skipped:[]},{}],rerouteCount:0});
let stored=new Map();let cooldownWrites=0;
const db={
 select(){return{from(table){const rows=()=>[...stored.values()].sort((a,b)=>Number(b.routeId.startsWith('auto2-'))-Number(a.routeId.startsWith('auto2-')));const q={where(){return q},limit:async()=>rows(),then(resolve,reject){return Promise.resolve(rows()).then(resolve,reject)}};return q}}},
 insert(table){return{values(value){if(table===globalThis.__acquiredTestRuns)return Promise.resolve();return{onConflictDoNothing:async()=>{if(!stored.has(value.routeId))stored.set(value.routeId,value)},onConflictDoUpdate:async()=>{stored.set(value.routeId,value);routeWrites++}}}}},
 update(){return{set(){return{where:async()=>{}}}}},
};
globalThis.__acquiredTestDb=db;
const ctx={db:()=>db,invalidateQueries(){}};
async function compile(relative,name,extra=''){
 let source=await readFile(path.join(root,relative),'utf8');
 source=source.replace(/import \{ env \} from ['"]cloudflare:workers['"];?/, 'const env=globalThis.__acquiredTestEnv;');
 source=source.replace(/import \{ getDb \} from ['"]@\/db['"];?/, 'const getDb=()=>globalThis.__acquiredTestDb;');
 source=source.replace(/import \{ acquiredRuns \} from ['"]@\/db\/schema['"];?/, 'const acquiredRuns=globalThis.__acquiredTestRuns;');
 source=source.replace(/import \{ Actions as CoreActions, SitesIntentActions \} from ['"]@\/lib\/acquired\/upstream-actions['"];?/, 'const CoreActions=globalThis.__acquiredTestActions;const SitesIntentActions=globalThis.__acquiredTestIntentActions;');
 source=source.replace(/from (['"])(\.[^'"]+|@\/[^'"]+)\1/g,(_,quote,p)=>{
  const abs=p.startsWith('@/')?path.join(root,p.slice(2)):path.resolve(root,path.dirname(relative),p);
  return 'from '+JSON.stringify(pathToFileURL(abs+(path.extname(abs)?'':'.ts')).href);
 });
 const js=ts.transpileModule(source+'\n'+extra,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const file=path.join(dir,name+'.mjs');await writeFile(file,js);return import(pathToFileURL(file).href);
}
try{
 const {Actions,SitesIntentActions,__test}=await compile('lib/acquired/upstream-actions.ts','core');
 globalThis.__acquiredTestActions=Actions;globalThis.__acquiredTestIntentActions=SitesIntentActions;
 globalThis.__acquiredTestRuns=(await compile('db/schema.ts','schema')).acquiredRuns;
 const {execute}=await compile('app/api/acquired/route.ts','boundary','export {execute};');
 const args=Actions.buildRoute.request.parse({seeds:[seed.name],destination:dest.name,steps:3,destPinned:dest,seedPinned:{0:seed}});
 const fast=()=>newTrace({minIntervalMs:0,cache:false});
 const tag=(name)=>({tag_id:'urn:tag:genre:media:'+name,name,query:{affinity:.99}});
 let mode='healthy',optionalCalls=0;
 const snapshot=[];
 globalThis.__acquiredTestEnv.DB={prepare(){return{bind(){return this},run:async()=>{cooldownWrites++}}}};
 function provider(){
  globalThis.fetch=async(input,init)=>{
   fetches++;const u=new URL(input),phase=currentPhase();snapshot.push({phase,path:u.pathname});
   if(phase==='explanation'){
    optionalCalls++;
    if(mode==='slow')return new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve(Response.json({results:{entities:[]}})),1000);init.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(init.signal.reason)},{once:true})});
    if(mode==='motivation-only')return Response.json({results:{entities:[],tags:[]}});
    if(mode==='network')throw Error('RAW_UNTRUSTED_OPTIONAL');
    if(mode==='429'||mode==='500')return new Response('RAW_UNTRUSTED_OPTIONAL',{status:Number(mode),headers:{'Retry-After':'90'}});
    if(mode==='signal')return Response.json({results:{entities:[]},warnings:[{type:'not_found','signal.interests.entities':[u.searchParams.get('signal.interests.entities')?.split(',')[0]]}]});
   }
   if(mode==='required-429'&&phase==='required')return new Response('RAW_UNTRUSTED_REQUIRED',{status:429});
   if(u.pathname==='/search')return Response.json({results:[raw(u.searchParams.get('query')===dest.name?dest:seed)]});
   if(u.searchParams.get('filter.type')==='urn:tag')return Response.json({results:{tags:[tag('Shared')]}});
   const ids=u.searchParams.get('filter.results.entities');
   const entities=ids?ids.split(',').map(entity_id=>({...raw(cand),entity_id})):Array.from({length:8},(_,i)=>raw({id:id(3+i),name:'Fixture Bridge '+i,type:'tv_show'}));
   return Response.json({results:{entities,tags:[]}});
  };
 }
 for(const m of ['healthy','429','500','network','signal','slow','count-cap','motivation-only']){
  mode=m;provider();stored.clear();fetches=0;optionalCalls=0;routeWrites=0;snapshot.length=0;
  const t=fast();if(m==='slow')t.explanationPolicy={limit:12,timeoutMs:25};if(m==='count-cap')t.explanationPolicy={limit:1,timeoutMs:12000};
  const start=Date.now(),out=await execute('buildRoute',m==='motivation-only'?{...args,manualMotivationSignals:[{label:'Shared',tagId:'urn:tag:genre:media:Shared'}]}:args,t),elapsed=Date.now()-start;
  assert.equal(out.result?.ok,true,JSON.stringify(out));assert.equal(out.saved,true);assert.equal(routeWrites,1);
  assert.equal(stored.get(out.result.route_id).data,out.result.bundle);
  const b=JSON.parse(out.result.bundle);assert.equal(b.steps.length,3);assert.ok(b.steps.every(s=>s.image!==undefined));
  const firstOptional=snapshot.findIndex(s=>s.phase==='explanation');assert.ok(firstOptional>=0);assert.ok(snapshot.slice(firstOptional).every(s=>s.phase==='explanation'));
  assert.equal(measuredDeliveryAllowed(t),true);assert.equal(t.exhausted,false);assert.equal(t.active,0);assert.equal(t.queued,0);
  if(['429','500','network','signal'].includes(m)){assert.equal(optionalCalls,1);assert.equal(b.meta.explanation_status,'partial');assert.ok(b.steps.every(s=>s.why.text.length>0&&s.why.explanation_status==='partial'));}
  if(m==='motivation-only'){assert.equal(b.meta.explanation_status,'partial');assert.ok(b.steps.some(s=>s.why.explanation_status==='partial'&&s.why.text.includes('标签里有')));}
  if(m==='429')assert.ok(out.cooldownUntil>Date.now()+85000);
  if(m==='slow'){assert.ok(elapsed<500);assert.equal(optionalCalls,1);assert.equal(t.explanation.exhausted,true);assert.equal(t.upstreamFailure,undefined);assert.ok(b.steps.every(s=>s.why.text.length>0));}
  if(m==='count-cap'){assert.equal(optionalCalls,1);assert.equal(t.explanation.exhausted,true);}
  assert.equal(JSON.stringify(out).includes('RAW_UNTRUSTED'),false);
  evidence.push({case:m,saved:out.saved,steps:b.steps.length,explanationStatus:b.meta.explanation_status,optionalCalls,elapsedMs:elapsed});
 }
 mode='required-429';provider();stored.clear();routeWrites=0;
 const stopped=await execute('buildRoute',args,fast());assert.equal(stopped.saved,false);assert.equal(stopped.result.ok,false);assert.equal(routeWrites,0);
 // A later required read invalidates the optional checkpoint; swallowed errors still cannot save.
 const handler=Actions.buildRoute.handler;
 try{
  Actions.buildRoute.handler=async()=>{await runExplanation(async()=>{});await trackedFetch('https://hackathon.api.qloo.com/search').catch(()=>{});return{ok:true,error:null,error_code:null,error_detail:null,bundle:JSON.stringify(bundle),route_id:bundle.route_id,need_choice:null,broken_constraint:null,conflict_decision:null,contract_version:2,motivation_report:null}};
  const out=await execute('buildRoute',args,fast());assert.equal(out.saved,false);assert.equal(out.result.ok,false);
 }finally{Actions.buildRoute.handler=handler}
 // Required failure, cancellation, and a required budget overrun are never eligible.
 for(const t of [Object.assign(fast(),{requiredComplete:true,cancelled:true}),Object.assign(fast(),{requiredComplete:true,exhausted:true}),Object.assign(fast(),{requiredComplete:true,upstreamFailure:{status:500,phase:'required'}})])assert.equal(measuredDeliveryAllowed(t),false);
 // Two interleaved contexts, plus queued sends in the failing context.
 for(const bad of ['A','B']){
  let release;const gate=new Promise(r=>release=r);let entered;const started=new Promise(r=>entered=r);let sends=0;
  globalThis.fetch=async input=>{sends++;const u=new URL(input),x=u.searchParams.get('signal.interests.entities');if(x===bad){entered();await gate;return Response.json({results:{entities:[]},warnings:[{type:'not_found',signal:{interests:{entities:[bad]}}}]})}return Response.json({results:{entities:[]}})};
  const a=fast(),b=fast(),badTrace=bad==='A'?a:b,goodTrace=bad==='A'?b:a;
  const call=(t,x)=>traceStorage.run(t,()=>__test.qlooGet('/v2/insights',{'signal.interests.entities':x},'worthless-key','ring'));
  const fail=Promise.allSettled([call(badTrace,bad),call(badTrace,bad),call(badTrace,bad)]);
  await started;const good=call(goodTrace,bad==='A'?'B':'A');release();
  await good;const failures=await fail;await call(goodTrace,bad==='A'?'B':'A');
  assert.ok(failures.every(x=>x.status==='rejected'));assert.equal(badTrace.signalFailure.entityIds[0],bad);assert.equal(goodTrace.signalFailure,undefined);assert.equal(goodTrace.upstreamFailure,undefined);assert.equal(sends,3);assert.equal(badTrace.calls.length,1);
  await assert.rejects(call(badTrace,bad));assert.equal(sends,3);
 }
 // Optional deadline includes time waiting behind a different request.
 let releaseQueue,enteredQueue;const holding=new Promise(r=>releaseQueue=r),queueEntered=new Promise(r=>enteredQueue=r);let optionalSends=0;
 globalThis.fetch=async input=>{if(new URL(input).pathname==='/search'){enteredQueue();await holding;}else optionalSends++;return Response.json({results:{entities:[]}})};
 const occupying=traceStorage.run(fast(),()=>trackedFetch('https://hackathon.api.qloo.com/search'));
 await queueEntered;
 const queuedTrace=fast();queuedTrace.explanationPolicy={limit:12,timeoutMs:25};const waitStarted=Date.now();
 await traceStorage.run(queuedTrace,()=>runExplanation(()=>Promise.allSettled(Array.from({length:8},(_,i)=>trackedFetch('https://hackathon.api.qloo.com/v2/insights?take='+i)))));
 await settleTrace(queuedTrace);assert.ok(Date.now()-waitStarted<100);assert.equal(queuedTrace.queued,0);assert.equal(queuedTrace.calls.length,0);
 releaseQueue();await occupying;
 await traceStorage.run(fast(),()=>trackedFetch('https://hackathon.api.qloo.com/search'));
 assert.equal(optionalSends,0);assert.equal(measuredDeliveryAllowed(queuedTrace),true);
 console.log(JSON.stringify({passed:true,cases:evidence,checks:['required I/O precedes optional','actual boundary save and exact readback','optional 429/500/network/signal/time/count degradation','429 preserves cooldown','required failure and swallowed later read cannot save','A/B isolation both directions and queued send blocking','optional deadline includes waiting behind another request; cancelled queued jobs never send'],liveQlooRequests:0},null,2));
 if(process.argv.includes('--save-evidence')){await mkdir(path.join(root,'evidence/phases'),{recursive:true});await writeFile(path.join(root,'evidence/phases/offline-summary.json'),JSON.stringify({passed:true,cases:evidence,liveQlooRequests:0},null,2)+'\n')}
}finally{
 globalThis.fetch=originalFetch;delete globalThis.__acquiredTestEnv;delete globalThis.__acquiredTestDb;delete globalThis.__acquiredTestActions;delete globalThis.__acquiredTestIntentActions;delete globalThis.__acquiredTestRuns;await rm(dir,{recursive:true,force:true});
}
