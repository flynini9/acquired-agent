import assert from 'node:assert/strict';
import {readDraft,restoreRouteSnapshot} from '../lib/acquired/session-sync.ts';
import {rerouteMotivationMeta,rerouteQueryCoverage} from '../lib/acquired/route-reports.ts';
import {tasteItems,identityFor,entryFor} from '../lib/acquired/entry-points.ts';
import {DatabaseSync} from 'node:sqlite';
import {SQLiteSyncDialect} from 'drizzle-orm/sqlite-core';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
const w={schemaVersion:2,routeId:'fixture',routeData:'{}',steps:[{}]},remote=JSON.stringify(w),local={...w,reflection:'offline edit'};
assert.equal(readDraft({version:3,baseData:remote,state:local,at:0},remote).kind,'recover');
assert.equal(readDraft({version:3,baseData:'old',state:local,at:Infinity},remote).kind,'conflict');
assert.equal(readDraft({at:0,state:local},remote).kind,'conflict');
assert.equal(readDraft({version:3,baseData:'old',state:w},remote).kind,'none');
assert.equal(readDraft({version:3,baseData:remote,state:{...local,routeId:'other'}},remote).kind,'none');
// Missing remote snapshot must be restored before it is copied into a
// conflict dialog; CAS still compares the unchanged serialized response.
const missing={...w,routeData:undefined},missingRaw=JSON.stringify(missing);
const resolved=JSON.stringify({route_id:w.routeId,steps:[{}]});
const normalized=restoreRouteSnapshot(missing,resolved);
const conflicted=readDraft({version:3,baseData:'stale',state:local},missingRaw);
assert.equal(conflicted.kind,'conflict');
const conflict={remote:normalized,remoteData:missingRaw};
assert.equal(JSON.parse(conflict.remote.routeData).route_id,w.routeId);assert.equal(conflict.remoteData,missingRaw);
assert.throws(()=>restoreRouteSnapshot(missing,null),/记录读不出来/);
assert.throws(()=>restoreRouteSnapshot(missing,JSON.stringify({route_id:'wrong',steps:[{}]})),/记录读不出来/);
const keptBranch={hop:4,reason:'invalid_entity_signals',result_type:'artist',signal_entity_ids:['fixture']};
const removedBranch={...keptBranch,hop:1};
const coverage=rerouteQueryCoverage({unavailable_query_branches:[keptBranch,removedBranch]},{unavailable_query_branches:[]},5,1);
assert.deepEqual(coverage.unavailable_query_branches,[keptBranch]);
const {queryCoverageNotice}=await import('../lib/acquired/route-evidence.ts');assert.ok(queryCoverageNotice({meta:coverage}));
assert.equal(rerouteQueryCoverage({unavailable_query_branches:[removedBranch]},{unavailable_query_branches:[]},5,1).unavailable_query_branches.length,0);
const report={label:'Wish',detail:'第 1 步：选择新作品',status:'applied_changed'};
const first=rerouteMotivationMeta({motivation_report:[{...report,detail:'旧路线'}]},{motivation_report:[report]},2,1);
assert.equal(first.motivation_report[0].detail,'本次重修：第 3 步：选择新作品');assert.equal(first.motivation_history[0].reports[0].detail,'旧路线');
const second=rerouteMotivationMeta(first,{motivation_report:[]},0,2);assert.equal(second.motivation_history.length,2);assert.equal(second.motivation_report.length,0);
const obsession={entity_id:'5BF04DFD-4D46-4878-B396-AC7F9071690E',tracks:[{title:'a',url:'https://example.com'}, {title:'b',url:'https://example.com'}]};
assert.match(tasteItems(obsession)[0].url,/focusfeatures/);assert.equal(tasteItems(obsession).length,2);assert.equal(tasteItems(obsession)[1].title,'b');assert.equal(tasteItems({...obsession,tracks:[]}).length,0);
assert.equal(entryFor({entity_id:'different',name:'Obsession'}),undefined);assert.match(identityFor({entity_id:'03A4150A-6286-4963-BFE8-924313C3F2E9'}).summary,/2016/);
const dir=await mkdtemp(new URL('../node_modules/.polish-',import.meta.url).pathname),db=new DatabaseSync(':memory:'),dialect=new SQLiteSyncDialect();
try{
 db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY,data TEXT,finished INTEGER,created_at INTEGER,updated_at INTEGER)');db.prepare('INSERT INTO sessions VALUES(1,?,0,0,0)').run(remote);
 const adapter={
  update(){return{set(v){return{where(condition){const q=dialect.sqlToQuery(condition);const sql='UPDATE sessions SET data=?,finished=?,updated_at=? WHERE '+q.sql;return {returning:async()=>db.prepare(sql+' RETURNING id').all(v.data,Number(v.finished),v.updatedAt.getTime(),...q.params),then(resolve,reject){return Promise.resolve(db.prepare(sql).run(v.data,Number(v.finished),v.updatedAt.getTime(),...q.params)).then(resolve,reject)}}}}}}},
  select(){return{from(){return{where(condition){const q=dialect.sqlToQuery(condition);return{limit:async()=>db.prepare('SELECT * FROM sessions WHERE '+q.sql+' LIMIT 1').all(...q.params)}}}}}}
 };
 let source=await readFile(new URL('../lib/acquired/upstream-actions.ts',import.meta.url),'utf8');
 source=source.replace('import { env } from "cloudflare:workers";','const env={};').replace(/from "(\.\/[^\"]+)"/g,(_,p)=>'from '+JSON.stringify(new URL('../lib/acquired/'+p+'.ts',import.meta.url).href));
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;await writeFile(dir+'/core.mjs',js);
 const {Actions}=await import(pathToFileURL(dir+'/core.mjs').href);const save=args=>Actions.saveSession.handler({db:()=>adapter,invalidateQueries(){}},args);
 assert.equal(Actions.saveSession.request.safeParse({id:1,data:remote,finished:false}).success,false);
 assert.equal((await save({id:1,data:'{}',finished:false})).error_code,'expected_data_required');
 assert.equal(db.prepare('SELECT data FROM sessions').get().data,remote);
 const a=JSON.stringify(local),b=JSON.stringify({...w,reflection:'second device'});
 assert.equal((await save({id:1,data:a,finished:false,expected_data:remote})).ok,true);
 const rejected=await save({id:1,data:b,finished:false,expected_data:remote});assert.equal(rejected.error_code,'session_conflict');assert.equal(rejected.current_data,a);assert.equal(db.prepare('SELECT data FROM sessions').get().data,a);
 assert.equal((await save({id:1,data:a,finished:false,expected_data:remote})).ok,true);
 assert.equal((await save({id:1,data:b,finished:true,expected_data:a})).ok,true);
 assert.equal((await save({id:999,data:a,finished:false,expected_data:remote})).error_code,'session_missing');
 console.log('Passed: clock-independent recovery, conflicts retain both copies, legacy draft preservation, exact-content conditional SQLite writes, stale write rejection, lost acknowledgement retry, report history/renumbering, exact-identity entry points, unchanged track counts. Live Qloo: 0.');
}finally{db.close();await rm(dir,{recursive:true,force:true})}
