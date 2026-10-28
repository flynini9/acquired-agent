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
 const {entrySeriesReason,catalogEntrySeries}=await import('../lib/acquired/entry-series.ts');
 const saved=JSON.parse(await readFile(path.join(root,'evidence/gallery-workspace-2026-10-27/saved-twilight-route.json'),'utf8'));
 const target=saved.steps.at(-1),origin=saved.meta.seed_entities[0];
 const destination={id:target.entity_id,name:target.name,type:target.type};
 const source={id:origin.id,name:origin.name,type:origin.type};
 const successors=[...new Map(saved.steps.flatMap(s=>[s,...(s.alternates??[])]).filter(s=>s.name.startsWith('The Twilight Saga:')).map(s=>[s.entity_id,s])).values()];
 assert.equal(successors.length,4);
 for(const sequel of successors)assert.ok(entrySeriesReason(sequel,target),sequel.name);
 const work=(name,type='movie',description='')=>({name,type,description});
 for(const name of ['Twilight Zone','Twilight of the Gods','Twilight Samurai'])assert.equal(entrySeriesReason(work(name),target),null,name);
 assert.equal(entrySeriesReason(work('Twilight','book'),target),null);
 assert.equal(entrySeriesReason(work('Crash'),work('Crash')),null,'Homonyms are not proof of a franchise');
 assert.equal(entrySeriesReason(work('The Crash'),work('Crash')),null,'An article is not a sequel marker');
 assert.equal(entrySeriesReason(work('Independent','movie','Inspired by Twilight, this is a sequel to Another Story.'),target),null);
 assert.equal(entrySeriesReason(work('Independent','movie','A sequel to Another Story, inspired by Twilight.'),target),null);
 assert.ok(entrySeriesReason(work('New Moon','movie','A sequel to Twilight (2008).'),target));
 assert.ok(entrySeriesReason(work('Renamed Work','movie','The third installment in the Twilight film series.'),target));
 assert.ok(entrySeriesReason(work('Rocky II'),work('Rocky')));
 assert.ok(entrySeriesReason(work('Saw II'),work('Saw')));
 assert.ok(entrySeriesReason(work('冰雪奇缘2'),work('冰雪奇缘')),'Chinese numbered sequel');
 assert.equal(entrySeriesReason(work('Queen II','album'),work('Queen','artist')),null,'Music entry routes stay available');
 const series=catalogEntrySeries({properties:{franchise:'Fixture Franchise'},tags:[{id:'urn:tag:genre:qloo:vampire',name:'Vampire'}]});
 assert.deepEqual(series.groups,['fixture franchise']);
 assert.ok(entrySeriesReason({...work('Different Title'),entrySeries:series},{...work('Original'),entrySeries:series}));
 assert.deepEqual(catalogEntrySeries({tags:[{id:'urn:tag:genre:qloo:vampire',name:'Vampire'}]}).groups,[]);
 const rawWork=e=>({entity_id:e.id??e.entity_id,name:e.name,types:['urn:entity:'+e.type],subtype:'urn:entity:'+e.type,query:{affinity:.99},properties:{description:e.description??e.bio??'',release_year:e.year??2020}});
 const independent=Array.from({length:6},(_,i)=>({id:id(30+i),name:'Independent fixture bridge '+String.fromCharCode(65+i),type:'movie'}));
 const catalog=new Map([source,destination,...successors,...independent].map(e=>[e.id??e.entity_id,e]));
 let onlySeries=false,queries=[];
 const fast=()=>newTrace({minIntervalMs:0,cache:false});
 globalThis.fetch=async input=>{
  const u=new URL(input),p=u.searchParams,signal=p.get('signal.interests.entities'),ids=p.get('filter.results.entities');
  queries.push({signal,ids,type:p.get('filter.type')});
  if(u.pathname==='/search')return Response.json({results:[rawWork(p.get('query')===destination.name?destination:source)]});
  if(p.get('filter.type')==='urn:tag')return Response.json({results:{tags:[]}});
  const es=ids?ids.split(',').map(entity_id=>({...rawWork(catalog.get(entity_id)??independent[0]),entity_id,query:{affinity:.85}}))
   :[...successors.map(rawWork),...(onlySeries?[]:independent.map(e=>({...rawWork(e),query:{affinity:.85}})))];
  return Response.json({results:{entities:es}});
 };
 const args={seeds:[source.name],destination:destination.name,steps:5,destPinned:destination,seedPinned:{0:source}};
 const out=await execute('buildRoute',args,fast());assert.equal(out.result.ok,true,JSON.stringify(out));assert.equal(out.saved,true);
 const b=JSON.parse(out.result.bundle);
 assert.equal(b.steps.length,5);assert.equal(b.steps.at(-1).entity_id,destination.id);
 assert.equal(b.meta.routing_method,'destination_backtracking');assert.equal(b.meta.entry_policy,'exclude_destination_series_v1');
 assert.equal(b.meta.entry_exclusions.length,4);
 for(const step of b.steps.slice(0,-1)){
  assert.equal(entrySeriesReason(step,target),null);
  for(const alt of step.alternates)assert.equal(entrySeriesReason(alt,target),null);
 }
 const excludedIds=new Set(successors.map(s=>s.entity_id));
 assert.ok(queries.every(q=>!q.ids||q.ids.split(',').every(id=>!excludedIds.has(id))),'Excluded sequels must not cost oracle measurements');
 assert.equal(stored.get(out.result.route_id).data,out.result.bundle);
 // A legacy saved alternate must also be rejected, without Qloo I/O.
 let sessionData=JSON.stringify({routeData:JSON.stringify(saved),steps:saved.steps.map(()=>({ratings:[],skipped:[]})),rerouteCount:0});
 const previousSelect=db.select;
 db.select=()=>({from(){return{where(){return{limit:async()=>[{data:sessionData}]}}}}});
 queries=[];
 const oldAlt=saved.steps[3].alternates[0];
 const rejected=await traceStorage.run(fast(),()=>Actions.swapStepMeasured.handler(ctx,{session_id:1,step_index:3,alt_entity_id:oldAlt.entity_id}));
 assert.equal(rejected.ok,false);assert.match(rejected.error,/同系列/);assert.equal(rejected.step,null);assert.equal(queries.length,0);
 // The same filter must govern a rerouted tail, preserving destination.
 sessionData=JSON.stringify({routeData:out.result.bundle,steps:b.steps.map(()=>({ratings:[{'好感':1}],skipped:[]})),rerouteCount:0});
 const rerouted=await traceStorage.run(fast(),()=>Actions.rerouteFromStep.handler(ctx,{session_id:1,cliff_index:0,like_score:1}));
 assert.equal(rerouted.ok,true,JSON.stringify(rerouted));
 const tail=JSON.parse(rerouted.bundle);assert.equal(tail.steps.length,5);assert.equal(tail.steps.at(-1).entity_id,destination.id);
 assert.ok(tail.steps.slice(0,-1).every(s=>entrySeriesReason(s,target)===null));
 db.select=previousSelect;
 // Honest failure if the neighborhood has only the destination's series.
 onlySeries=true;queries=[];const writesBefore=routeWrites;
 const noBridge=await execute('buildRoute',args,fast());
 assert.equal(noBridge.result.ok,false);assert.equal(noBridge.saved,false);assert.equal(noBridge.result.bundle,null);assert.equal(noBridge.result.error_code,"broken");assert.equal(noBridge.result.error,"No complete measured route was found with these entries and preferences. Try another starting point or review your preferences.");assert.equal(routeWrites,writesBefore);
 assert.equal(queries.filter(q=>q.ids).length,0,'No measurements for rejected sequels');
 const report={passed:true,liveQlooRequests:0,actualSavedRoute:'Twilight five-stop screenshot',replayedSuccessors:successors.map(s=>s.name),checks:['actual saved four Twilight sequels excluded','independent five-stop build and alternates retained','same destination and reverse routing thresholds retained','exclusions happen before home measurements','exact boundary save/readback','legacy alternate rejected without I/O','reroute uses same series guard','only-series pool fails without save or padding','homonyms, unrelated Twilight titles, adaptation and artist routes retained','explicit catalog series and narrative relationship evidence supported']};
 await mkdir(path.join(root,'evidence/entry-series'),{recursive:true});await writeFile(path.join(root,'evidence/entry-series/offline-summary.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{globalThis.fetch=originalFetch;delete globalThis.__acquiredTestEnv;delete globalThis.__acquiredTestDb;delete globalThis.__acquiredTestActions;delete globalThis.__acquiredTestIntentActions;delete globalThis.__acquiredTestRuns;await rm(dir,{recursive:true,force:true})}
