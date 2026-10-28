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
 const actual=JSON.parse(await readFile(path.join(root,'evidence/harry-search/english.json'),'utf8'));
 const book=JSON.parse(await readFile(path.join(root,'evidence/harry-search/book.json'),'utf8'));
 const movie=JSON.parse(await readFile(path.join(root,'evidence/harry-search/movie.json'),'utf8'));
 let queries=[],status=200;
 globalThis.fetch=async input=>{
  const u=new URL(input),p=u.searchParams;queries.push({query:p.get('query'),type:p.get('types'),take:p.get('take')});assert.equal(u.pathname,'/search');
  if(status!==200)return Response.json({}, {status});
  const type=p.get('types'),allowed=new Set(type.split(','));
  const pool=type==='urn:entity:book'?book.entities:type==='urn:entity:movie'?movie.entities:actual.entities;
  return Response.json({results:pool.filter(e=>e.types.some(t=>allowed.has(t)))});
 };
 const fast=()=>newTrace({minIntervalMs:0,cache:false});
 const results=[],firstBook='0C97E7FE-8A86-4B48-9F54-CB0A73CC2B96',firstMovie='C0EAA2BE-987D-408C-AC2B-92F92E3D2035';
 for(const query of ['哈利波特','Harrypotter','Harry Potter','哈利·波特']){
  queries=[];const out=await execute('resolveIntentDestination',{query},fast());assert.equal(out.result.ok,true);const choice=out.result.need_choice;
  assert.ok(choice.candidates.length>6);assert.ok(choice.candidates.length<=60);assert.ok(choice.candidates.some(c=>c.id===firstBook));assert.ok(choice.candidates.some(c=>c.id===firstMovie));
  assert.equal(choice.query,query);assert.equal(choice.packs,null);assert.ok(!choice.candidates.some(c=>['place','brand'].includes(c.type)));assert.ok(!choice.candidates.some(c=>c.name.includes('Potterkin')));
  assert.ok(queries.every(q=>q.query==='Harry Potter'));assert.equal(queries.length,3);assert.ok(queries.every(q=>q.take==='50'));assert.equal(out.saved,false);assert.equal(routeWrites,0);
  results.push(choice.candidates.map(c=>c.id));
  if(query==='哈利波特')await writeFile(path.join(root,'evidence/harry-search/confirmed-choice.json'),JSON.stringify(choice,null,2)+'\n');
 }
 for(const ids of results.slice(1))assert.deepEqual(ids,results[0],'Known Chinese alias and joined/spaced English must share the same candidate IDs/order');
 queries=[];const seed=await execute('resolveIntentDestination',{query:'哈利波特',field:'seed',index:1},fast());assert.equal(seed.result.need_choice.field,'seed');assert.equal(seed.result.need_choice.index,1);assert.ok(seed.result.need_choice.candidates.some(c=>c.id===firstBook));assert.equal(queries.length,3);
 status=429;queries=[];const limited=await execute('resolveIntentDestination',{query:'哈利波特'},fast());assert.equal(limited.result.ok,false);assert.equal(limited.result.need_choice,null);assert.equal(queries.length,1);
 const report={passed:true,liveQlooRequests:0,candidateCount:results[0].length,checks:['actual Harry Potter catalogue identities preserved','Chinese/dotted Chinese/joined/spaced English share exact pool','concrete books and movies no longer masked by album/TV homonyms','typed book/movie pool reused as choices','all candidates capped at 60, local UI paging','original query kept; no auto-pick/build/save','destination scope and seed index preserved','near-word Potterkin rejected','429 stops immediately']};
 await writeFile(path.join(root,'evidence/harry-search/offline-summary.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{globalThis.fetch=originalFetch;delete globalThis.__acquiredTestEnv;delete globalThis.__acquiredTestDb;delete globalThis.__acquiredTestActions;delete globalThis.__acquiredTestIntentActions;delete globalThis.__acquiredTestRuns;await rm(dir,{recursive:true,force:true})}
