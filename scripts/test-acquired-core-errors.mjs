// Offline integration tests: execute the shipped core and Sites HTTP boundary
// with a dummy Secret, mocked fetch and an in-memory DB adapter. No real I/O.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import {guestToken,GUEST_COOKIE} from '../lib/acquired/guest-identity.ts';
import {newTrace,traceStorage,trackedFetch} from '../lib/acquired/telemetry.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=await mkdtemp(path.join(root,'node_modules/.acquired-errors-'));
const originalFetch=globalThis.fetch;
globalThis.__acquiredTestEnv={QLOO_API_KEY:'worthless-offline-fixture-secret',ACQUIRED_GUEST_SECRET:'worthless-offline-guest-secret-at-least-32'};
const guest=await guestToken(globalThis.__acquiredTestEnv.ACQUIRED_GUEST_SECRET);
const guestHeaders={'Content-Type':'application/json',cookie:GUEST_COOKIE+'='+guest.token};
const evidence=[];let fetches=0,routeWrites=0;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const seed={id:id(1),name:'Fixture Seed',type:'tv_show'};
const dest={id:id(2),name:'Fixture Target',type:'tv_show'};
const cand={id:id(3),name:'Fixture Bridge',type:'tv_show'};
const raw=e=>({entity_id:e.id,name:e.name,subtype:'urn:entity:'+e.type,query:{affinity:.85},properties:{release_year:2020,image:{url:'https://images.qloo.com/i/'+e.id+'-420x-auto.jpg'}}});
const bundle={schema:'acquired-route/2',route_id:'offline-fixture',meta:{destination_entity_id:dest.id,seed_entities:[seed]},config:{primary_metric:'好感'},steps:[{...cand,entity_id:cand.id,alternates:[{entity_id:id(4),name:'Fixture Alternative',type:'tv_show',image:'https://images.qloo.com/i/'+id(4)+'-420x-auto.jpg',year:2021}]},{...dest,entity_id:dest.id}]};
const session=JSON.stringify({routeData:JSON.stringify(bundle),steps:[{ratings:[{'好感':1}],skipped:[]},{}],rerouteCount:0});
const db={
 select(){return{from(){return{where(){return{limit:async()=>[{data:session}]}}}}}},
 insert(table){return{values(value){if(table!==globalThis.__acquiredTestRuns)routeWrites++;return Promise.resolve(value)}}},
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
 const {Actions,SitesIntentActions,parseRetryAfter}=await compile('lib/acquired/upstream-actions.ts','core','export {parseRetryAfter};');
 globalThis.__acquiredTestActions=Actions;
 globalThis.__acquiredTestIntentActions=SitesIntentActions;
 globalThis.__acquiredTestRuns=(await compile('db/schema.ts','schema')).acquiredRuns;
 const {execute,POST}=await compile('app/api/acquired/route.ts','boundary','export {execute};');
 const buildArgs=Actions.buildRoute.request.parse({seeds:[seed.name],destination:dest.name,steps:3,destPinned:dest,seedPinned:{0:seed}});
 function stub(failStage,status=429){
  fetches=0;
  globalThis.fetch=async input=>{
   fetches++;const u=new URL(input);assert.equal(u.origin,'https://hackathon.api.qloo.com');
   const stage=u.pathname==='/search'?'resolve':u.searchParams.get('filter.type')==='urn:tag'?'profile':u.searchParams.has('filter.results.entities')?'measure':'ring';
   if(stage===failStage){if(status==='network')throw new Error('RAW_UNTRUSTED_NETWORK_TEXT');return new Response('RAW_UNTRUSTED_UPSTREAM_TEXT',{status,headers:{'Retry-After':'30'}})}
   if(stage==='resolve'){const e=u.searchParams.get('query')===dest.name?dest:seed;return Response.json({results:[raw(e)]})}
   return Response.json({results:{entities:[raw(cand)],tags:[]}});
  };
 }
 for(const [stage,status] of [['resolve',429],['resolve',500],['resolve','network'],['ring',429],['measure',429],['profile',429]]){
  stub(stage,status);const t=newTrace({minIntervalMs:0,cache:false});const args={...buildArgs,...(stage==='profile'?{barrier:'怕血腥'}:{})};
  const result=Actions.buildRoute.response.parse(await traceStorage.run(t,()=>Actions.buildRoute.handler(ctx,args)));
  assert.equal(result.ok,false);assert.equal(result.error_code,'upstream_unavailable');assert.equal(result.error_detail.stage,stage);
  assert.equal(result.error_detail.reason,status==='network'?'network':status===429?'rate_limited':'upstream_5xx');
  assert.equal(result.error_detail.status,status==='network'?null:status);assert.equal(result.bundle,null);
  assert.equal(JSON.stringify(result).includes('RAW_UNTRUSTED'),false);assert.equal(JSON.stringify(result).includes(globalThis.__acquiredTestEnv.QLOO_API_KEY),false);
  evidence.push({action:'buildRoute',stage,status,code:result.error_code,fetches});
 }
 for(const [action,args] of [['swapStepMeasured',{session_id:1,step_index:0,alt_entity_id:id(4)}],['rerouteFromStep',{session_id:1,cliff_index:0,like_score:1}]]){
  stub('resolve');const a=Actions[action];const t=newTrace({minIntervalMs:0,cache:false});const result=a.response.parse(await traceStorage.run(t,()=>a.handler(ctx,a.request.parse(args))));
  assert.equal(result.error_code,'upstream_unavailable');assert.equal(result.error_detail.reason,'rate_limited');assert.equal('step' in result?result.step:result.bundle,null);
  evidence.push({action,stage:result.error_detail.stage,status:429,code:result.error_code,fetches});
 }
 for(const status of [401,403]){stub('resolve',status);const result=await traceStorage.run(newTrace({minIntervalMs:0,cache:false}),()=>Actions.buildRoute.handler(ctx,buildArgs));assert.equal(result.error_code,'auth');assert.equal(result.error_detail,null)}
 // A healthy mock graph must still produce a full route, not only errors.
 globalThis.fetch=async input=>{
  const u=new URL(input);assert.equal(u.origin,'https://hackathon.api.qloo.com');
  if(u.pathname==='/search')return Response.json({results:[raw(u.searchParams.get('query')===dest.name?dest:seed)]});
  const ids=u.searchParams.get('filter.results.entities');
  const entities=ids?ids.split(',').map(entity_id=>({...raw(cand),entity_id})):Array.from({length:8},(_,i)=>raw({id:id(3+i),name:`Fixture Bridge ${i}`,type:'tv_show'}));
  return Response.json({results:{entities,tags:[]}});
 };
 const healthy=await traceStorage.run(newTrace({minIntervalMs:0,cache:false}),()=>Actions.buildRoute.handler(ctx,buildArgs));assert.equal(healthy.ok,true);assert.equal(JSON.parse(healthy.bundle).steps.length,3);assert.ok(JSON.parse(healthy.bundle).steps.every(s=>s.image?.startsWith('https://images.qloo.com/i/')));assert.ok(JSON.parse(healthy.bundle).steps[0].alternates.every(s=>s.image?.startsWith('https://images.qloo.com/i/')));
 const imageSwap=await traceStorage.run(newTrace({minIntervalMs:0,cache:false}),()=>Actions.swapStepMeasured.handler(ctx,{session_id:1,step_index:0,alt_entity_id:id(4)}));assert.equal(imageSwap.ok,true);assert.equal(JSON.parse(imageSwap.step).image,bundle.steps[0].alternates[0].image);assert.equal(JSON.parse(imageSwap.step).year,2021);
 // Resolve identities first; only the measured neighborhood is empty.
 globalThis.fetch=async input=>{const u=new URL(input);return Response.json(u.pathname==='/search'?{results:[raw(u.searchParams.get('query')===dest.name?dest:seed)]}:{results:{entities:[],tags:[]}})};const noRoute=await traceStorage.run(newTrace({minIntervalMs:0,cache:false}),()=>Actions.buildRoute.handler(ctx,buildArgs));assert.equal(noRoute.error_code,'broken');
 const missingKey=globalThis.__acquiredTestEnv.QLOO_API_KEY;delete globalThis.__acquiredTestEnv.QLOO_API_KEY;
 assert.equal((await Actions.buildRoute.handler(ctx,buildArgs)).error_code,'no_key');globalThis.__acquiredTestEnv.QLOO_API_KEY=missingKey;
 assert.equal(parseRetryAfter(new Response('',{headers:{'retry-after':'30'}})),30);
 assert.equal(parseRetryAfter(new Response('',{headers:{'retry-after':'30garbage'}})),null);
 const future=new Date(Date.now()+30000).toUTCString();assert.ok(parseRetryAfter(new Response('',{headers:{'retry-after':future}}))>=29);
 // Test the real Sites boundary, including its reject-before-import guard.
 stub('resolve');let t=newTrace({minIntervalMs:0,cache:false});const wrapped=await execute('buildRoute',buildArgs,t);
 assert.equal(wrapped.result.error_code,'upstream_unavailable');assert.equal(wrapped.result.error_detail.stage,'resolve');assert.equal(wrapped.saved,false);assert.equal(routeWrites,0);
 const originalHandler=Actions.buildRoute.handler;
 try{
  Actions.buildRoute.handler=async()=>{await trackedFetch('https://hackathon.api.qloo.com/search');return{ok:true,error:null,error_code:null,error_detail:null,bundle:JSON.stringify(bundle),route_id:'offline-fixture',need_choice:null,broken_constraint:null,contract_version:2,motivation_report:null,conflict_decision:null}};
  stub('resolve');t=newTrace({minIntervalMs:0,cache:false});const partial=await execute('buildRoute',buildArgs,t);assert.equal(partial.result.ok,false);assert.equal(partial.saved,false);assert.equal(partial.result.bundle,null);assert.equal(routeWrites,0);
  stub('resolve');t=newTrace({minIntervalMs:0,cache:false});t.limit=0;const budget=await execute('buildRoute',buildArgs,t);assert.equal(budget.trace.budgetExhausted,true);assert.equal(budget.result,undefined);assert.equal(budget.error_code,undefined);assert.equal(fetches,0);
 }finally{Actions.buildRoute.handler=originalHandler}
 const until=Date.now()+60000;
 globalThis.__acquiredTestEnv.DB={prepare(){return{first:async()=>({expires_at:until}),bind(){return this},all:async()=>({results:[{request_id:'fixture'}]}),run:async()=>{}}}};
 fetches=0;globalThis.fetch=async()=>{fetches++;throw Error('cooldown must block before provider')};
 const stopped=await POST(new Request('https://fixture.invalid/api/acquired',{method:'POST',headers:guestHeaders,body:JSON.stringify({action:'buildRoute',args:buildArgs})}));
 assert.equal(stopped.status,429);assert.equal((await stopped.json()).error_code,'local_cooldown');assert.equal(fetches,0);
 const editable=await POST(new Request('https://fixture.invalid/api/acquired',{method:'POST',headers:guestHeaders,body:JSON.stringify({action:'parseConstraints',args:{barrier:'怕血腥'}})}));assert.equal(editable.status,200);assert.equal(fetches,0);
 delete globalThis.__acquiredTestEnv.DB;
 const report={passed:true,kind:'offline mocked integration; not hosted provider verification',upstream:'9307b9931d442a96fc4fdd844c6b94722a6d1096',cases:evidence,healthyMockRouteSteps:3,compatibility:['auth','broken','no_key'],retryAfter:['seconds','http-date','invalid'],boundary:['core detail preserved','partial success rejected before import','budget distinct from provider','persisted cooldown blocks provider; pure parse still works'],routeWrites,liveRequests:0};
 if(process.argv.includes('--save-evidence')){await mkdir(path.join(root,'evidence/upstream-errors'),{recursive:true});await writeFile(path.join(root,'evidence/upstream-errors/offline-summary.json'),JSON.stringify(report,null,2)+'\n')}
 console.log(JSON.stringify(report,null,2));
}finally{
 globalThis.fetch=originalFetch;delete globalThis.__acquiredTestEnv;delete globalThis.__acquiredTestDb;delete globalThis.__acquiredTestActions;delete globalThis.__acquiredTestIntentActions;delete globalThis.__acquiredTestRuns;await rm(dir,{recursive:true,force:true});
}
