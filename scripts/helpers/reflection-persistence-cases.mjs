import {pageSaveHarness} from './reflection-save-harness.mjs';
import {startWalk} from '../../lib/acquired/walk.ts';
import {readDraft} from '../../lib/acquired/session-sync.ts';

export async function reflectionPersistenceCases({Actions,ctx,check}){
 let checked=0;const assertCheck=check;check=(...args)=>{assertCheck(...args);checked++};
 const bundle={schema:'acquired-route/2',route_id:'reflection-regression',meta:{title:'Reflection regression',destination:'Destination'},config:{step_metrics:['熟悉','陌生','好感'],step_scale:5,primary_metric:'好感',baseline_scale:10,max_skip_per_step:1},baseline_works:[],destination_works:[],steps:['First','A longer intermediate work title','Destination'].map((name,n)=>({n:n+1,name,type:'artist',entity_id:'test-'+n,tracks:[{title:name,url:'https://example.test'}]}))};
 const initial=startWalk(bundle);initial.steps.forEach(s=>{s.cont=true;s.ratings[0]={'熟悉':3,'陌生':2,'好感':4}});initial.finished=true;initial.sitesCursor=3;
 const create=async()=>{const state=structuredClone(initial),{id}=await Actions.createSession.handler(ctx,{data:JSON.stringify(state)});return {state,id}};
 const read=async id=>JSON.parse((await Actions.getSession.handler(ctx,{id})).session.data);
 const real=(action,args)=>Actions[action].handler(ctx,args);
 let item=await create(),h=pageSaveHarness({...item,server:real});
 for(let i=1;i<=50;i++){h.edit('x'.repeat(i));h.clock.tick(10)}
 check(h.calls.length===0&&h.ui.reflection.length===50&&h.drafts[0].state.reflection.length===50,'50 keys update UI and draft without requests');
 h.clock.tick(690);await h.flush();
 check(h.calls.length===1&&h.calls[0]==='saveSession','50 keys coalesce into one real SQLite save, zero library reads');
 check((await read(item.id)).reflection==='x'.repeat(50),'Debounced content read back from real SQLite');
 check(h.status==='Saved'&&!h.error&&h.drafts.length===0,'Latest acknowledged save clears only its draft');
 check(JSON.stringify((await read(item.id)).steps)===JSON.stringify(initial.steps)&&(await read(item.id)).finished===true,'Reflection preserves route progress, Visited and finished state');
 check(h.library.sessions[0].finished===true&&h.library.sessions[0].updated_at!=='2000-01-01T00:00:00.000Z','Acknowledged local summary updates without list fetch');
 h.edit('blur latest');await Promise.all([h.blur(),h.blur(),h.leave()]);
 check(h.calls.length===2&&(await read(item.id)).reflection==='blur latest','Blur/page-hide duplicate triggers submit latest content once');
 h.clock.tick(1000);await h.flush();check(h.calls.length===2,'Cancelled debounce timer cannot submit again');
 h.edit('old');h.edit('new');h.edit('final');h.clock.tick(700);await h.flush();
 check((await read(item.id)).reflection==='final'&&h.calls.length===3,'Fast edits persist only final version');
 const reopened=pageSaveHarness({id:item.id,state:await read(item.id),server:real});
 check(reopened.ui.reflection==='final'&&reopened.ui.finished,'Fresh client state restores actual saved data');
 let fail=true;item=await create();h=pageSaveHarness({...item,server:(action,args)=>{if(fail){fail=false;throw Error('Simulated disconnected transport')}return real(action,args)}});
 h.edit('kept after failure');await h.blur();
 check(h.error&&h.status!=='Saved'&&h.drafts[0].state.reflection==='kept after failure','Failed transport retains local draft and never reports Saved');
 check(!(await read(item.id)).reflection,'Failed request did not mutate persisted state');
 check(readDraft(h.drafts[0],JSON.stringify(await read(item.id))).kind==='recover','Refresh recovery recognises unsynced local draft');
 check(await h.retry(),'Manual retry uses existing queue');
 check((await read(item.id)).reflection==='kept after failure'&&h.status==='Saved'&&h.drafts.length===0,'Retry persists exact latest data and clears draft');
 // An acknowledgement for A arrives after the visitor has already typed B.
 item=await create();let release,started;const gate=new Promise(r=>release=r),began=new Promise(r=>started=r);let first=true;
 h=pageSaveHarness({...item,server:async(action,args)=>{if(first){first=false;started();await gate}return real(action,args)}});
 h.edit('A');const a=h.blur();await began;h.edit('B latest');release();await a;
 check(h.status!=='Saved'&&h.drafts[0].state.reflection==='B latest','Old response cannot mark a newer pending edit Saved or erase draft');
 check(readDraft(h.drafts[0],JSON.stringify(await read(item.id))).kind==='recover','In-flight acknowledgement advances latest draft CAS base');
 h.clock.tick(700);await h.flush();check((await read(item.id)).reflection==='B latest'&&h.status==='Saved','Final queued edit uses updated CAS acknowledgement');
 // Independent tabs read identical base bytes, then save competing edits.
 item=await create();const tabA=pageSaveHarness({...item,server:real}),tabB=pageSaveHarness({...item,state:structuredClone(item.state),server:real});
 tabA.edit('tab A');await tabA.blur();tabB.edit('tab B');await tabB.blur();
 check(tabB.error&&tabB.conflict?.local.reflection==='tab B'&&tabB.conflict?.remote.reflection==='tab A','Actual SQLite CAS exposes conflict and keeps both versions');
 check((await read(item.id)).reflection==='tab A'&&tabB.status!=='Saved'&&tabB.drafts.length===1,'Conflicting tab never silently overwrites or reports Saved');
 check(tabB.clock.size===0,'Conflict cancels obsolete pending timer');
 check([h,tabA,tabB].every(x=>x.calls.every(a=>a==='saveSession')),'Ordinary acknowledgements trigger no listRoutes/listSessions/getIntentOptions calls');
 item=await create();h=pageSaveHarness({...item,server:real});h.edit('draft before debounce');
 const remote=JSON.stringify(await read(item.id)),found=readDraft(h.drafts[0],remote);h.cancel();
 check(found.kind==='recover'&&found.state.reflection==='draft before debounce','Abrupt reload before debounce recovers latest draft without an asynchronous unload request');
 const recovered=pageSaveHarness({id:item.id,state:found.state,initialAck:remote,server:real});
 check(await recovered.retry()&&(await read(item.id)).reflection==='draft before debounce','Recovered draft saves with the remote CAS base and reads back');
 return {checks:checked,typingCharacters:50,saveRequests:1,libraryRequests:0,persistence:'real SQLite / shipped Drizzle actions'};
}
