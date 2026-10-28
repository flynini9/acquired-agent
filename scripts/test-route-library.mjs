import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {uniqueRouteCount,readRouteLibrary} from '../app/acquired/route-library.ts';
let checks=0;const equal=(a,b)=>{assert.deepEqual(a,b);checks++};
const route=id=>({route_id:id,title:'Same display title',destination:'Same destination'});
const session=(id,route_id,finished=false)=>({id,route_id,route_title:'Same display title',finished,updated_at:'now'});
equal(uniqueRouteCount({routes:[],sessions:[]}),0);
equal(uniqueRouteCount({routes:[],sessions:[session(1,'a')]}),1);
equal(uniqueRouteCount({routes:[route('a')],sessions:[session(1,'a')]}),1);
equal(uniqueRouteCount({routes:[route('a'),route('b')],sessions:[session(1,'a'),session(2,'b')]}),2);
equal(uniqueRouteCount({routes:[route('a')],sessions:[session(1,'a'),session(2,'a',true)]}),1);
equal(uniqueRouteCount({routes:[],sessions:[session(1,'a',true)]}),1);
let server={routes:[route('a')],sessions:[session(1,'a')]};
const read=async(action,args)=>({result:action==='listRoutes'?{routes:server.routes}:action==='listSessions'?{sessions:server.sessions}:{session:{data:JSON.stringify({routeId:'a'})}}});
let library=await readRouteLibrary(read);equal(uniqueRouteCount(library),1);
server={routes:[route('a'),route('b')],sessions:[session(1,'a'),session(2,'b')]};
library=await readRouteLibrary(read);equal(uniqueRouteCount(library),2);
// Reopening constructs the complete count from server rows, without old state.
equal(uniqueRouteCount(await readRouteLibrary(read)),2);
server.sessions=[session(1,'a',true),session(2,'b',true)];
equal(uniqueRouteCount(await readRouteLibrary(read)),2);
server={routes:[route('a')],sessions:[session(3,null)]};
equal(uniqueRouteCount(await readRouteLibrary(read)),1);
equal(server.sessions[0].route_id,null); // read-only legacy identity resolution
const page=readFileSync(new URL('../app/acquired/page.tsx',import.meta.url),'utf8');
assert.ok(page.includes('uniqueRouteCount(routeLibrary)')&&page.includes('const {routes,sessions}=routeLibrary'));checks++;
assert.ok(page.includes('revision!==libraryRevision.current')&&page.includes('if(saveStatus==="Saved"'));checks++;
assert.ok(!page.includes('setRoutes(')&&!page.includes('setSessions('));checks++;
console.log(`${checks} route-library assertions passed; no live calls.`);
