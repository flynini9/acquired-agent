import { AsyncLocalStorage } from 'node:async_hooks';
import {readQlooRejection,rejectionHeader} from './qloo-rejection.mjs';
export {rejectionHeader};
export type Phase='required'|'explanation';
export type Call={n:number;category:string;path:string;status:number|null;elapsedMs:number;phase?:Phase;rejection?:'invalid_entity_signals';failedQuery?:{resultType?:string;signalEntityIds:string[];resultEntityIds:string[]}};
type ExplanationScope={start:number;deadline:number;limit:number;used:number;exhausted:boolean;stopped?:boolean;closed?:boolean;controller:AbortController};
const explanationStorage=new AsyncLocalStorage<ExplanationScope>();
export function currentPhase():Phase{return explanationStorage.getStore()?'explanation':'required';}
export type Trace={beforeQlooRequest?:()=>Promise<void>;publicQuotaFailure?:{resetAt:number;phase:Phase};id:string;start:number;limit:number;deadline:number;calls:Call[];active:number;maxActive:number;exhausted:boolean;cancelled?:boolean;requiredComplete?:boolean;explanation?:ExplanationScope;explanationPolicy?:{limit:number;timeoutMs:number};upstreamFailure?:{status:number|null;retryAfterSeconds?:number;phase?:Phase};signalFailure?:{entityIds:string[];stage:string;phase?:Phase};minIntervalMs:number;cache:boolean;cacheHits:number;cacheMaxAgeMs:number;queued:number;pending:Map<string,Promise<Response>>};
export const traceStorage=new AsyncLocalStorage<Trace>();
// Conservative local sending policy; this is not Qloo's documented quota.
export function newTrace(policy:{minIntervalMs?:number;cache?:boolean;cacheMaxAgeMs?:number}={}):Trace{const start=Date.now();return{id:crypto.randomUUID(),start,limit:180,deadline:start+240000,calls:[],active:0,maxActive:0,exhausted:false,minIntervalMs:policy.minIntervalMs??500,cache:policy.cache??true,cacheHits:0,cacheMaxAgeMs:policy.cacheMaxAgeMs??120000,queued:0,pending:new Map()};}
// The only checkpoint allowed to retain a completed route after optional I/O
// fails. A subsequent required external read invalidates it automatically.
export async function runExplanation<T>(fn:()=>Promise<T>):Promise<T>{
 const t=traceStorage.getStore();if(!t)throw Error('缺少请求上下文');
 guard(t);t.requiredComplete=true;
 const start=Date.now(),policy=t.explanationPolicy??{limit:8,timeoutMs:5000};
 const scope:ExplanationScope={start,deadline:Math.min(t.deadline,start+policy.timeoutMs),limit:policy.limit,used:0,exhausted:false,controller:new AbortController()};
 t.explanation=scope;
 const timer=setTimeout(()=>{scope.exhausted=true;scope.controller.abort();},Math.max(1,scope.deadline-Date.now()));
 try{return await explanationStorage.run(scope,fn);}finally{clearTimeout(timer);scope.closed=true;scope.controller.abort();}
}
export function measuredDeliveryAllowed(t:Trace){return (!t.publicQuotaFailure||t.publicQuotaFailure.phase==='explanation')&&t.requiredComplete===true&&!t.cancelled&&!t.exhausted&&(!t.upstreamFailure||t.upstreamFailure.phase==='explanation')&&(!t.signalFailure||t.signalFailure.phase==='explanation');}
export function providerFailure(t:Trace){if(!t.upstreamFailure)return null;const {status,retryAfterSeconds}=t.upstreamFailure;return{code:status===429?'rate_limited':'upstream_unavailable',message:status===429?`Qloo 暂时限流，本次测量已停止，尚不能判断路线是否走得通。${retryAfterSeconds?`请至少等待 ${retryAfterSeconds} 秒后再试。`:'请稍后再试，先不要重复提交。'}`:'Qloo 服务暂时不可用，本次测量已停止，尚不能判断路线是否走得通。已有路线保留。',upstreamStatus:status,...(retryAfterSeconds?{retryAfterSeconds}:{})};}
export function summary(t:Trace){const categories:Record<string,number>={};for(const c of t.calls)categories[c.category]=(categories[c.category]??0)+1;return{requestId:t.id,elapsedMs:Date.now()-t.start,qlooRequests:t.calls.filter(c=>c.category!=='translation').length,externalRequests:t.calls.length,categories,active:t.active,maxActive:t.maxActive,queued:t.queued,cacheHits:t.cacheHits,activity:t.calls.filter(c=>c.elapsedMs===0).at(-1)?.category??t.calls.at(-1)?.category??null,budgetExhausted:t.exhausted,phase:t.requiredComplete?'explanation':'required',requiredComplete:t.requiredComplete??false,explanation:t.explanation?{requests:t.explanation.used,budgetExhausted:t.explanation.exhausted,elapsedMs:Date.now()-t.explanation.start}:null};}
export async function settleTrace(t:Trace){await Promise.allSettled([...t.pending.values()]);}

type CacheEntry={body:Uint8Array;at:number};
const responses=new Map<string,CacheEntry>();let cacheBytes=0;
const MAX_CACHE_BYTES=4*1024*1024,MAX_ENTRY_BYTES=256*1024,MAX_ENTRIES=64;
let queue:Promise<unknown>=Promise.resolve(),lastQlooStart=0;
function guard(t:Trace,scope=explanationStorage.getStore()){
 if(scope?.stopped||scope?.closed)throw Error('解释补充已停止');
 if(t.publicQuotaFailure)throw Error('Public beta request limit reached');
 if(t.cancelled)throw Error('请求已取消');
 if(t.signalFailure)throw Error('本次信号无法计算，停止后续外呼');
 if(t.upstreamFailure)throw Error('本次上游服务已不可用，停止后续外呼');
 if(scope&&(scope.exhausted||scope.used>=scope.limit||Date.now()>=scope.deadline)){
  scope.exhausted=true;throw Error('解释补充达到独立预算，保留已完成测量的路线');
 }
 if(t.exhausted||Date.now()>=t.deadline){if(scope)scope.exhausted=true;else t.exhausted=true;throw Error('本次建路达到实验预算，已停止外部请求');}
}
function cached(key:string,t:Trace):Response|null{if(!t.cache)return null;const e=responses.get(key);if(!e)return null;if(Date.now()-e.at>t.cacheMaxAgeMs){responses.delete(key);cacheBytes-=e.body.byteLength;return null;}responses.delete(key);responses.set(key,e);t.cacheHits++;return new Response(e.body.slice(),{headers:{'Content-Type':'application/json','X-Acquired-Cache':'hit','X-Acquired-Measured-At':String(e.at)}});}
function saveCache(key:string,body:Uint8Array){if(body.byteLength>MAX_ENTRY_BYTES)return;const old=responses.get(key);if(old){responses.delete(key);cacheBytes-=old.body.byteLength;}responses.set(key,{body,at:Date.now()});cacheBytes+=body.byteLength;while(responses.size>MAX_ENTRIES||cacheBytes>MAX_CACHE_BYTES){const first=responses.keys().next().value;if(!first)break;cacheBytes-=responses.get(first)!.body.byteLength;responses.delete(first);}}
async function cacheIdentity(url:URL,input:RequestInfo|URL,init?:RequestInit){const headers=new Headers(input instanceof Request?input.headers:undefined);new Headers(init?.headers).forEach((v,k)=>headers.set(k,v));const key=headers.get('X-Api-Key'),method=init?.method??(input instanceof Request?input.method:'GET');if(!key||method.toUpperCase()!=='GET')return null;const canonical=new URL(url);canonical.searchParams.sort();const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key+'\n'+canonical.href));return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');}
function categoryOf(url:URL){return url.origin.includes('mymemory')?'translation':url.pathname==='/search'?'search':url.searchParams.has('signal.interests.tags')?'kinship':url.searchParams.get('feature.explainability')==='true'?'attribution':url.searchParams.has('filter.results.entities')?'oracle':url.searchParams.get('filter.type')==='urn:tag'?'tagProfile':'neighborhood';}
// A rejected Insights request needs enough catalogue identity to reproduce
// it. Retain only typed UUIDs and a type URN, never query text, headers,
// provider body, complete URLs or arbitrary parameter values.
function failedQueryOf(url:URL):Call['failedQuery']{
 const ids=(key:string)=>(url.searchParams.get(key)??'').split(',').filter(id=>/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)).slice(0,50);
 const resultType=url.searchParams.get('filter.type')??'';
 return {...(/^urn:(?:entity:[a-z_]+|tag)$/.test(resultType)?{resultType}:{}),signalEntityIds:ids('signal.interests.entities'),resultEntityIds:ids('filter.results.entities')};
}
async function fetchOnce(input:RequestInfo|URL,init:RequestInit|undefined,url:URL,t:Trace):Promise<Response>{
 const scope=explanationStorage.getStore();guard(t,scope);if(t.calls.length>=t.limit){if(scope)scope.exhausted=true;else t.exhausted=true;throw Error('本次建路达到实验预算，已停止外部请求');}
 if(url.origin==='https://hackathon.api.qloo.com')await t.beforeQlooRequest?.();
 const call:Call={n:t.calls.length+1,category:categoryOf(url),path:url.pathname,status:null,elapsedMs:0,phase:currentPhase()};t.calls.push(call);if(scope)scope.used++;t.active++;t.maxActive=Math.max(t.maxActive,t.active);const started=Date.now(),deadline=AbortSignal.timeout(Math.max(1,Math.min(t.deadline,scope?.deadline??Infinity)-Date.now()));
 try{const r=await fetch(input,{...init,redirect:'manual',signal:AbortSignal.any([deadline,...(init?.signal?[init.signal]:[]),...(scope?[scope.controller.signal]:[])])});call.status=r.status;if(r.status>=400&&url.origin==='https://hackathon.api.qloo.com'&&url.pathname==='/v2/insights')call.failedQuery=failedQueryOf(url);if(scope&&r.status>=400)scope.stopped=true;if(url.origin==='https://hackathon.api.qloo.com'&&(r.status===429||r.status>=500)){const raw=r.headers.get('Retry-After');let seconds=raw==null?NaN:Number(raw);if(raw&&Number.isNaN(seconds))seconds=(Date.parse(raw)-Date.now())/1000;t.upstreamFailure??={status:r.status,phase:currentPhase(),...(Number.isFinite(seconds)&&seconds>0?{retryAfterSeconds:Math.ceil(seconds)}:{})};await r.body?.cancel().catch(()=>{});return new Response(null,{status:r.status,headers:r.headers});}if(url.origin==='https://hackathon.api.qloo.com'&&r.status>=400){const headers=new Headers(r.headers);headers.delete(rejectionHeader);const rejection=r.status===400&&url.pathname==='/v2/insights'&&url.searchParams.has('signal.interests.entities')?await readQlooRejection(r):null;if(rejection){call.rejection=rejection;headers.set(rejectionHeader,rejection);}else await r.body?.cancel().catch(()=>{});return new Response(null,{status:r.status,headers});}return r;}
 catch(e){if(scope&&Date.now()>=scope.deadline)scope.exhausted=true;if(url.origin==='https://hackathon.api.qloo.com'&&!t.exhausted&&!scope?.exhausted)t.upstreamFailure??={status:null,phase:currentPhase()};throw e;}
 finally{call.elapsedMs=Date.now()-started;t.active--;}
}
export async function trackedFetch(input:RequestInfo|URL,init?:RequestInit):Promise<Response>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin!=='https://hackathon.api.qloo.com'&&url.origin!=='https://api.mymemory.translated.net')throw Error('不支持的外部目标');const t=traceStorage.getStore();if(!t)throw Error('缺少请求计数上下文');if(!explanationStorage.getStore())t.requiredComplete=false;guard(t);
 if(url.origin!=='https://hackathon.api.qloo.com')return fetchOnce(input,init,url,t);
 const key=await cacheIdentity(url,input,init);guard(t);if(key){const hit=cached(key,t);if(hit)return hit;const running=t.pending.get(key);if(running){t.cacheHits++;return(await running).clone();}}
 t.queued++;let started=false,released=false;
 const releaseQueued=()=>{if(!released){released=true;t.queued--;}};
 const scope=explanationStorage.getStore();
 const work=async()=>{started=true;try{guard(t);if(key){const hit=cached(key,t);if(hit)return hit;}const wait=Math.max(0,lastQlooStart+t.minIntervalMs-Date.now());const scope=explanationStorage.getStore();if(Date.now()+wait>=Math.min(t.deadline,scope?.deadline??Infinity)){if(scope)scope.exhausted=true;else t.exhausted=true;throw Error('本次建路达到实验预算，已停止外部请求');}if(wait)await new Promise(r=>setTimeout(r,wait));guard(t);lastQlooStart=Date.now();const r=await fetchOnce(input,init,url,t);if(r.status===200&&r.headers.get('content-type')?.includes('application/json')){
 let body:Uint8Array;
 try{body=new Uint8Array(await r.arrayBuffer());}catch(e){if(scope&&Date.now()>=scope.deadline)scope.exhausted=true;if(!scope?.exhausted)t.upstreamFailure??={status:null,phase:currentPhase()};throw e;}
 try{
  const data=JSON.parse(new TextDecoder().decode(body));
  const sent=(url.searchParams.get('signal.interests.entities')??'').split(',').filter(Boolean);
  const byLower=new Map(sent.map(id=>[id.toLowerCase(),id]));
  const rejected=new Set<string>();
  for(const w of Array.isArray(data?.warnings)?data.warnings:[]){
   if(w?.type!=='not_found')continue;
   const ids=w['signal.interests.entities']??w.signal?.interests?.entities;
   if(Array.isArray(ids))for(const id of ids)if(typeof id==='string'&&byLower.has(id.toLowerCase()))rejected.add(byLower.get(id.toLowerCase())!);
  }
  // Inspect before releasing the send queue, including when caching is off.
  if(rejected.size)t.signalFailure??={entityIds:[...rejected],stage:categoryOf(url)==='oracle'?'measure':categoryOf(url)==='tagProfile'?'profile':categoryOf(url)==='neighborhood'?'ring':'why',phase:currentPhase()};
  if(key&&t.cache&&data&&typeof data==='object'&&data.results!=null&&!data.error&&!rejected.size&&!(Array.isArray(data.warnings)&&data.warnings.some((w:unknown)=>w!=null&&typeof w==='object'&&(w as Record<string,unknown>).type==='not_found')))saveCache(key,body);
 }catch{}
 return new Response(body.slice(),{status:r.status,headers:r.headers});
}return r;}finally{releaseQueued();}};
 const queued=queue.then(work);queue=queued.then(()=>{},()=>{});
 // A job waiting behind another request must respect its own deadline too.
 // Cancel its wait now; the queue's later callback only guards and sends nothing.
 const result=scope?new Promise<Response>((resolve,reject)=>{
  const abort=()=>{if(!started){releaseQueued();reject(Error('解释补充等待到限'));}};
  scope.controller.signal.addEventListener('abort',abort,{once:true});
  queued.then(resolve,reject).finally(()=>scope.controller.signal.removeEventListener('abort',abort));
  if(scope.controller.signal.aborted)abort();
 }):queued;
 if(key){t.pending.set(key,result);try{return(await result).clone();}finally{t.pending.delete(key);}}return result;
}
