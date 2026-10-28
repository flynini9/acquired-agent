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
 const {__test}=await compile('lib/acquired/upstream-actions.ts','core');
 const tag=(name)=>({id:'urn:tag:keyword:qloo:'+name,name,affinity:.99});
 const profile=(...names)=>new Map(names.map(n=>[tag(n).id,tag(n)]));
 const cache=()=>({profiles:new Map([[seed.id,Promise.resolve(profile('robot','family'))],['a',Promise.resolve(profile('android'))],['b',Promise.resolve(profile('family'))]]),relatives:new Map()});
 const steps=()=>[{entity_id:'a',type:'movie',aff_from_seeds:.6,why:null},{entity_id:'b',type:'movie',aff_from_seeds:.7,why:null}];
 const fresh=()=>newTrace({cache:false,minIntervalMs:0});
 let calls=0;
 globalThis.fetch=async(input,init)=>{calls++;assert.ok(new URL(input).searchParams.has('signal.interests.tags'));return new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});};
 const t=fresh();t.explanationPolicy={limit:8,timeoutMs:30};const s=steps();
 await traceStorage.run(t,()=>runExplanation(()=>__test.attachWhys(s,[seed],'dummy',cache())));
 assert.equal(s[0].why.explanation_status,'partial');assert.match(s[0].why.text,/0.600/);assert.equal(s[1].why.explanation_status,'complete');assert.match(s[1].why.text,/family/);assert.equal(t.explanation.exhausted,true);assert.equal(t.upstreamFailure,undefined);assert.equal(calls,1);
 const cached=cache();cached.relatives.set(tag('robot').id,Promise.resolve([{name:'android',affinity:.96}]));const ready=steps();calls=0;
 globalThis.fetch=async()=>{calls++;throw Error('Should use cached measured evidence')};
 await traceStorage.run(fresh(),()=>runExplanation(()=>__test.attachWhys(ready,[seed],'dummy',cached)));
 assert.equal(calls,0);assert.equal(ready[0].why.explanation_status,'complete');assert.match(ready[0].why.text,/0.96/);assert.deepEqual(ready[0].why.pair,['robot','android']);
 const wide=cache();wide.profiles.set(seed.id,Promise.resolve(profile(...Array.from({length:24},(_,i)=>'theme'+i))));calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({results:{tags:[]}})};
 await traceStorage.run(fresh(),()=>runExplanation(()=>__test.attachWhys(steps(),[seed],'dummy',wide)));assert.equal(calls,2);
 const report={passed:true,liveQlooRequests:0,checks:['later station exact-tag explanation survives first station kinship timeout','all stations retain measured baseline facts','local timeout classified as budget, not provider outage','single-seed attribution reuses home measurement','cached kinship yields complete reason with zero new calls','24 candidate tags expand at most two new kinship signals']};
 await mkdir(path.join(root,'evidence/explanations-review'),{recursive:true});await writeFile(path.join(root,'evidence/explanations-review/offline-summary.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{globalThis.fetch=originalFetch;delete globalThis.__acquiredTestEnv;await rm(dir,{recursive:true,force:true});}
