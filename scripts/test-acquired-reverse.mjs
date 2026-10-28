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
 const {Actions,SitesIntentActions}=await compile('lib/acquired/upstream-actions.ts','core');
 globalThis.__acquiredTestActions=Actions;globalThis.__acquiredTestIntentActions=SitesIntentActions;
 globalThis.__acquiredTestRuns=(await compile('db/schema.ts','schema')).acquiredRuns;
 const {execute}=await compile('app/api/acquired/route.ts','boundary','export {execute};');
 const fast=()=>newTrace({minIntervalMs:0,cache:false});
 let status=200,hop=.85,allHorror=false,queries=[],branchCase=null;
 const invalidSignals={errors:[{message:"All of the provided signal.interests.entities were invalid. At least one valid signal or filter is required for entity insights.",path:"signal.interests.entities"}]};
 globalThis.fetch=async input=>{
  const u=new URL(input),p=u.searchParams,signal=p.get('signal.interests.entities'),ids=p.get('filter.results.entities');queries.push({signal,ids,type:p.get('filter.type')});
  if(u.pathname==='/search')return Response.json({results:[raw(p.get('query')===dest.name?dest:seed)]});
  if(p.get('filter.type')==='urn:tag')return Response.json({results:{tags:[]}});
  const resultType=p.get('filter.type');
  if(branchCase==='required'&&!ids&&signal===dest.id)return Response.json(invalidSignals,{status:400});
  if(branchCase==='oracle'&&ids)return Response.json(invalidSignals,{status:400});
  if(branchCase&&resultType==='urn:entity:artist'){
   if(branchCase==='network')throw Error('untrusted secret');
   if(branchCase==='generic'||branchCase==='spoof')return Response.json({errors:[{message:'different validation problem',path:'take'}]},{status:400,headers:branchCase==='spoof'?{'X-Acquired-Qloo-Rejection':'invalid_entity_signals'}:{}});
   if(branchCase==='rate')return Response.json(invalidSignals,{status:429});
   if(branchCase==='server')return Response.json(invalidSignals,{status:503});
   if(branchCase==='auth')return Response.json(invalidSignals,{status:401});
   return Response.json(invalidSignals,{status:400});
  }
  if(branchCase==='empty'&&!ids&&queries.some(q=>q.type==='urn:entity:artist'))return Response.json({results:{entities:[]}});

  if(!ids&&signal===dest.id&&status!==200)return Response.json({}, {status});
  // Forward destination measurements are empty throughout this fixture.
  // Reverse neighborhood measurements remain complete and usable.
  const es=ids===dest.id?[]:ids?ids.split(',').map(entity_id=>({...raw(cand),entity_id})):Array.from({length:6},(_,i)=>({...raw({id:id(3+i),name:'Bridge '+String.fromCharCode(65+i),type:'tv_show'}),query:{affinity:hop},properties:{genres:allHorror?['Horror']:[]}}));
  return Response.json({results:{entities:es}});
 };
 const args={seeds:[seed.name],destination:dest.name,steps:3,destPinned:dest,seedPinned:{0:seed}};
 const out=await execute('buildRoute',args,fast());assert.equal(out.result.ok,true);assert.equal(out.saved,true);const b=JSON.parse(out.result.bundle);
 assert.equal(b.steps.length,3);assert.equal(b.steps[2].entity_id,dest.id);assert.equal(b.meta.routing_method,'destination_backtracking');assert.equal(b.meta.forward_links,undefined);assert.equal(b.meta.link_validation,undefined);assert.equal(b.meta.reverse_links.length,2);
 for(let i=0;i<2;i++){const l=b.steps[i].reverse_link;assert.equal(l.to_entity_id,b.steps[i].entity_id);assert.equal(l.from_entity_id,b.steps[i+1].entity_id);assert.equal(l.affinity,.85);assert.equal(l.basis,'entity');assert.ok(b.steps[i].edge_note.includes('倒推实测'));}
 assert.equal(queries.filter(q=>q.ids===dest.id&&q.signal!==seed.id).length,0);assert.equal(stored.get(out.result.route_id).data,out.result.bundle);
 const read=await traceStorage.run(fast(),()=>Actions.getRoute.handler(ctx,{route_id:out.result.route_id}));assert.equal(read.route.data,out.result.bundle);
 const {connectionText}=await import('../lib/acquired/route-evidence.ts');
 assert.match(connectionText(b,b.steps[1],b.steps[2]),new RegExp('以《'+dest.name+'》为信号找到《'+b.steps[1].name+'》'));assert.ok(!connectionText(b,b.steps[1],b.steps[2]).includes('正向'));
 assert.match(connectionText(b,b.steps[1],{...b.steps[2],entity_id:id(99)}),/暂未补齐/);
 const legacy={meta:{forward_links:[{from_entity_id:seed.id,to_entity_id:dest.id,affinity:.9}]},steps:[]};assert.match(connectionText(legacy,{entity_id:seed.id,name:'A'},{entity_id:dest.id,name:'B'}),/0.900/);
 const pack={meta:{reverse_links:[{from_entity_id:'',to_entity_id:seed.id,from_name:'Pack',affinity:.8,basis:'pack',signal_entity_ids:[dest.id,id(88)]}]},steps:[]};assert.match(connectionText(pack,{entity_id:seed.id,name:'A'},{entity_id:dest.id,name:'B'}),/Pack》系列/);
 // Swap retains a measured reverse receipt and is not gated by the
 // missing opposite-direction destination score.
 const previousSelect=db.select;
 const sessionData=JSON.stringify({routeData:out.result.bundle,steps:b.steps.map(()=>({ratings:[],skipped:[]})),rerouteCount:0});
 db.select=()=>({from(){return{where(){return{limit:async()=>[{data:sessionData}]}}}}});
 const alt=b.steps[1].alternates[0];assert.ok(alt);
 const swapped=await traceStorage.run(fast(),()=>Actions.swapStepMeasured.handler(ctx,{session_id:1,step_index:1,alt_entity_id:alt.entity_id}));assert.equal(swapped.ok,true);const replacement=JSON.parse(swapped.step);assert.equal(replacement.reverse_link.from_entity_id,dest.id);assert.equal(replacement.reverse_link.to_entity_id,alt.entity_id);assert.equal(replacement.next_link,undefined);db.select=previousSelect;
 // Original reverse hop threshold and hard conditions still apply.
 hop=.6;const weak=await traceStorage.run(fast(),()=>Actions.buildRoute.handler(ctx,args));assert.equal(weak.ok,false);assert.equal(weak.bundle,null);hop=.85;
 allHorror=true;const avoided=await traceStorage.run(fast(),()=>Actions.buildRoute.handler(ctx,{...args,barrier:'怕恐怖',confirmedConflictIds:['avoid_horror']}));assert.equal(avoided.ok,false);assert.equal(avoided.error_code,'constraint_broken');allHorror=false;
 status=429;const limited=await execute('buildRoute',args,fast());assert.equal(limited.saved,false);assert.equal(limited.result.ok,false);assert.equal(limited.result.error_detail.status,429);
 assert.ok(!JSON.stringify(out).includes('worthless-offline-fixture-secret'));

 // Five stations reach optional cross-media discovery after the first
 // two same-media hops. A classified rejection must not poison the
 // independent branches or fabricate an affinity for the rejected one.
 status=200;branchCase='observed';queries=[];stored.clear();
 const branched=await execute('buildRoute',{...args,steps:5},fast());
 assert.equal(branched.result.ok,true,JSON.stringify(branched));assert.equal(branched.saved,true);
 const measured=JSON.parse(branched.result.bundle);
 assert.equal(measured.steps.length,5);assert.equal(measured.steps.at(-1).entity_id,dest.id);
 assert.equal(measured.meta.query_branch_policy,'verified_optional_type_rejection_v1');
 assert.ok(measured.meta.unavailable_query_branches.length>0);
 assert.ok(measured.meta.unavailable_query_branches.every(b=>b.result_type==='artist'&&b.reason==='invalid_entity_signals'));
 assert.ok(branched.trace.calls.filter(c=>c.status===400).every(c=>c.rejection==='invalid_entity_signals'));
 assert.ok(measured.meta.reverse_links.every(l=>typeof l.affinity==='number'&&l.affinity>=.72));
 assert.equal(stored.get(branched.result.route_id).data,branched.result.bundle);
 assert.match(measured.meta.provenance,/部分媒介未取得关联数据/);
 for(const mode of ['generic','spoof','rate','server','network','auth','required','oracle','empty']){
  branchCase=mode;queries=[];const priorWrites=routeWrites;
  const denied=await execute('buildRoute',{...args,steps:5},fast());
  assert.equal(denied.result.ok,false,mode+': must fail closed');assert.equal(denied.saved,false,mode);
  assert.equal(routeWrites,priorWrites,mode+': no partial-route write');
  assert.equal(denied.result.error_code,mode==='empty'?'measurement_incomplete':mode==='required'||mode==='oracle'||mode==='generic'||mode==='spoof'?'query_rejected':mode==='auth'?'auth':'upstream_unavailable',mode);
 }
 branchCase=null;
 const report={passed:true,liveQlooRequests:0,checks:['verified optional-type rejection skipped with measured five-station save/readback','generic/spoofed 400, auth, 429, 5xx, network, required rejection and empty remainder fail without save','reverse route saved despite missing forward destination value','exact reverse signal/result IDs persisted per edge','original three-station count and fixed destination','HTTP boundary save and exact readback','opposite-direction gate queries not sent','swap uses reverse receipt without forward hard gate','reverse threshold and Horror filter preserved','429 blocks saving','UI labels entity/pack signal direction and ignores stale receipts','legacy forward receipts remain readable','no Secret in response']};
 if(process.argv.includes('--save-evidence')){await mkdir(path.join(root,'evidence/reverse-routing'),{recursive:true});await writeFile(path.join(root,'evidence/reverse-routing/offline-summary.json'),JSON.stringify(report,null,2)+'\n')}
 console.log(JSON.stringify(report,null,2));
}finally{globalThis.fetch=originalFetch;delete globalThis.__acquiredTestEnv;delete globalThis.__acquiredTestDb;delete globalThis.__acquiredTestActions;delete globalThis.__acquiredTestIntentActions;delete globalThis.__acquiredTestRuns;await rm(dir,{recursive:true,force:true})}
