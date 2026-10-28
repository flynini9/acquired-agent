// A local circuit breaker. Its fallback duration is not an assertion about
// Qloo's actual reset window. No retry or provider probe is scheduled.
export function localCooldownUntil(retryAfterSeconds:number|undefined,now=Date.now()){
 const seconds=typeof retryAfterSeconds==='number'&&Number.isFinite(retryAfterSeconds)&&retryAfterSeconds>0?Math.max(60,retryAfterSeconds):60;
 return now+Math.ceil(seconds*1000);
}
export function cooldownMessage(until:number,now=Date.now()){
 return `上次 Qloo 返回了限流，站点正在暂停外呼保护。请至少等 ${Math.max(1,Math.ceil((until-now)/1000))} 秒再操作；这段等待不代表 Qloo 一定恢复。你的输入保留。`;
}
