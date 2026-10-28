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
 const js=ts.transpileModule(source+'\n'+extra,{fileName:relative,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const file=path.join(dir,name+'.mjs');await writeFile(file,js);return import(pathToFileURL(file).href);
}
try{
 const {Actions,SitesIntentActions,__boundary}=await compile('lib/acquired/upstream-actions.ts','core','export const __boundary={resolveOne,resolveRouteData,buildRouteBundle,briefForStored};');
 globalThis.__acquiredTestActions=Actions;globalThis.__acquiredTestIntentActions=SitesIntentActions;
 globalThis.__acquiredTestRuns=(await compile('db/schema.ts','schema')).acquiredRuns;
 const {execute,POST}=await compile('app/api/acquired/route.ts','boundary','export {execute};');
 const key=globalThis.__acquiredTestEnv.QLOO_API_KEY;
 const real={id:id(7),name:'Canonical Book',type:'book'},place={id:id(8),name:'A Place',type:'place'},brand={id:id(9),name:'A Brand',type:'brand'};
 let catalogue=[],queries=[];
 globalThis.fetch=async input=>{const u=new URL(input);queries.push(u);assert.equal(u.pathname,'/search');assert.equal(u.searchParams.get('take'),'50');return Response.json({results:catalogue.map(raw)});};
 const pin=e=>({...e,desc:null,year:null,byline:null,image:null});
 const resolve=p=>traceStorage.run(newTrace({minIntervalMs:0,cache:false}),()=>__boundary.resolveOne('Original user input',pin(p),'destination',null,key));
 catalogue=[];assert.equal((await resolve(real)).ok,false,'missing ID fails closed');
 for(const e of [place,brand]){catalogue=[e];const denied=await resolve({...e,type:'book'});assert.equal(denied.ok,false);assert.equal(denied.choice.tier,'out_of_scope');}
 catalogue=[...Array.from({length:49},(_,i)=>({id:id(100+i),name:'Other '+i,type:'book'})),real];
 const valid=await resolve({...real,id:real.id.toLowerCase(),type:'book',name:'Client supplied search text'});
 assert.equal(valid.ok,true);assert.equal(valid.ents[0].name,real.name);assert.equal(valid.ents[0].type,'book');assert.equal(valid.ents[0].id,real.id);
 catalogue=[real,place];const pack={...pin(real),pack:true,members:[real,place]};assert.equal((await resolve(pack)).ok,false,'all pack members must have allowed canonical types');
 catalogue=[real];assert.equal((await resolve({...pack,members:[real,brand]})).ok,false,'missing pack member cannot use client fallback');
 assert.equal((await resolve({...pack,members:[]})).ok,false);
 catalogue=[place];const seedPlace=await traceStorage.run(newTrace({minIntervalMs:0,cache:false}),()=>__boundary.resolveOne(place.name,pin(place),'seed',0,key));assert.equal(seedPlace.ok,true,'seed types remain unrestricted');
 for(const destination of [place,brand,{...real,type:''}])await assert.rejects(__boundary.buildRouteBundle([seed],destination,3,key,'',''),/目的地必须/);
 await assert.rejects(__boundary.buildRouteBundle([seed],real,3,key,'','',{destPack:{info:{},memberEnts:[real,brand]}}),/目的地必须/);
 catalogue=[];await assert.rejects(traceStorage.run(newTrace({minIntervalMs:0,cache:false}),()=>__boundary.briefForStored(real,key)),/无法核实/);
 for(const e of [real,place,brand]){
  catalogue=e===real?[]:[e];queries=[];const prior=routeWrites;
  const denied=await execute('buildRoute',{seeds:[seed.name],destination:e.name,steps:3,destPinned:pin({...e,type:'book'})},newTrace({minIntervalMs:0,cache:false}));
  assert.equal(denied.result.ok,false);assert.equal(denied.saved,false);assert.equal(routeWrites,prior);assert.ok(queries.every(q=>q.pathname==='/search'));
 }
 let selects=0;const legacyCtx={db:()=>({select(){selects++;return {from(){return {where(){return {limit:async()=>[]}}}}}}})};
 for(const legacy of [{routeTitle:'Duplicate title'}, {},{routeId:'missing',routeTitle:'Duplicate title'}])assert.equal(await __boundary.resolveRouteData(legacyCtx,JSON.stringify(legacy)),null);
 assert.equal(selects,1,'title and missing markers do not query arbitrary routes');
 const snapshot=JSON.stringify(bundle);assert.equal(await __boundary.resolveRouteData(legacyCtx,JSON.stringify({routeData:snapshot})),snapshot);
 const exactCtx={db:()=>({select:()=>({from:()=>({where:()=>({limit:async()=>[{data:snapshot}]})})})})};
 assert.equal(await __boundary.resolveRouteData(exactCtx,JSON.stringify({routeId:'offline-fixture'})),snapshot);
 assert.equal(Actions.saveSession.request.safeParse({id:1,data:'{}',finished:false}).success,false);
 assert.equal((await Actions.saveSession.handler(ctx,{id:1,data:'{}',finished:false})).error_code,'expected_data_required');
 const missingCasResponse=await POST(new Request('https://fixture.invalid/api/acquired',{method:'POST',body:JSON.stringify({action:'saveSession',args:{id:1,data:'{}',finished:false}})}));
 assert.equal(missingCasResponse.status,401,'Anonymous requests stop before CAS or data access');
 const {queryCoverageNotice}=await import('../lib/acquired/route-evidence.ts');
 assert.equal(queryCoverageNotice(bundle),null);const flagged={...bundle,meta:{...bundle.meta,unavailable_query_branches:[{reason:'invalid_entity_signals'}]}};
 assert.match(queryCoverageNotice(JSON.parse(JSON.stringify(flagged))),/其他实测结果/);
 let keyRoute=await readFile(path.join(root,'app/api/qloo-key/route.ts'),'utf8');assert.ok(!keyRoute.includes('export async function POST'));assert.ok(!keyRoute.includes('probeQlooKey'));
 assert.ok(!(await readFile(path.join(root,'app/lab/page.tsx'),'utf8')).includes('verify-once'));
 const {renderToStaticMarkup}=await import('react-dom/server');const {QueryCoverageNotice}=await compile('app/acquired/query-coverage-notice.tsx','notice');
 const html=renderToStaticMarkup(QueryCoverageNotice({bundle:flagged}));assert.match(html,/role="note"/);assert.match(html,/other measured results/);assert.equal(renderToStaticMarkup(QueryCoverageNotice({bundle})), '');
 console.log('Boundary regressions passed: canonical pins incl late result/case, single/pack scope, malformed/missing pins, stored hydration, builder scope, no route writes on rejected pins, exact legacy association, mandatory CAS schema/handler, persisted warning and removed probe POST. Real Qloo calls: 0.');
}finally{globalThis.fetch=originalFetch;delete globalThis.__acquiredTestEnv;delete globalThis.__acquiredTestDb;delete globalThis.__acquiredTestActions;delete globalThis.__acquiredTestIntentActions;delete globalThis.__acquiredTestRuns;await rm(dir,{recursive:true,force:true})}
