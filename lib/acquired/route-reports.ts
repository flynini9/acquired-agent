type Report={signal_id?:string;label:string;detail:string;status:string};
type Meta={motivation_report?:Report[]|null;motivation_history?:{label:string;reports:Report[]}[]};
type QueryMeta={unavailable_query_branches?:unknown;query_branch_policy?:unknown};
export function rerouteQueryCoverage(previous:QueryMeta,tail:QueryMeta,totalSteps:number,offset:number){
 const branches=(meta:QueryMeta)=>Array.isArray(meta.unavailable_query_branches)?meta.unavailable_query_branches.filter((b):b is {hop:number;reason:string}=>!!b&&typeof b==='object'&&Number.isInteger(b.hop)&&b.reason==='invalid_entity_signals'):[];
 const retained=branches(previous).filter(b=>b.hop>=1&&b.hop<totalSteps&&totalSteps-1-b.hop<offset);
 return {query_branch_policy:tail.query_branch_policy??previous.query_branch_policy,unavailable_query_branches:[...retained,...branches(tail)]};
}
export function rerouteMotivationMeta(previous:Meta,tail:Meta,offset:number,sequence:number){
 return {
  motivation_history:[...(previous.motivation_history??[]),{label:`第${sequence}次重修前`,reports:previous.motivation_report??[]}],
  motivation_report:(tail.motivation_report??[]).map(r=>({...r,detail:`本次重修：${r.detail.replace(/第 (\d+) 步/g,(_,n)=>`第 ${Number(n)+offset} 步`)}`})),
 };
}
