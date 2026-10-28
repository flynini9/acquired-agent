// Offline integration tests: execute the shipped core and Sites HTTP boundary
// with a dummy Secret, mocked fetch and an in-memory DB adapter. No real I/O.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import {newTrace,traceStorage,trackedFetch,settleTrace} from '../lib/acquired/telemetry.ts';
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
 const {Actions,SitesIntentActions,__test}=await compile('lib/acquired/upstream-actions.ts','core');
 globalThis.__acquiredTestActions=Actions;globalThis.__acquiredTestIntentActions=SitesIntentActions;
 globalThis.__acquiredTestRuns=(await compile('db/schema.ts','schema')).acquiredRuns;
 const {execute}=await compile('app/api/acquired/route.ts','boundary','export {execute};');
 const args=Actions.buildRoute.request.parse({seeds:[seed.name],destination:dest.name,steps:3,destPinned:dest,seedPinned:{0:seed}});
 const requested={'signal.interests.entities':seed.id+','+dest.id};
 const rejected=(warnings)=>__test.rejectedSignalIds({warnings},requested);
 assert.deepEqual(rejected([{type:'not_found','signal.interests.entities':[seed.id.toUpperCase(),'RAW_UNTRUSTED_WARNING_TEXT']}]),[seed.id]);
 assert.deepEqual(rejected([{type:'not_found','filter.results.entities':[seed.id]},{type:'other','signal.interests.entities':[seed.id]}]),[]);
 assert.deepEqual(rejected([{type:'not_found','signal.interests.entities':seed.id}]),[]);
 assert.deepEqual(rejected([{type:'not_found','signal.interests.entities':['not-requested']}]),[]);
 let mode='healthy';
 globalThis.fetch=async input=>{
  fetches++;const u=new URL(input);assert.equal(u.origin,'https://hackathon.api.qloo.com');
  if(u.pathname==='/search')return Response.json({results:[raw(u.searchParams.get('query')===dest.name?dest:seed)]});
  const candidates=u.searchParams.get('filter.results.entities');
  const entities=candidates?candidates.split(',').map(entity_id=>({...raw(cand),entity_id})):Array.from({length:6},(_,i)=>raw({id:id(3+i),name:'Fixture Bridge '+i,type:'tv_show'}));
  if(mode==='low-hop'&&!candidates)entities.forEach(e=>e.query.affinity=.6);
  const warning=mode==='bad-seed'&&candidates?{type:'not_found','signal.interests.entities':[seed.id,'RAW_UNTRUSTED_WARNING_TEXT']}:mode==='bad-dest'&&!candidates?{type:'not_found','signal.interests.entities':[dest.id]}:{type:'not_found','signal.interests.entities':['unrelated-id']};
  if((mode==='bad-seed'||mode==='no-affinity')&&candidates)entities.forEach(e=>delete e.query.affinity);
  return Response.json({results:{entities:mode==='empty-home'&&candidates?[]:entities,tags:[]},warnings:[warning]});
 };
 for(const [m,code] of [['bad-seed','signal_unavailable'],['bad-dest','signal_unavailable'],['empty-home','measurement_incomplete'],['no-affinity','measurement_incomplete']]){
  mode=m;fetches=0;const t=newTrace({minIntervalMs:0,cache:false});
  const out=Actions.buildRoute.response.parse(await traceStorage.run(t,()=>Actions.buildRoute.handler(ctx,args)));
  await settleTrace(t);
  assert.equal(out.ok,false);assert.equal(out.error_code,code);assert.equal(out.bundle,null);assert.equal(out.error_detail.retryable,false);
  assert.equal(out.error.includes('这条路修不通'),false);assert.equal(JSON.stringify(out).includes('RAW_UNTRUSTED'),false);
  assert.equal(JSON.stringify(out).includes(globalThis.__acquiredTestEnv.QLOO_API_KEY),false);
  if(m==='bad-seed'){assert.deepEqual(out.error_detail.signal_entity_ids,[seed.id]);assert.equal(out.error_detail.stage,'measure');const before=fetches;await assert.rejects(traceStorage.run(t,()=>trackedFetch('https://hackathon.api.qloo.com/search')));assert.equal(fetches,before);assert.equal(t.upstreamFailure,undefined);}
  if(code==='measurement_incomplete'){assert.equal(out.error_detail.measurement_counts.complete,0);assert.equal(out.error_detail.measurement_counts.eligible,6);assert.equal(out.error_detail.measurement_counts.home_measured,0);}
  evidence.push({mode:m,code,fetches,detail:out.error_detail});
 }
 mode='low-hop';const low=await traceStorage.run(newTrace({minIntervalMs:0,cache:false}),()=>Actions.buildRoute.handler(ctx,args));assert.equal(low.error_code,'broken');assert.equal(low.error.includes('0.6'),true);
 mode='bad-dest';let t=newTrace({minIntervalMs:0,cache:false});
 const parsed=Actions.parseConstraints.response.parse(await traceStorage.run(t,()=>Actions.parseConstraints.handler(ctx,{destinationEntityId:dest.id,barrier:'怕恐怖'})));
 assert.equal(parsed.error_code,'signal_unavailable');assert.equal(parsed.check_status.destination_evidence,'failed');
 mode='bad-seed';t=newTrace({minIntervalMs:0,cache:false});let wrapped=await execute('buildRoute',args,t);assert.equal(wrapped.result.error_code,'signal_unavailable');assert.equal(wrapped.saved,false);assert.equal(routeWrites,0);
 mode='healthy';const healthy=await traceStorage.run(newTrace({minIntervalMs:0,cache:false}),()=>Actions.buildRoute.handler(ctx,args));assert.equal(healthy.ok,true);assert.equal(JSON.parse(healthy.bundle).steps.length,3);
 // Even an accidentally swallowed signal failure cannot import a partial route.
 const original=Actions.buildRoute.handler;
 try{
  Actions.buildRoute.handler=async()=>{traceStorage.getStore().signalFailure={entityIds:[seed.id],stage:'measure'};return{ok:true,error:null,error_code:null,error_detail:null,bundle:JSON.stringify(bundle),route_id:bundle.route_id,need_choice:null,broken_constraint:null,conflict_decision:null,contract_version:2,motivation_report:null}};
  wrapped=await execute('buildRoute',args,newTrace({minIntervalMs:0,cache:false}));assert.equal(wrapped.result.error_code,'signal_unavailable');assert.equal(wrapped.result.bundle,null);assert.equal(wrapped.saved,false);assert.equal(routeWrites,0);
 }finally{Actions.buildRoute.handler=original}
 // Recovery lookup returns an explicit seed choice, never changes the target.
 const recovery=await traceStorage.run(newTrace({minIntervalMs:0,cache:false}),()=>SitesIntentActions.resolveIntentDestination.handler(ctx,{query:seed.name,field:'seed',index:0}));
 assert.equal(recovery.need_choice.field,'seed');assert.equal(recovery.need_choice.index,0);assert.equal(recovery.need_choice.candidates[0].id,seed.id);
 mode='bad-dest';const badCheck=await traceStorage.run(newTrace({minIntervalMs:0,cache:false}),()=>SitesIntentActions.checkIntentSignal.handler(ctx,{entityId:dest.id,targetType:'movie'}));assert.equal(badCheck.error_code,'signal_unavailable');
 globalThis.fetch=async()=>new Response('RAW_UNTRUSTED_BAD_REQUEST_TEXT',{status:400});
 const rejectedCheck=await traceStorage.run(newTrace({minIntervalMs:0,cache:false}),()=>SitesIntentActions.checkIntentSignal.handler(ctx,{entityId:seed.id,targetType:'movie'}));assert.equal(rejectedCheck.error_code,'signal_check_rejected');assert.equal(rejectedCheck.error_detail.status,400);assert.equal(rejectedCheck.error_detail.retryable,false);assert.equal(JSON.stringify(rejectedCheck).includes('RAW_UNTRUSTED'),false);
 globalThis.fetch=async()=>Response.json({results:{entities:[raw(cand)]}});
 mode='healthy';const goodCheck=await traceStorage.run(newTrace({minIntervalMs:0,cache:false}),()=>SitesIntentActions.checkIntentSignal.handler(ctx,{entityId:seed.id,targetType:'movie'}));assert.equal(goodCheck.ok,true);
 const {unavailableIds,isUnavailable,needsSignalReview}=await import('../lib/acquired/signal-recovery.ts');
 assert.deepEqual(unavailableIds({error_code:'signal_unavailable',error_detail:{signal_entity_ids:[seed.id]}}),[seed.id]);assert.equal(isUnavailable(seed.id.toUpperCase(),[seed.id]),true);assert.equal(isUnavailable(dest.id,[seed.id]),false);assert.equal(needsSignalReview({error_code:'measurement_incomplete'}),true);assert.equal(needsSignalReview({error_code:'broken'}),false);
 fetches=0;globalThis.fetch=async()=>{fetches++;return Response.json({results:{entities:[]},warnings:[{type:'not_found','signal.interests.entities':[seed.id]}]})};
 const invalidUrl='https://hackathon.api.qloo.com/v2/insights?signal.interests.entities='+seed.id;
 for(let i=0;i<2;i++)await traceStorage.run(newTrace({minIntervalMs:0}),()=>trackedFetch(invalidUrl,{headers:{'X-Api-Key':'worthless-invalid-cache-fixture'}}));
 assert.equal(fetches,2);
 const report={passed:true,kind:'actual Sites core and HTTP boundary with fixed offline provider',cases:evidence,healthyMockSteps:3,checks:['requested signal warning only','raw warning and Secret not reflected','typed failure propagates through parse/build','observed signal failure stops later sends','missing measurements distinct from low affinity','partial route never imported','recovery returns explicit seed choice','unavailable candidate comparison case-insensitive','measured low affinity retains broken classification','not_found success bodies are not cached','one association preflight distinguishes catalogue tags from usable signals','HTTP400 rejection remains distinct from explicit not_found'],liveQlooRequests:0};
 if(process.argv.includes('--save-evidence')){await mkdir(path.join(root,'evidence/signals'),{recursive:true});await writeFile(path.join(root,'evidence/signals/offline-summary.json'),JSON.stringify(report,null,2)+'\n')}
 console.log(JSON.stringify(report,null,2));
}finally{
 globalThis.fetch=originalFetch;delete globalThis.__acquiredTestEnv;delete globalThis.__acquiredTestDb;delete globalThis.__acquiredTestActions;delete globalThis.__acquiredTestIntentActions;delete globalThis.__acquiredTestRuns;await rm(dir,{recursive:true,force:true});
}
