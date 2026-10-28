import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {emptyIntent} from '../lib/acquired/intent.ts';

// Exercise the actual presentation handlers without making any API request.
const require=createRequire(import.meta.url),module={exports:{}};
const source=readFileSync(new URL('../app/acquired/intake-review.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
new Function('require','module','exports',code)(id=>id==='./intent-editor'?{IntentEditor:()=>null}:require(id),module,module.exports);
let checks=0;const check=(v,message)=>{assert.ok(v,message);checks++};
const nodes=(node)=>node&&typeof node==='object'?[node,...[node.props?.children].flat(Infinity).flatMap(nodes)]:[];
function render(steps,overrides={}){
 let changed;
 const entity={entity_id:'fixture',name:'Fixture',type:'artist'};
 const tree=module.exports.IntakeReview({destination:entity,seeds:[entity],barrier:'',motivation:'',steps,validSteps:/^(?:[3-9]|10)$/.test(steps),intent:emptyIntent(),options:[],disabled:false,blocked:false,onSteps:v=>changed=v,...overrides});
 const all=nodes(tree),button=label=>all.find(n=>n.type==='button'&&n.props['aria-label']===label);
 return {all,button,changed:()=>changed};
}
for(const [value,direction,expected] of [['3','More stops','4'],['4','Fewer stops','3'],['9','More stops','10'],['10','More stops','10'],['3','Fewer stops','3']]){
 const r=render(value);r.button(direction).props.onClick();check(r.changed()===expected,'mobile count updates the existing string state and stays within bounds');
}
check(render('3').button('Fewer stops').props.disabled,'lower boundary disabled');
check(render('10').button('More stops').props.disabled,'upper boundary disabled');
for(const invalid of ['', '2', '11', '3.5', 'NaN']){
 const r=render(invalid);check(r.all.find(n=>n.type==='output').props.children==='Choose length','invalid values are not displayed as a valid count');
 check(r.all.find(n=>n.type==='button'&&n.props.className==='primary').props.disabled,'invalid count cannot build');
 r.button('More stops').props.onClick();check(r.changed()==='3','invalid desktop state can be corrected to the minimum');
}
const locked=render('4',{disabled:true});check(locked.button('Fewer stops').props.disabled&&locked.button('More stops').props.disabled,'busy state locks both controls');
const blocked=render('4',{blocked:true});check(blocked.all.some(n=>n.type==='p'&&!n.props.className&&String(n.props.children).includes('Some preferences still need')),'blocking instructions remain visible on mobile');

// Every rule that targets existing UI must remain under the mobile breakpoint.
const css=readFileSync(new URL('../app/acquired/mobile-polish.css',import.meta.url),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
let depth=0,start=0;const top=[];
for(let k=0;k<css.length;k++){if(css[k]==='{'){if(depth===0)top.push(css.slice(start,k).trim());depth++;}if(css[k]==='}'){depth--;if(depth===0)start=k+1;}}
check(depth===0,'stylesheet braces balanced');
assert.deepEqual(top,['.mobile-polish-only','@media(max-width:768px)']);checks++;
check(/\.mobile-polish-only\s*\{display:none\}/.test(css),'new mobile presentation is absent from desktop layout');
console.log(`${checks} mobile presentation assertions passed; no live calls.`);
