import assert from 'node:assert/strict';
import {startWalk,cursor,stepDone,canReroute,applyReroute,measuredSwap,effectiveExplanationStatus} from '../lib/acquired/walk.ts';
const b={schema:'acquired-route/2',route_id:'qa',meta:{title:'QA',destination:'End'},config:{step_metrics:['熟悉','陌生','好感'],step_scale:5,primary_metric:'好感',baseline_scale:10,max_skip_per_step:1},baseline_works:[],destination_works:[],steps:['A','B','End'].map((name,n)=>({n:n+1,name,type:'artist',entity_id:name,tracks:[{title:name,url:'https://example.com'}],alternates:[{entity_id:'Alt',name:'Alt',tracks:[{title:'Alt',url:'https://example.com'}]}]}))};
let w=startWalk(b);assert.equal(cursor(w),0);assert.equal(stepDone(b,w,0),false);
w.steps[0].ratings[0]={'熟悉':3,'陌生':4,'好感':2};assert.equal(stepDone(b,w,0),true);assert.equal(canReroute(b,w,0),true);
let next=structuredClone(b);next.steps[0]={...next.steps[0],entity_id:'New',name:'New'};
const r=applyReroute(b,w,0,next,'QA reroute');assert.equal(r.rerouteCount,1);assert.equal(r.steps[0].ratings[0]['好感'],undefined);assert.equal(JSON.parse(r.routeData).steps.at(-1).entity_id,'End');
assert.throws(()=>applyReroute(b,{...w,rerouteCount:2},0,next,'third'));
let bad=structuredClone(next);bad.steps[2].entity_id='Wrong';assert.throws(()=>applyReroute(b,w,0,bad,'bad destination'));
w.steps[0].cont=true;w.steps[1].ratings[0]={'熟悉':2,'陌生':3,'好感':1};w.sitesCursor=1;let tail=structuredClone(b);tail.steps[1].entity_id='New';const rr=applyReroute(b,w,1,tail,'tail');assert.deepEqual(rr.steps[0],w.steps[0]);
bad=structuredClone(tail);bad.steps[0].entity_id='Changed';assert.throws(()=>applyReroute(b,w,1,bad,'bad prefix'));
const swapped=measuredSwap(b,w,1,b.steps[1].alternates[0]);assert.equal(swapped.steps[1].override.entity_id,'Alt');assert.equal(swapped.steps[1].ratings[0]['好感'],undefined);assert.deepEqual(swapped.steps[0],w.steps[0]);assert.throws(()=>measuredSwap(b,w,1,{entity_id:'Other',tracks:[]}));
let done=structuredClone(w);delete done.sitesCursor;done.steps.forEach(s=>s.cont=true);assert.equal(cursor(done),3);assert.deepEqual(JSON.parse(JSON.stringify(swapped)),swapped);
console.log('Walk checks passed: score readiness, two-reroute limit, fixed destination/prefix, override persistence, rating reset and completed-session recovery. No live requests.');

const explained=structuredClone(b);explained.steps.forEach(s=>s.why={text:'measured',explanation_status:'complete'});const ew=startWalk(explained);assert.equal(effectiveExplanationStatus(explained,ew),'complete');ew.steps[1].override={...explained.steps[1],why:{text:'',explanation_status:'missing'}};assert.equal(effectiveExplanationStatus(explained,ew),'partial');

const {explanationText}=await import('../lib/acquired/route-evidence.ts');
const linked={entity_id:'A',why:{text:'Taste fact. Old neighbor.',routing_text:' Old neighbor.',routing_link:{from_entity_id:'B',to_entity_id:'A'}}};
assert.equal(explanationText(linked,{entity_id:'B'}),'Taste fact. Old neighbor.');
assert.equal(explanationText(linked,{entity_id:'Alt'}),'Taste fact.');
assert.equal(explanationText(linked),'Taste fact.');
