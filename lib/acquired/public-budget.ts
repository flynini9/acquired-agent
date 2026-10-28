export const PUBLIC_LIMITS={qlooPerUserDay:360,qlooGlobalDay:1800,actionsPerUserMinute:90,actionsPerUserDay:300,actionsGlobalDay:3000,sessionPerUserDay:12,sessionGlobalDay:60,sessionsPerUserBeta:20,sessionsGlobalBeta:100,buildsPerUserBeta:20,buildsGlobalBeta:100} as const;
type Database={prepare:(sql:string)=>{bind:(...values:unknown[])=>{first:<T>()=>Promise<T|null>}}};
export class PublicBudgetError extends Error {
 resetAt:number;
 constructor(resetAt:number){super(resetAt===Number.MAX_SAFE_INTEGER?'The public beta has reached its saved-record capacity. Please contact the site owner.':'The public beta has reached its request limit. Please try again after the limit resets.');this.resetAt=resetAt;}
}
async function reserve(db:Database,id:string,limit:number,resetAt:number){
 const row=await db.prepare('INSERT INTO acquired_usage(id,used,expires_at) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET used=acquired_usage.used+1 WHERE acquired_usage.used < ? RETURNING used').bind(id,resetAt,limit).first<{used:number}>();
 if(!row)throw new PublicBudgetError(resetAt);
}
export async function reserveAction(db:Database,userId:string,now=Date.now()){
 const bucket=Math.floor(now/60000),resetAt=(bucket+1)*60000;
 await reserve(db,`action:${userId}:${bucket}`,PUBLIC_LIMITS.actionsPerUserMinute,resetAt);
 const day=Math.floor(now/86400000),dayReset=(day+1)*86400000;
 await reserve(db,`action:day:user:${userId}:${day}`,PUBLIC_LIMITS.actionsPerUserDay,dayReset);
 await reserve(db,`action:day:global:${day}`,PUBLIC_LIMITS.actionsGlobalDay,dayReset);
}
export async function reserveQloo(db:Database,userId:string,now=Date.now()){
 const bucket=Math.floor(now/86400000),resetAt=(bucket+1)*86400000;
 // User first: an exhausted account cannot drain the shared pool. If the
 // global check rejects, retain the user reservation conservatively.
 await reserve(db,`qloo:user:${userId}:${bucket}`,PUBLIC_LIMITS.qlooPerUserDay,resetAt);
 await reserve(db,`qloo:global:${bucket}`,PUBLIC_LIMITS.qlooGlobalDay,resetAt);
}

// Each accepted session is schema-limited to 500k UTF-8 bytes. Finite total
// creation slots bound durable storage, including callers bypassing the UI.
const BETA_END=Number.MAX_SAFE_INTEGER;
export async function reserveSession(db:Database,userId:string,now=Date.now()){
 const day=Math.floor(now/86400000),reset=(day+1)*86400000;
 await reserve(db,`session:day:user:${userId}:${day}`,PUBLIC_LIMITS.sessionPerUserDay,reset);
 await reserve(db,`session:day:global:${day}`,PUBLIC_LIMITS.sessionGlobalDay,reset);
 await reserve(db,`session:beta:user:${userId}`,PUBLIC_LIMITS.sessionsPerUserBeta,BETA_END);
 await reserve(db,'session:beta:global',PUBLIC_LIMITS.sessionsGlobalBeta,BETA_END);
}
export async function reserveBuild(db:Database,userId:string){
 await reserve(db,`build:beta:user:${userId}`,PUBLIC_LIMITS.buildsPerUserBeta,BETA_END);
 await reserve(db,'build:beta:global',PUBLIC_LIMITS.buildsGlobalBeta,BETA_END);
}
