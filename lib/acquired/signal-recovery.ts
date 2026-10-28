export type SignalReceipt={error_code?:string|null;error_detail?:{signal_entity_ids?:string[]}|null};
export function unavailableIds(result:SignalReceipt|undefined):string[]{
  return result?.error_code==='signal_unavailable'||result?.error_code==='signal_check_rejected'?(result.error_detail?.signal_entity_ids??[]):[];
}
export function isUnavailable(id:string,ids:string[]):boolean{return ids.some(x=>x.toLowerCase()===id.toLowerCase())}
export function needsSignalReview(result:SignalReceipt|undefined):boolean{
  return result?.error_code==='signal_unavailable'||result?.error_code==='measurement_incomplete'||result?.error_code==='signal_check_rejected'||result?.error_code==='query_rejected';
}
