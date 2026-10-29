import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createDebouncedSave} from '../../lib/acquired/debounced-save.ts';
import {SessionConflict} from '../../lib/acquired/session-sync.ts';
import {acknowledgeSession} from '../../app/acquired/route-library.ts';

export function fakeClock(){
 let now=0,next=0;const jobs=new Map();
 return {set(fn,delay){const id=++next;jobs.set(id,{fn,at:now+delay});return id},clear(id){jobs.delete(id)},tick(ms){now+=ms;for(const [id,job] of [...jobs])if(job.at<=now){jobs.delete(id);job.fn()}},get size(){return jobs.size}};
}

// Execute the shipped page's actual local-edit, draft, queue, acknowledgement,
// revision and CAS functions. The only supplied boundary is the server call.
// Tests can use real SQLite actions, controlled transport failures and a clock.
export function pageSaveHarness({state,id,server,clock=fakeClock(),userId='test-visitor',initialAck=JSON.stringify(state)}){
 const source=readFileSync(new URL('../../app/acquired/page.tsx',import.meta.url),'utf8');
 const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const page=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='Acquired');
 const names=['draftKey','draft','persist','editReflection','flushReflection','flush'];
 const parts=page.body.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(ast));
 const init=page.body.statements.find(n=>ts.isIfStatement(n)&&n.expression.getText(ast)==='!reflectionSaves.current').getText(ast);
 const body=`
 const walkRef={current:state},sidRef={current:id},viewerRef={current:{userId}},ackData={current:initialAck},syncBlocked={current:false},saveRevision={current:0},saveChain={current:Promise.resolve(true)},libraryRevision={current:0},reflectionSaves={current:null};
 let ui=state,status='Saved',error=false,conflict=null;
 let library={routes:[],sessions:[{id,route_id:state.routeId,route_title:state.routeTitle,finished:state.finished,updated_at:'2000-01-01T00:00:00.000Z'}]};
 const drafts=new Map(),history=[],calls=[];
 const localStorage={setItem:(k,v)=>drafts.set(k,v),removeItem:k=>drafts.delete(k)};
 const setWalk=value=>ui=value,setSaveStatus=value=>{status=value;history.push(value)},setSaveError=value=>error=value,setDraftConflict=value=>conflict=value,setRouteLibrary=update=>library=update(library);
 async function call(action,args){calls.push(action);const result=await server(action,args);if(result.error_code==='session_conflict'&&result.current_data)throw new SessionConflict(result.current_data);if(result.ok===false)throw Error(result.error??result.error_code??'Save failed');return {result};}
 ${parts.join('\n')}
 ${init}
 return {edit:editReflection,blur:flushReflection,flush,retry:()=>persist(walkRef.current),leave:flushReflection,cancel:()=>reflectionSaves.current.cancel(),get ui(){return ui},get status(){return status},get error(){return error},get conflict(){return conflict},get drafts(){return [...drafts.values()].map(JSON.parse)},get library(){return library},history,calls,clock};`;
 const code=ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 return new Function('state','id','userId','server','createDebouncedSave','SessionConflict','acknowledgeSession','clock','initialAck',code)(state,id,userId,server,options=>createDebouncedSave({...options,clock}),SessionConflict,acknowledgeSession,clock,initialAck);
}
