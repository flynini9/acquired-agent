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
 const saved=JSON.parse(await readFile(path.join(root,'evidence/destination-content/screenshot-route.json'),'utf8'));
 const target=saved.steps.at(-1),guide=saved.steps[2],otherGuide=saved.steps[3],origin=saved.meta.seed_entities[0];
 const legacyCollection=saved.steps[3].alternates[1];
 assert.ok(entrySeriesReason(legacyCollection,target),'Actual saved Percy Jackson collection alternate rejected even before metadata extraction update');
 const snapshot=JSON.parse(await readFile(path.join(root,'evidence/destination-content/catalog-acceptance.json'),'utf8'));
 const actualCollection=snapshot.entities.find(e=>e.entity_id===legacyCollection.entity_id);
 assert.ok(actualCollection);
 const catalogCollection={...actualCollection,type:'book',entrySeries:catalogEntrySeries(actualCollection)};
 assert.ok(catalogCollection.entrySeries.groups.includes('percy jackson and the olympians'),'Actual Qloo properties.series_name preserved');
 assert.ok(entrySeriesReason(catalogCollection,target),'Full catalogue series evidence rejects renamed collection');
 assert.ok(entrySeriesReason(guide,target),'Actual screenshot commentary book rejected');
 assert.equal(entrySeriesReason(otherGuide,target),null,'Different series by same author remains available');
 const work=(name,type='book',description='',extra={})=>({name,type,description,...extra});
 const dune=work('Dune (Dune, #1)','book','',{byline:'Frank Herbert'});
 const prohibited=[
  work('Dune','book','',{id:'another-edition',byline:'Frank Herbert'}),
  work('Dune Study Guide'),work('Essays on Dune'),work('沙丘导读','book',''),
  work('Renamed Companion','book','A companion to the novel Dune.'),
  work('Renamed Screen Version','movie','An adaptation of the novel Dune.'),
 ];
 for(const candidate of prohibited.filter(c=>c.name!=='沙丘导读'))assert.ok(entrySeriesReason(candidate,dune),candidate.name);
 assert.ok(entrySeriesReason(prohibited[3],work('沙丘')));
 assert.ok(entrySeriesReason({...target,entity_id:target.entity_id.toLowerCase()},target));
 for(const candidate of [
  work('Dune','book','',{byline:'Another Author'}),
  work('Unrelated Novel','book','Inspired by Dune.'),
  work('Guide to Another Story','book','A guide to Another Story, compared with Dune.'),
  work('Guide to Another Story Compared with Dune'),
  work('Independent Film','movie','Based on Another Story, inspired by Dune.'),
  work('Dune','movie'),work('Other Rick Riordan Book','book','',{byline:target.byline}),
 ])assert.equal(entrySeriesReason(candidate,dune),null,candidate.name);
 assert.equal(entrySeriesReason(work('Queen II','album'),work('Queen','artist')),null);
 assert.equal(entrySeriesReason(work('Different Series 5 Books Collection','book','',{byline:target.byline}),target),null,'Other collections by same author remain available');
 assert.equal(entrySeriesReason(work('A Study in Scarlet'),work('Scarlet')),null,'A shared word and study in are not commentary evidence');
 const destination={id:target.entity_id,name:target.name,type:target.type};
 const source={id:origin.id,name:origin.name,type:origin.type};
 const duplicate={...target,entity_id:id(90),name:target.name};
 const independent=Array.from({length:7},(_,i)=>({id:id(60+i),name:'Independent fixture bridge '+String.fromCharCode(65+i),type:'book'}));
 const blocked=[guide,duplicate,legacyCollection],catalog=new Map([origin,target,...blocked,otherGuide,...independent].map(e=>[e.id??e.entity_id,e]));
 const rawWork=e=>({entity_id:e.id??e.entity_id,name:e.name,types:['urn:entity:'+e.type],subtype:'urn:entity:'+e.type,properties:{description:e.entrySeries?.description??e.description??'',publication_year:e.year??2020,authors:e.byline?[e.byline]:[],series:e.entrySeries?.groups??[]}});
 let onlyBlocked=false,queries=[];
 globalThis.fetch=async input=>{
  const u=new URL(input),p=u.searchParams,signal=p.get('signal.interests.entities'),ids=p.get('filter.results.entities');queries.push({signal,ids});
  if(u.pathname==='/search')return Response.json({results:[rawWork(p.get('query')===destination.name?target:origin)]});
  if(p.get('filter.type')==='urn:tag')return Response.json({results:{tags:[]}});
  const pool=ids?ids.split(',').map(entity_id=>({...rawWork(catalog.get(entity_id)??independent[0]),entity_id,query:{affinity:.85}})):[...blocked.map(e=>({...rawWork(e),query:{affinity:.99}})),...(onlyBlocked?[]:[otherGuide,...independent].map(e=>({...rawWork(e),query:{affinity:.85}})))];
  return Response.json({results:{entities:pool}});
 };
 const fast=()=>newTrace({minIntervalMs:0,cache:false});
 const args={seeds:[source.name],destination:destination.name,steps:5,destPinned:destination,seedPinned:{0:source}};
 const out=await execute('buildRoute',args,fast());assert.equal(out.result.ok,true,JSON.stringify(out));assert.equal(out.saved,true);
 const b=JSON.parse(out.result.bundle);assert.equal(b.steps.length,5);assert.equal(b.steps.at(-1).entity_id,destination.id);
 assert.equal(b.meta.routing_method,'destination_backtracking');assert.equal(b.meta.destination_content_policy,'catalogue_work_and_companion_v1');
 for(const candidate of blocked)assert.ok(b.meta.entry_exclusions.some(e=>e.entity_id===candidate.entity_id));
 for(const step of b.steps.slice(0,-1)){assert.equal(entrySeriesReason(step,target),null);for(const alt of step.alternates)assert.equal(entrySeriesReason(alt,target),null);}
 assert.ok(queries.every(q=>!q.ids||q.ids.split(',').every(id=>!blocked.some(e=>e.entity_id===id))),'Exclude before oracle measurement');
 assert.equal(stored.get(out.result.route_id).data,out.result.bundle);
 // Legacy alternate rejected locally, without modifying session or making Qloo calls.
 const legacy=structuredClone(b);legacy.steps[0].alternates=[guide,legacyCollection,{...target,entity_id:id(91)}];
 let sessionData=JSON.stringify({routeData:JSON.stringify(legacy),steps:legacy.steps.map(()=>({ratings:[{'好感':1}],skipped:[]})),rerouteCount:0});
 const previousSelect=db.select;db.select=()=>({from(){return{where(){return{limit:async()=>[{data:sessionData}]}}}}});
 for(const alternate of legacy.steps[0].alternates){queries=[];const rejected=await traceStorage.run(fast(),()=>Actions.swapStepMeasured.handler(ctx,{session_id:1,step_index:0,alt_entity_id:alternate.entity_id}));assert.equal(rejected.ok,false);assert.match(rejected.error,/本体|导读|配套/);assert.equal(queries.length,0);}
 sessionData=JSON.stringify({routeData:out.result.bundle,steps:b.steps.map(()=>({ratings:[{'好感':1}],skipped:[]})),rerouteCount:0});
 const rerouted=await traceStorage.run(fast(),()=>Actions.rerouteFromStep.handler(ctx,{session_id:1,cliff_index:0,like_score:1}));assert.equal(rerouted.ok,true,JSON.stringify(rerouted));const tail=JSON.parse(rerouted.bundle);assert.equal(tail.meta.destination_content_policy,'catalogue_work_and_companion_v1');assert.equal(tail.steps.at(-1).entity_id,destination.id);assert.ok(tail.steps.slice(0,-1).every(s=>entrySeriesReason(s,target)===null));
 db.select=previousSelect;onlyBlocked=true;queries=[];const writes=routeWrites;
 const fail=await execute('buildRoute',args,fast());assert.equal(fail.result.ok,false);assert.equal(fail.saved,false);assert.equal(fail.result.bundle,null);assert.equal(fail.result.error_code,"broken");assert.equal(fail.result.error,"No complete measured route was found with these entries and preferences. Try another starting point or review your preferences.");assert.equal(routeWrites,writes);assert.equal(queries.filter(q=>q.ids).length,0);
 const report={passed:true,liveQlooRequests:0,source:'Actual Percy Jackson screenshot catalogue facts; mocked Qloo measurements',checks:['actual Demigods and Monsters commentary rejected','same-author Kane Chronicles guide retained','same-ID and known same-title/creator edition excluded','explicit companion and adaptation relationships','different author homonym, comparison, inspiration, artist routes preserved','candidate exclusion before measurement','five-stop save/readback and all alternates','legacy swap zero Qloo calls','reroute shares guard and policy','only destination content fails without padding or save']};
 await writeFile(path.join(root,'evidence/destination-content/offline-summary.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{globalThis.fetch=originalFetch;delete globalThis.__acquiredTestEnv;delete globalThis.__acquiredTestDb;delete globalThis.__acquiredTestActions;delete globalThis.__acquiredTestIntentActions;delete globalThis.__acquiredTestRuns;await rm(dir,{recursive:true,force:true})}
