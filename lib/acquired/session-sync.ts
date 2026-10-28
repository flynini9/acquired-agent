import type {Walk} from './walk';
export type Draft={version:3;state:Walk;baseData:string};
export function restoreRouteSnapshot(state:Walk,resolved:string|null|undefined):Walk{
 if(typeof state.routeData==='string'&&state.routeData.trim())return state;
 if(!resolved)throw Error('这条路线的记录读不出来，请返回路线列表。');
 let route;try{route=JSON.parse(resolved)}catch{throw Error('这条路线的记录读不出来，请返回路线列表。');}
 if(route?.route_id!==state.routeId||!Array.isArray(route.steps)||!route.steps.length)throw Error('这条路线的记录读不出来，请返回路线列表。');
 return {...state,routeData:resolved};
}
export function readDraft(value:unknown,remoteData:string):{kind:'none'|'recover'|'conflict';state?:Walk}{
 if(!value||typeof value!=='object')return {kind:'none'};
 const d=value as Partial<Draft>,w=d.state;
 let remote:Walk;try{remote=JSON.parse(remoteData)}catch{return {kind:'none'}}
 if(!w||w.schemaVersion!==2||w.routeId!==remote.routeId||!Array.isArray(w.steps)||typeof w.routeData!=='string'||!w.routeData.trim())return {kind:'none'};
 if(JSON.stringify(w)===remoteData)return {kind:'none'};
 return {kind:d.version===3&&d.baseData===remoteData?'recover':'conflict',state:w};
}
export class SessionConflict extends Error{remoteData:string;constructor(remoteData:string){super('另一份进度已更新，两份记录都已保留。');this.remoteData=remoteData;}}
