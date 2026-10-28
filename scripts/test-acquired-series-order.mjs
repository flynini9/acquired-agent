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
 const {seriesOrderConflict,routeSeriesConflict,catalogEntrySeries}=await import('../lib/acquired/entry-series.ts');
 const saved=JSON.parse(await readFile(path.join(root,'evidence/series-order/screenshot-route.json'),'utf8'));
 const first=saved.steps[1],second=saved.steps[0],target=saved.steps.at(-1),source=saved.meta.seed_entities[0];
 assert.ok(routeSeriesConflict(saved.steps),'Actual screenshot must reproduce inverted series order');
 assert.equal(routeSeriesConflict([first,second,target]),null,'Correct sequence is permitted, not a franchise ban');
 const omnibus=JSON.parse(await readFile(path.join(root,'evidence/series-order/hosted-iteration-1/new-route.json'),'utf8')).steps[0];
 assert.ok(seriesOrderConflict(omnibus,first),'Actual first hosted result: #1-3 omnibus before #1 is invalid');
 assert.ok(seriesOrderConflict(first,omnibus),'Overlapping single volume before omnibus is also invalid');
 assert.ok(seriesOrderConflict({...omnibus,name:'The Foundation Trilogy (Foundation, #1–3)'},first),'Unicode range recognized');
 assert.equal(seriesOrderConflict({...omnibus,name:'Volumes (Foundation, #1-3)'},{name:'Later (Foundation, #4)',type:'book'}),null,'Disjoint correctly ordered ranges are allowed');

 assert.ok(routeSeriesConflict([second,{name:'Unrelated',type:'book'},first,target]),'Nonadjacent inversion must be rejected');
 assert.equal(seriesOrderConflict({name:'Rocky II',type:'movie'},{name:'Rocky',type:'movie'})!=null,true);
 assert.equal(seriesOrderConflict({name:'Rocky',type:'movie'},{name:'Rocky II',type:'movie'}),null);
 assert.equal(seriesOrderConflict({name:'Dune: Part Two',type:'movie'},{name:'Dune',type:'movie'})!=null,true);
 assert.equal(seriesOrderConflict({name:'冰雪奇缘2',type:'movie'},{name:'冰雪奇缘',type:'movie'})!=null,true);
 assert.equal(seriesOrderConflict({name:'Queen II',type:'album'},{name:'Queen',type:'artist'}),null);
 assert.equal(seriesOrderConflict({name:'Unrelated late book',type:'book',year:2020},{name:'Unrelated early book',type:'book',year:1960}),null,'Release years do not define route order');
 assert.ok(seriesOrderConflict({name:'Renamed sequel',type:'movie',description:'A sequel to The Original.'},{name:'The Original',type:'movie'}));
 assert.equal(seriesOrderConflict({name:'Unrelated',type:'movie',description:'A sequel to Another Work, inspired by The Original.'},{name:'The Original',type:'movie'}),null);
 const independent=Array.from({length:5},(_,i)=>({id:id(60+i),name:'Independent fixture bridge '+String.fromCharCode(65+i),type:'book'}));
 const destination={id:target.entity_id,name:target.name,type:target.type};
 const all=[source,first,second,target,omnibus,...independent],catalog=new Map(all.map(e=>[e.id??e.entity_id,e]));
 const raw=e=>({entity_id:e.id??e.entity_id,name:e.name,types:['urn:entity:'+e.type],subtype:'urn:entity:'+e.type,properties:{description:e.entrySeries?.description??e.description??'',publication_year:e.year??2020}});
 let mode='repair',queries=[];
 globalThis.fetch=async input=>{
  const u=new URL(input),p=u.searchParams,signal=p.get('signal.interests.entities'),ids=p.get('filter.results.entities');queries.push({signal,ids});
  if(u.pathname==='/search')return Response.json({results:all.filter(e=>e.name===p.get('query')).map(raw)});
  if(p.get('filter.type')==='urn:tag')return Response.json({results:{tags:[]}});
  if(ids)return Response.json({results:{entities:ids.split(',').map(entity_id=>({...raw(catalog.get(entity_id)??independent[0]),entity_id,query:{affinity:.85}}))}});
  let pool;
  if(mode==='only-inversion')pool=signal===destination.id?[{...raw(first),query:{affinity:.95}}]:[{...raw(second),query:{affinity:.99}}];
  else pool=[{...raw(omnibus),query:{affinity:.945}},{...raw(first),query:{affinity:mode==='ordered'?.94:.96}},{...raw(second),query:{affinity:mode==='ordered'?.99:.95}},...independent.map(e=>({...raw(e),query:{affinity:.85}}))];
  return Response.json({results:{entities:pool}});
 };
 const fast=()=>newTrace({minIntervalMs:0,cache:false});
 const args={seeds:[source.name],destination:destination.name,steps:3,destPinned:destination,seedPinned:{0:source}};
 const out=await execute('buildRoute',args,fast());assert.equal(out.result.ok,true,JSON.stringify(out));assert.equal(out.saved,true);
 const b=JSON.parse(out.result.bundle);assert.equal(b.steps[1].entity_id,first.entity_id);assert.notEqual(b.steps[0].entity_id,second.entity_id);assert.equal(routeSeriesConflict(b.steps),null);assert.equal(b.steps.at(-1).entity_id,destination.id);
 assert.equal(b.meta.series_order_policy,'catalogue_sequence_v1');assert.ok(b.meta.series_order_exclusions.some(x=>x.entity_id===second.entity_id));
 for(let i=0;i<b.steps.length;i++)for(const alt of b.steps[i].alternates)assert.equal(routeSeriesConflict(b.steps.map((s,k)=>k===i?alt:s)),null);
 assert.equal(stored.get(out.result.route_id).data,out.result.bundle);
 // An actually measured, correctly ordered #1 -> #2 remains allowed.
 mode='ordered';const ordered=await traceStorage.run(fast(),()=>Actions.buildRoute.handler(ctx,args));assert.equal(ordered.ok,true);const ob=JSON.parse(ordered.bundle);assert.deepEqual(ob.steps.slice(0,2).map(s=>s.entity_id),[first.entity_id,second.entity_id]);assert.equal(routeSeriesConflict(ob.steps),null);
 for(let i=0;i<2;i++){assert.equal(ob.steps[i].reverse_link.from_entity_id,ob.steps[i+1].entity_id);assert.equal(ob.steps[i].reverse_link.to_entity_id,ob.steps[i].entity_id);}
 // A legacy alternate introducing #2 before #1 is rejected without I/O.
 const legacy=structuredClone(b);legacy.steps[0].alternates=[second];
 let sessionData=JSON.stringify({routeData:JSON.stringify(legacy),steps:legacy.steps.map(()=>({ratings:[{'好感':1}],skipped:[]})),rerouteCount:0});
 const previousSelect=db.select;db.select=()=>({from(){return{where(){return{limit:async()=>[{data:sessionData}]}}}}});
 queries=[];const badSwap=await traceStorage.run(fast(),()=>Actions.swapStepMeasured.handler(ctx,{session_id:1,step_index:0,alt_entity_id:second.entity_id}));assert.equal(badSwap.ok,false);assert.match(badSwap.error,/倒序/);assert.equal(queries.length,0);
 // Swaps inspect effective overrides, including nonadjacent stations.
 const effective=structuredClone(legacy);effective.steps[0].alternates=[{...second,name:'Later volume (Foundation, #3)'}];
 sessionData=JSON.stringify({routeData:JSON.stringify(effective),steps:effective.steps.map((s,i)=>({ratings:[],skipped:[],...(i===1?{override:second}:{})})),rerouteCount:0});
 queries=[];const overrideSwap=await traceStorage.run(fast(),()=>Actions.swapStepMeasured.handler(ctx,{session_id:1,step_index:0,alt_entity_id:second.entity_id}));assert.equal(overrideSwap.ok,false);assert.match(overrideSwap.error,/第 3 部.*第 2 部/);assert.equal(queries.length,0);
 // Rebuild a tail after an effective visited #2; no #1 may follow it.
 mode='repair';const prefixRoute={...b,steps:[b.steps[0],b.steps[0],target]};
 sessionData=JSON.stringify({routeData:JSON.stringify(prefixRoute),steps:prefixRoute.steps.map((s,i)=>({ratings:[{'好感':1}],skipped:[],...(i===0?{override:second}:{})})),rerouteCount:0});
 const tail=await traceStorage.run(fast(),()=>Actions.rerouteFromStep.handler(ctx,{session_id:1,cliff_index:1,like_score:1}));assert.equal(tail.ok,true,JSON.stringify(tail));const tb=JSON.parse(tail.bundle);assert.equal(routeSeriesConflict([second,...tb.steps.slice(1)]),null);assert.ok(!tb.steps.slice(1).some(s=>s.entity_id===first.entity_id));assert.ok(tb.meta.series_order_exclusions.some(x=>x.entity_id===first.entity_id),'The visited-prefix guard must actually exclude the lower volume');
 db.select=previousSelect;
 // The graph has connections, but every remaining bridge is inverted.
 mode='only-inversion';const writes=routeWrites;const failed=await execute('buildRoute',args,fast());assert.equal(failed.result.ok,false);assert.equal(failed.saved,false);assert.equal(failed.result.bundle,null);assert.match(failed.result.error,/sequel before an earlier entry/);assert.equal(routeWrites,writes);
 const report={passed:true,liveQlooRequests:0,source:'Actual saved Foundation #2 -> #1 -> Dune screenshot identities, mocked Qloo measurements',checks:['entire route, including nonadjacent pairs','candidate rejection before measurement','properly measured #1 -> #2 allowed','route edges retain measured signal/result direction','all completed-route alternates checked','actual hosted #1-3 omnibus overlap rejected in both directions','legacy swap rejects with zero calls','effective overrides considered','reroute respects entire visited prefix','only inverted continuation fails without save','movie/Chinese explicit numbering and named sequel dependencies','no release-year or music heuristic']};
 await mkdir(path.join(root,'evidence/series-order'),{recursive:true});await writeFile(path.join(root,'evidence/series-order/offline-summary.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{globalThis.fetch=originalFetch;delete globalThis.__acquiredTestEnv;delete globalThis.__acquiredTestDb;delete globalThis.__acquiredTestActions;delete globalThis.__acquiredTestIntentActions;delete globalThis.__acquiredTestRuns;await rm(dir,{recursive:true,force:true})}
