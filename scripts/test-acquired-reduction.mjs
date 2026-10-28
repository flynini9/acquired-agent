// Run Xiaoyao's 91 regression cases against the actual Sites port. The tiny
// Bun.serve adapter invokes the fixture callback in memory; no listener or
// real network is used. Production keeps a fixed Qloo origin.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import {traceStorage,newTrace} from '../lib/acquired/telemetry.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=await mkdtemp(path.join(root,'node_modules/.intent-core-'));
const originalFetch=globalThis.fetch,originalExit=process.exit,originalLog=console.log;
const lines=[];let handler,calls=0;
globalThis.__intentTestEnv={QLOO_API_KEY:'worthless-intent-selfcheck-secret'};
globalThis.Bun={serve(config){handler=config.fetch;return{port:19483,stop(){}}}};
globalThis.fetch=async(input,init)=>{calls++;const r=new Request(input,init);assert.equal(new URL(r.url).origin,'https://hackathon.api.qloo.com');return handler(r)};
process.exit=code=>{if(code)throw Error('Intent selfcheck failed: '+code)};
console.log=(...args)=>{lines.push(args.join(' '));originalLog(...args)};
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
try{
 let source=await readFile(path.join(root,'lib/acquired/upstream-actions.ts'),'utf8');
 source=source.replace('import { env } from "cloudflare:workers";','const env=globalThis.__intentTestEnv;');
 source=source.replace(/from "(\.\/[^\"]+)"/g,(_,p)=>'from '+JSON.stringify(pathToFileURL(path.join(root,'lib/acquired',p+'.ts')).href));
 await writeFile(dir+'/core.mjs',compile(source));
 const core=await import(pathToFileURL(dir+'/core.mjs').href);
 for(const action of Object.values(core.Actions)){const run=action.handler;action.handler=(...args)=>traceStorage.run(newTrace({minIntervalMs:0,cache:false}),()=>run(...args))}
 await writeFile(dir+'/fixture.json',await readFile(path.join(root,'scripts/fixtures/reduction/fixture.json')));
 let checks=await readFile(path.join(root,'scripts/fixtures/reduction/upstream-selfcheck.ts.fixture'),'utf8');
 checks=checks.replace('from "../../src/actions"','from "./core.mjs"').replace('from "../../src/schema"','from '+JSON.stringify(pathToFileURL(path.join(root,'lib/acquired/upstream-schema.ts')).href));
 checks=checks.replace('__test.setQlooBaseForTest(', '(()=>{})(');
 // Required destination_tags now precedes optional profile reads; fail the first destination lookup.
 checks=checks.replace('scenario.destTagCalls >= 2','scenario.destTagCalls >= 1');
 await writeFile(dir+'/checks.mjs',compile(checks));await traceStorage.run(newTrace({minIntervalMs:0,cache:false}),()=>import(pathToFileURL(dir+'/checks.mjs').href));
 const passed=lines.filter(x=>x.startsWith('PASS ')).length;assert.equal(passed,91);
 // The Sites preflight reuses resolution but cannot silently pick a target.
 globalThis.fetch=async()=>Response.json({results:[]});
 const noMatch=await traceStorage.run(newTrace({minIntervalMs:0,cache:false}),()=>core.SitesIntentActions.resolveIntentDestination.handler({db(){throw Error()},invalidateQueries(){}},{query:'No Such Fixture'}));
 assert.equal(noMatch.need_choice?.candidates.length,0);
 const options=await core.SitesIntentActions.getIntentOptions.handler({},{});assert.ok(options.options.length>=30);assert.ok(options.options.every(o=>o.tagId.startsWith('urn:tag:')));
 const report={upstream:'fd9141bacbf479f8cd073c94142f1b403a76e2c3',kind:'offline mocked regression of actual Sites port',passed,failed:0,preflight:['unresolved target is a choice','verified option catalog available'],mockFetches:calls,liveQlooRequests:0,cases:lines.filter(x=>x.startsWith('PASS '))};
 if(process.argv.includes('--save-evidence')){await mkdir(path.join(root,'evidence/reduction'),{recursive:true});await writeFile(path.join(root,'evidence/reduction/offline-summary.json'),JSON.stringify(report,null,2)+'\n')}
 originalLog(JSON.stringify({...report,cases:undefined}));
}finally{globalThis.fetch=originalFetch;process.exit=originalExit;console.log=originalLog;delete globalThis.Bun;delete globalThis.__intentTestEnv;await rm(dir,{recursive:true,force:true})}
