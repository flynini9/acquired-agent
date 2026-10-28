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
 const tagId='urn:tag:keyword:qloo:wish',motive='那个许愿柳的设定，很有意思';
 const fast=()=>newTrace({minIntervalMs:0,cache:false});
 for(const text of [motive,'许愿的设定有意思','想看看愿望成真','One Wish Willow']){
  const p=__test.parseMotivationSignals(text,[]);assert.equal(p.genericPending,false);assert.deepEqual(p.signals.map(s=>[s.id,s.tagId,s.status]),[['mot:tag:wish',tagId,'ready']]);
 }
 for(const text of ['不喜欢许愿设定','不是许愿，而是别的东西','许愿没意思'])assert.ok(!__test.parseMotivationSignals(text,[]).signals.some(s=>s.id==='mot:tag:wish'));
 assert.ok(!__test.parseMotivationSignals('柳树很好看',[]).signals.some(s=>s.id==='mot:tag:wish'));
 assert.deepEqual(__test.catalogTasteTags({tags:[{tag_id:tagId,name:'Wish'},{id:tagId.toUpperCase(),name:'Duplicate'},{id:'not-a-tag',name:'Wish'}]}),[{id:tagId,name:'Wish'}]);
 const wish={id:id(4),name:'Fixture Wish',type:'tv_show'},mid={id:id(5),name:'Fixture Mid',type:'tv_show'};
 let external=0,profiles=0;
 const entity=(e,aff=.9)=>({...raw(e),query:{affinity:aff},tags:e.id===wish.id?[{tag_id:tagId,name:'Wish'}]:[]});
 globalThis.fetch=async input=>{
  external++;const u=new URL(input),p=u.searchParams,signal=p.get('signal.interests.entities'),ids=p.get('filter.results.entities');
  if(u.pathname==='/search')return Response.json({results:[entity(p.get('query')===dest.name?dest:seed)]});
  if(p.get('filter.type')==='urn:tag'){
   if(p.get('signal.interests.tags'))return Response.json({results:{tags:[{tag_id:tagId,name:'Wish',query:{affinity:.99}}]}});
   profiles++;return Response.json({results:{tags:[]}});
  }
  if(ids)return Response.json({results:{entities:ids.split(',').map(entity_id=>({entity_id,query:{affinity:.9}}))}});
  return Response.json({results:{entities:signal===dest.id?[entity(cand,.95),entity(wish,.94)]:[entity(mid,.96)]}});
 };
 const parsed=await traceStorage.run(fast(),()=>Actions.parseConstraints.handler(ctx,{motivation:motive}));assert.equal(parsed.motivationSignals[0].tagId,tagId);assert.equal(parsed.motivationSignals[0].status,'ready');assert.equal(external,0);
 const {acceptIntent,intentArgs,needsMotivationDetail}=await import('../lib/acquired/intent.ts');const intent=acceptIntent(parsed,dest.id);assert.deepEqual(intent.selectedMotivationIds,['mot:tag:wish']);assert.equal(needsMotivationDetail(intent),false);
 const args={seeds:[seed.name],destination:dest.name,steps:3,destPinned:dest,seedPinned:{0:seed},motivation:motive,...intentArgs(intent)};
 const baseline=await traceStorage.run(fast(),()=>Actions.buildRoute.handler(ctx,{...args,selectedMotivationIds:[]}));assert.equal(baseline.ok,true);assert.equal(JSON.parse(baseline.bundle).steps[1].entity_id,cand.id);
 const active=await execute('buildRoute',args,fast());assert.equal(active.saved,true);assert.equal(active.result.ok,true);
 const bundle=JSON.parse(active.result.bundle);assert.equal(bundle.steps[1].entity_id,wish.id);assert.equal(bundle.meta.routing_method,'destination_backtracking');assert.ok(bundle.meta.reverse_links.every(l=>l.affinity>=.72));
 assert.equal(bundle.meta.motivation_signals[0].tagId,tagId);assert.ok(bundle.meta.motivation_report.some(r=>r.signal_id==='mot:tag:wish'&&r.status==='applied_changed'&&r.detail.includes('Wish')));assert.ok(bundle.steps[1].why.text.includes('Wish'));assert.ok(profiles>0);
 assert.equal(stored.get(active.result.route_id).data,active.result.bundle);assert.equal(bundle.meta.motivation_signals.some(s=>/curse|corrupt|willow/.test(s.tagId)),false);
 const report={passed:true,checks:['specific wish keywords become ready','negative wish clauses excluded','willow plant alone not interpreted as wish','catalogue tag_id and id accepted without assigning an affinity','no aggregate profile tags required for exact catalogue hit','explicit deselection keeps baseline','active Wish changes an in-band choice','reverse routing evidence and exact save-readback retained','no automatic corrupted-wish/curse/bargain/plant signal'],liveQlooRequests:0};
 if(process.argv.includes('--save-evidence')){await mkdir(path.join(root,'evidence/wish-acceptance'),{recursive:true});await writeFile(path.join(root,'evidence/wish-acceptance/offline-summary.json'),JSON.stringify(report,null,2)+'\n')}
 console.log(JSON.stringify(report,null,2));
}finally{globalThis.fetch=originalFetch;delete globalThis.__acquiredTestEnv;delete globalThis.__acquiredTestDb;delete globalThis.__acquiredTestActions;delete globalThis.__acquiredTestIntentActions;delete globalThis.__acquiredTestRuns;await rm(dir,{recursive:true,force:true})}
