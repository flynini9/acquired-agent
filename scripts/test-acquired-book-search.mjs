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
 const {identityTitleKey,identityChoices}=await import('../lib/acquired/identity-candidates.ts');
 const {entrySeriesReason,catalogEntrySeries}=await import('../lib/acquired/entry-series.ts');
 assert.equal(identityTitleKey({name:'Dune (Dune, #1)',type:'book'}),'dune');
 assert.equal(identityTitleKey({name:'Dune Messiah (Dune #2)',type:'book'}),'dunemessiah','Do not collapse a sequel into the original');
 assert.equal(identityTitleKey({name:'Dune (The Graphic Novel)',type:'book'}),'dunethegraphicnovel','Meaningful edition descriptors are retained');
 assert.equal(identityTitleKey({name:'Dune (Dune, #1)',type:'movie'}),'dunedune1','Only bibliographic book suffixes are stripped');
 const actual=JSON.parse(await readFile(path.join(root,'evidence/dune-search/mixed-catalog.json'),'utf8'));
 const book=JSON.parse(await readFile(path.join(root,'evidence/dune-search/book-catalog.json'),'utf8')).entities[0];
 const nextBook=JSON.parse(await readFile(path.join(root,'evidence/dune-search/book-catalog.json'),'utf8')).entities[1];
 assert.ok(entrySeriesReason({name:nextBook.name,type:'book',entrySeries:catalogEntrySeries(nextBook)},{name:book.name,type:'book',entrySeries:catalogEntrySeries(book)}),'Book series position also supplies explicit series guard evidence');
 const raw=e=>({...e,properties:{...e.properties,image:{url:'https://images.qloo.com/i/'+e.entity_id+'-420x-auto.jpg'}}});
 let status=200,searches=0,onlyBook=false,lateBook=false;
 globalThis.fetch=async input=>{
  searches++;const u=new URL(input);assert.equal(u.pathname,'/search');
  if(status!==200)return Response.json({}, {status});
  const type=u.searchParams.get('types');
  let pool=actual.entities;
  if(onlyBook)pool=[book];
  else if(lateBook)pool=[...Array.from({length:8},(_,i)=>({...actual.entities[0],entity_id:id(50+i)})),book];
  if(type){const allowed=new Set(type.split(','));pool=pool.filter(e=>e.types.some(t=>allowed.has(t)));}
  return Response.json({results:pool.map(raw)});
 };
 const fast=()=>newTrace({minIntervalMs:0,cache:false});
 const reports=[];
 for(const field of ['destination','seed']){
  for(const late of [false,true]){
   lateBook=late;
   const out=await execute('resolveIntentDestination',{query:'Dune',field,...(field==='seed'?{index:1}:{})},fast());
   assert.equal(out.result.ok,true);const choice=out.result.need_choice;
   const found=choice.candidates.find(c=>c.id===book.entity_id);
   assert.ok(found,'Actual Dune book must be selectable');assert.equal(found.name,'Dune (Dune, #1)');assert.equal(found.type,'book');assert.equal(found.year,1965);assert.equal(found.byline,'Frank Herbert');
   assert.equal(choice.field,field);assert.equal(choice.index,field==='seed'?1:null);
   assert.ok(choice.candidates.some(c=>c.type==='movie'));assert.ok(choice.candidates.length<=60);
   if(field==='destination')assert.ok(!choice.candidates.some(c=>c.type==='place'));
   assert.equal(out.saved,false);assert.equal(routeWrites,0);
   reports.push({field,bookPastFirstSix:late,bookSelectable:true});
  }
 }
 onlyBook=true;lateBook=false;
 const lone=await execute('resolveIntentDestination',{query:'Dune'},fast());assert.equal(lone.result.need_choice.candidates[0].id,book.entity_id);assert.equal(lone.saved,false);
 // Explicitly choosing the book keeps its own ID/type, never the movie.
 const requestsBefore=searches;
 const pin=Actions.buildRoute.request.parse({seeds:['Fixture'],destination:'Dune',steps:3,destPinned:lone.result.need_choice.candidates[0]});assert.equal(pin.destPinned.type,'book');assert.equal(pin.destPinned.id,book.entity_id);assert.equal(searches,requestsBefore);
 status=429;const before=searches;
 const failed=await execute('resolveIntentDestination',{query:'Dune'},fast());assert.equal(failed.result.ok,false);assert.equal(failed.result.need_choice,null);assert.equal(searches,before+1);
 const report={passed:true,liveQlooRequests:0,source:'Actual Qloo Dune catalogue snapshots plus synthetic rank-pressure cases',checks:reports,book:{id:book.entity_id,name:book.name,year:1965,author:'Frank Herbert'},otherChecks:['bibliographic suffix only','full catalogue identities retained','bounded complete candidate pool with medium diversity; UI pages six at a time','destination and seed preflight','no route auto-build or save','book pin type and ID retained','typed 429 stops without retry']};
 await mkdir(path.join(root,'evidence/dune-search'),{recursive:true});await writeFile(path.join(root,'evidence/dune-search/offline-summary.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{globalThis.fetch=originalFetch;delete globalThis.__acquiredTestEnv;delete globalThis.__acquiredTestDb;delete globalThis.__acquiredTestActions;delete globalThis.__acquiredTestIntentActions;delete globalThis.__acquiredTestRuns;await rm(dir,{recursive:true,force:true})}
