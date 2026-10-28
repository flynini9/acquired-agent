import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {catalogDescription} from '../lib/acquired/catalog-description.ts';
import {startWalk,measuredSwap,effective,effectiveExplanationStatus} from '../lib/acquired/walk.ts';
import {englishWhy} from '../lib/acquired/english-copy.ts';
let checks=0;const check=(v,m)=>{assert.ok(v,m);checks++};
for(const tail of ['Th','ro',"('Deep', 'Jum",'blend elements of ju','under which he produces ele']){
 const raw='A catalog account of this work and its music. '.repeat(8).slice(0,220-tail.length)+tail;
 const copy=catalogDescription(raw);
 check(copy.kind==='excerpt'&&copy.text.endsWith('…'),'known application cap explicitly marked');
 check(!copy.text.slice(0,-1).endsWith(tail.split(' ').at(-1)),'uncertain trailing token omitted');
 check(copy.note.includes('app shortened'),'local truncation distinguished from source');
 check(raw.length===220,'stored evidence never modified');
}
const candidate='A catalog account of this work and its music. '.repeat(3).slice(0,60)+'…';
check(catalogDescription(candidate,true).kind==='excerpt','legacy candidate cap recognized');
check(catalogDescription('A complete catalog sentence.').text==='A complete catalog sentence.','complete sentence unchanged');
check(catalogDescription('Source supplied ele').text==='Source supplied ele …','source fragment retained verbatim with explicit ending');
check(catalogDescription('Source supplied ele').kind==='source-fragment','upstream fragment never presented as app cap');
const b={schema:'acquired-route/2',route_id:'regression',meta:{title:'QA',destination:'End'},config:{step_metrics:['熟悉','陌生','好感'],step_scale:5,primary_metric:'好感',baseline_scale:10,max_skip_per_step:1},baseline_works:[],destination_works:[],steps:['TC','Bridge','End'].map((name,k)=>({n:k+1,name,type:'artist',entity_id:name,tracks:[{title:name,url:'https://example.test'}],alternates:k===0?[{name:'Spor',type:'artist',entity_id:'Spor',tracks:[{title:'Spor',url:'https://example.test'}],why:{text:'Measured connection only.',seed:'Seed',tags:[],explanation_status:'partial'}}]:[]}))};
const original=JSON.stringify(b),w=measuredSwap(b,startWalk(b),0,b.steps[0].alternates[0]);
check(effective(b,w,0).name==='Spor','current stop uses measured override');
w.steps[0].ratings[0]={'熟悉':3,'陌生':3,'好感':4};w.steps[0].cont=true;w.sitesCursor=1;
check(effective(b,w,0).name==='Spor'&&w.steps[0].cont===true,'visited stop retains override');
w.steps.forEach(s=>s.cont=true);w.finished=true;w.sitesCursor=3;
check(b.steps.map((_,k)=>effective(b,w,k).name).join()==='Spor,Bridge,End','summary uses same effective entities');
check(effectiveExplanationStatus(b,w)==='partial','missing explanation stays honest');
check(!englishWhy(effective(b,w,0)).includes('Shared taste tags'),'empty tags never fabricated');
check(englishWhy({...effective(b,w,0),why:{text:'它与你的已有喜欢有实测关联。',seed:'Seed',tags:['electronic'],explanation_status:'complete'}}).includes('Shared taste tags: electronic'),'actual generated why path renders supplied verified tags');
check(JSON.stringify(b)===original,'swap never rewrites old route');
const page=await readFile(new URL('../app/acquired/page.tsx',import.meta.url),'utf8');
check(page.includes('const s=effective(bundle,walk,k),visited=walk.steps[k]?.cont!=null'),'navigation consumes actual effective entity and recorded visited state');
for(const file of ['page.tsx','intake-review.tsx']){
 const s=await readFile(new URL('../app/acquired/'+file,import.meta.url),'utf8');
 check(!/STEP\s+\d|\/ 08|Finish step 3/.test(s),'internal workflow numbering removed');
 check(!/[“][^\n]*?[」』]/.test(s),'no mixed wrapper quotes');
}
console.log(`${checks} known UI regression assertions passed; no live calls.`);
