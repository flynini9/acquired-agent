import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import {sameOrigin,limitedJson,type Visitor} from '@/lib/acquired/public-access';
import {visitorForRequest} from '@/lib/acquired/guest-identity';
import {reserveAction,reserveQloo,reserveSession,reserveBuild,PublicBudgetError} from '@/lib/acquired/public-budget';
import {englishError} from '@/lib/acquired/english-errors';
import type { z } from 'zod';
import { getDb } from '@/db';
import { acquiredRuns } from '@/db/schema';
import { Actions as CoreActions, SitesIntentActions } from '@/lib/acquired/upstream-actions';
import type { Ctx } from '@/lib/acquired/action-runtime';
import { newTrace, providerFailure, summary, settleTrace, measuredDeliveryAllowed, traceStorage, type Trace } from '@/lib/acquired/telemetry';
import { localCooldownUntil, cooldownMessage } from '@/lib/acquired/cooldown';
export const dynamic='force-dynamic';
const Actions={...CoreActions,...SitesIntentActions};
const headers={'Cache-Control':'no-store','X-Acquired-Upstream':'fd9141bacbf479f8cd073c94142f1b403a76e2c3','X-Acquired-Phases':'1','X-Acquired-Explanations':'facts-first-v1','X-Acquired-Links':'reverse','X-Acquired-Wish':'1','X-Acquired-Candidate-Receipt':'1','X-Acquired-Routing':'reverse-v1','X-Acquired-Signal-Fix':'3'};
const allowed=['parseConstraints','buildRoute','listRoutes','getRoute','createSession','getSession','saveSession','listSessions','swapStepMeasured','rerouteFromStep','getIntentOptions','resolveIntentDestination','checkIntentSignal'] as const;
const longActions=new Set<string>(['parseConstraints','resolveIntentDestination','checkIntentSignal','buildRoute','swapStepMeasured','rerouteFromStep']);
type Config={request:z.ZodTypeAny;response:z.ZodTypeAny;handler:(ctx:Ctx,args:unknown)=>Promise<unknown>};
function scrub(data:unknown) {
 let text=JSON.stringify(data);for(const value of [(env as unknown as Record<string,string>).QLOO_API_KEY,(env as unknown as Record<string,string>).LAB_TEST_SECRET,(env as unknown as Record<string,string>).ACQUIRED_GUEST_SECRET])if(value){text=text.split(value).join('[REDACTED]');}
 const safe=JSON.parse(text);if(safe?.result?.error)safe.result.error=englishError(safe.result.error,safe.result.error_code);if(safe?.error)safe.error=englishError(safe.error,safe.error_code);return safe;
}
export async function GET() {return Response.json({error:'Not found'},{status:404,headers});}
async function execute(action:typeof allowed[number], args:unknown, t:Trace, visitor?:Visitor) {
 const db=getDb();const ctx:Ctx={db:<T>()=>db,invalidateQueries:()=>{},ownerId:visitor?.userId,isOwner:visitor?.isOwner};
 const config=Actions[action] as unknown as Config;
 const parsed=config.request.parse(args);
 await db.insert(acquiredRuns).values({id:t.id,action,status:'running',metrics:JSON.stringify(summary(t)),createdAt:t.start});
 let cooldownUntil:number|undefined;
 async function recordCooldown(){
  if(t.upstreamFailure?.status!==429||!env.DB)return;
  cooldownUntil=localCooldownUntil(t.upstreamFailure.retryAfterSeconds);
  await env.DB.prepare("INSERT INTO acquired_build_lock(id,request_id,expires_at) VALUES('qloo-cooldown',?,?) ON CONFLICT(id) DO UPDATE SET request_id=excluded.request_id,expires_at=MAX(acquired_build_lock.expires_at,excluded.expires_at)").bind(t.id,cooldownUntil).run();
 }
 try {
  if(visitor&&action==='createSession')await reserveSession(env.DB!,visitor.userId);
  if(visitor&&action==='buildRoute')await reserveBuild(env.DB!,visitor.userId);
  // Mirror the existing upstream UI rule at the HTTP boundary too.
  // Direct callers must not bypass the low-rating / two-reroute limit.
  if(action==='rerouteFromStep'){
   const input=parsed as {session_id:number;cliff_index:number;like_score:number};
   const record=await Actions.getSession.handler(ctx,{id:input.session_id});
   const state=record.session?JSON.parse(record.session.data):null;
   const route=state?.routeData?JSON.parse(state.routeData):null;
   const st=state?.steps?.[input.cliff_index];
   const metric=route?.config?.primary_metric??'好感';
   const values=Array.isArray(st?.ratings)?st.ratings.flatMap((r:Record<string,number>,j:number)=>!st.skipped?.includes(j)&&typeof r[metric]==='number'?[r[metric]]:[]):[];
   if(!state||state.rerouteCount>=2||!values.length||Math.min(...values)>2||input.like_score!==Math.min(...values)){
    await db.update(acquiredRuns).set({status:'returned_error',metrics:JSON.stringify({...summary(t),calls:t.calls})}).where(eq(acquiredRuns.id,t.id));
    return {result:{ok:false,error:'Rebuilding requires a saved liking score of 2 or less and is limited to twice per walk.'},trace:{...summary(t),calls:t.calls}};
   }
  }
  let result=config.response.parse(await traceStorage.run(t,()=>config.handler(ctx,parsed))) as Record<string,unknown>;
  await settleTrace(t);
  await recordCooldown();
  if(t.publicQuotaFailure&&!measuredDeliveryAllowed(t))throw new PublicBudgetError(t.publicQuotaFailure.resetAt);
  if(t.exhausted)throw new Error('实验预算已达上限，请查看本次调用记录');
  if(t.signalFailure&&!measuredDeliveryAllowed(t)){
   result={...result,ok:false,error:'选中的一个条目虽然搜得到，但 Qloo 目前无法用它计算品味关联。请重新确认具体条目，目标和条件会保留。',error_code:'signal_unavailable',
    error_detail:{reason:'signal_unavailable',status:200,stage:t.signalFailure.stage,retry_after_seconds:null,retryable:false,signal_entity_ids:t.signalFailure.entityIds},
    bundle:null,step:null,route_id:null,need_choice:null,conflict_decision:null};
  }
  const unavailable=providerFailure(t);
  if(unavailable&&!measuredDeliveryAllowed(t)){
   // Retain the core receipt (including its safe stage/Retry-After fields),
   // but never accept a partial success after any observed provider failure.
   const detail=result.error_detail as Record<string,unknown>|null;
   result={...result,ok:false,error:unavailable.message,error_code:'upstream_unavailable',
    error_detail:{reason:t.upstreamFailure!.status===429?'rate_limited':t.upstreamFailure!.status==null?'network':'upstream_5xx',status:t.upstreamFailure!.status,stage:typeof detail?.stage==='string'?detail.stage:'other',retry_after_seconds:t.upstreamFailure!.retryAfterSeconds??null,retryable:true},
    bundle:null,step:null,route_id:null,need_choice:null};
  }
  let saved=false;
  if(action==='buildRoute'&&result.ok===true&&typeof result.bundle==='string'){
   const bundle=JSON.parse(result.bundle);if(bundle.schema!=='acquired-route/2'||!Array.isArray(bundle.steps))throw new Error('路线结构不完整');
   const imported=await Actions.importRoute.handler(ctx,{data:result.bundle});
   if(!imported.ok)throw new Error('路线已生成但保存失败');
   const check=await Actions.getRoute.handler(ctx,{route_id:String(result.route_id)});
   if(!check.route||check.route.data!==result.bundle)throw new Error('保存后读取校验失败');
   saved=true;
  }
  const needsInput=Boolean(result.need_choice||result.conflict_decision);
  const failure=result.ok===false&&!needsInput?{
   code:typeof result.error_code==='string'?result.error_code:'action_failed',
   // Store sanitized business failures privately; never retain raw provider exceptions.
   message:result.error_code==='router'?'路由器内部错误，原始异常未记录。':typeof result.error==='string'?String(scrub(result.error)).slice(0,1600):'操作未完成',
   ...(['signal_unavailable','measurement_incomplete','signal_check_rejected','query_rejected','forward_link_unverified'].includes(String(result.error_code))?{detail:result.error_detail}:{}),
  }:null;
  const trace={...summary(t),calls:t.calls,...(failure?{failure}:{})};
  await db.update(acquiredRuns).set({status:needsInput?'needs_choice':result.ok===false?'returned_error':'completed',routeId:typeof result.route_id==='string'?result.route_id:null,metrics:JSON.stringify(trace)}).where(eq(acquiredRuns.id,t.id));
  console.log(JSON.stringify({acquired:true,...summary(t),action,saved,...(failure?{errorCode:failure.code}:{})}));
  return scrub({result,saved,trace,...(cooldownUntil?{cooldownUntil}:{})});
 }catch(e){
  await settleTrace(t);
  const failure=providerFailure(t);
  if(e instanceof PublicBudgetError||t.publicQuotaFailure&&!measuredDeliveryAllowed(t)){const resetAt=t.publicQuotaFailure?.resetAt??(e as PublicBudgetError).resetAt;await db.update(acquiredRuns).set({status:'quota_stopped',metrics:JSON.stringify(summary(t))}).where(eq(acquiredRuns.id,t.id));return {error:new PublicBudgetError(resetAt).message,error_code:'public_quota',...(resetAt<Number.MAX_SAFE_INTEGER?{cooldownUntil:resetAt}:{})};}
  const trace={...summary(t),calls:t.calls,...(failure?{failure}:{})};
  await db.update(acquiredRuns).set({status:'failed',metrics:JSON.stringify(trace)}).where(eq(acquiredRuns.id,t.id));
  console.log(JSON.stringify({acquired:true,...summary(t),action,failed:true}));
  // Upstream/provider exception text is not sent to clients or logs.
  return {error:englishError(failure?.message??(t.exhausted?'This request reached 180 calls or four minutes. No incomplete route was saved.':'This operation could not finish. Your existing routes are preserved.'),failure?.code),...(failure?{error_code:failure.code}:{}),...(cooldownUntil?{cooldownUntil}:{}),trace};
 }
}
export async function POST(request:Request) {
 let visitor:Visitor|null;try{const e=env as unknown as Record<string,string>;visitor=await visitorForRequest(request,{ownerEmail:e.ACQUIRED_OWNER_EMAIL,guestSecret:e.ACQUIRED_GUEST_SECRET});}catch{return Response.json({error:'Visitor access is temporarily unavailable.'},{status:503,headers});}
 if(!visitor)return Response.json({error:'Reload to start your private visitor session. Cookies must be enabled.',error_code:'visitor_session_required'},{status:401,headers});
 if(!sameOrigin(request))return Response.json({error:'ORIGIN_REJECTED'},{status:403,headers});
 let body:Record<string,unknown>;try{body=await limitedJson(request);}catch(e){const large=e instanceof Error&&e.message==='INPUT_TOO_LARGE';return Response.json({error:large?'INPUT_TOO_LARGE':'INVALID_INPUT'},{status:large?413:400,headers});}
 try{if(!env.DB)throw Error();await reserveAction(env.DB,visitor.userId);}catch(e){return Response.json({error:e instanceof PublicBudgetError?e.message:'The service is temporarily unavailable.',error_code:e instanceof PublicBudgetError?'public_quota':'unavailable',...(e instanceof PublicBudgetError?{cooldownUntil:e.resetAt}:{})},{status:e instanceof PublicBudgetError?429:503,headers});}
 if(!allowed.includes(body.action as typeof allowed[number]))return Response.json({error:'ACTION_NOT_AVAILABLE'},{status:400,headers});
 const action=body.action as typeof allowed[number];const config=Actions[action] as unknown as Config;
 if(!config.request.safeParse(body.args??{}).success)return Response.json({error:'Please check your input.'},{status:400,headers});
 if(longActions.has(action)&&(action!=='parseConstraints'||Boolean((body.args as Record<string,unknown>|undefined)?.destinationEntityId))){
  try{
   if(!env.DB)throw Error();
   const row=await env.DB.prepare("SELECT expires_at FROM acquired_build_lock WHERE id='qloo-cooldown'").first<{expires_at:number}>();
   if(row&&row.expires_at>Date.now())return Response.json({error:englishError(cooldownMessage(row.expires_at),'local_cooldown'),error_code:'local_cooldown',cooldownUntil:row.expires_at},{status:429,headers:{...headers,'Retry-After':String(Math.ceil((row.expires_at-Date.now())/1000))}});
  }catch{return Response.json({error:'The service is temporarily unavailable. Please try again later.'},{status:503,headers});}
 }
 const t=newTrace();t.beforeQlooRequest=async()=>{
  try{if(!env.DB)throw Error();await reserveQloo(env.DB,visitor.userId);}catch(e){if(e instanceof PublicBudgetError)t.publicQuotaFailure={resetAt:e.resetAt,phase:t.requiredComplete?'explanation':'required'};throw e;}
 };if(action==='checkIntentSignal'){t.limit=1;t.deadline=t.start+35000;}let locked=false;
 if(longActions.has(action)){
  try {
   const db=env.DB;if(!db)throw Error();
   const lock=await db.prepare("INSERT INTO acquired_build_lock(id,request_id,expires_at) VALUES('build',?,?) ON CONFLICT(id) DO UPDATE SET request_id=excluded.request_id,expires_at=excluded.expires_at WHERE acquired_build_lock.expires_at < ? RETURNING request_id").bind(t.id,t.deadline+60000,Date.now()).all();
   if(!lock.results.length)return Response.json({error:'The agent is measuring another route. Please wait for it to finish.'},{status:409,headers});locked=true;
  }catch{return Response.json({error:'The service is temporarily unavailable. Please try again later.'},{status:503,headers});}
 }
 const release=async()=>{if(locked)await env.DB!.prepare("DELETE FROM acquired_build_lock WHERE id='build' AND request_id=?").bind(t.id).run();};
 if(longActions.has(action)&&request.headers.get('accept')?.includes('application/x-ndjson')){
  const encoder=new TextEncoder();let cancelled=false;
  const stream=new ReadableStream({async start(controller){
   const send=(v:unknown)=>{if(!cancelled)controller.enqueue(encoder.encode(JSON.stringify(v)+'\n'));};
   send({event:'started',trace:summary(t)});
   const interval=setInterval(()=>send({event:'progress',trace:summary(t)}),3000);
   try {const result=await execute(action,body.args??{},t,visitor);send({event:'result',...result});}
   catch {send({event:'result',error:'This operation could not finish. Please check your saved routes.',trace:summary(t)});}
   finally {clearInterval(interval);await release().catch(()=>{});if(!cancelled)controller.close();}
  },cancel(){cancelled=true;t.cancelled=true;t.exhausted=true;t.deadline=Date.now();}});
  return new Response(stream,{headers:{...headers,'Content-Type':'application/x-ndjson','X-Content-Type-Options':'nosniff'}});
 }
 try{return Response.json(await execute(action,body.args??{},t,visitor),{headers});}finally{await release();}
}
