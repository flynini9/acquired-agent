export type Constraint={id:string;label:string;kind?:string;hard:boolean;excerpt:string;source?:string;conflict?:{status:string;evidence:string}|null;needsDestinationCheck?:boolean};
export type Signal={id:string;label:string;source:string;tagId:string|null;status:'ready'|'pending'|'unhandled';excerpt:string;supplement?:{field:string;examples:string[]}|null};
export type TagOption={concept:string;tagId:string;tagName:string;pending:boolean};
export type ManualConstraint={entryId:string;kind:string;tagId?:string;label:string};
export type Intent={motivationDeferred?:boolean;constraints:Constraint[];constraintIds:string[];signals:Signal[];selectedMotivationIds:string[];manualConstraints:ManualConstraint[];manualMotivationSignals:{label:string;tagId:string}[];confirmedConflictIds:string[];disabledConflictIds:string[];destinationId:string|null;checkStatus?:Record<string,string>};
export const manualKinds=[['avoid_gore','中间站避开血腥内容'],['avoid_horror','中间站避开恐怖题材'],['avoid_anime','中间站避开动画'],['avoid_book','中间站避开书籍'],['prefer_recent','更想看近期作品'],['prefer_old','更想看老作品']] as const;
export function emptyIntent():Intent{return{constraints:[],constraintIds:[],signals:[],selectedMotivationIds:[],manualConstraints:[],manualMotivationSignals:[],confirmedConflictIds:[],disabledConflictIds:[],destinationId:null}}
export function acceptIntent(parsed:{constraints:Constraint[];motivationSignals:Signal[];check_status?:Record<string,string>},destinationId:string|null,previous?:Intent):Intent{
 const base=previous??emptyIntent();
 const sameDestination=!!previous&&previous.destinationId===destinationId;
 return{...base,constraints:parsed.constraints,signals:parsed.motivationSignals,destinationId,checkStatus:parsed.check_status,
  constraintIds:parsed.constraints.filter(c=>!previous||!previous.constraints.some(p=>p.id===c.id)||previous.constraintIds.includes(c.id)).map(c=>c.id),
  selectedMotivationIds:parsed.motivationSignals.filter(s=>s.tagId!==null||s.id.startsWith('mot:pref_')).filter(s=>previous?.signals.some(p=>p.id===s.id)?previous.selectedMotivationIds.includes(s.id):s.status==='ready').map(s=>s.id),
  confirmedConflictIds:sameDestination?base.confirmedConflictIds:[],disabledConflictIds:sameDestination?base.disabledConflictIds:[]};
}
export function intentArgs(i:Intent){
 const prefIds=i.constraints.filter(c=>c.source==='motivation'&&c.kind?.startsWith('prefer_')).filter(c=>i.selectedMotivationIds.includes('mot:pref_'+c.kind!.slice(7))).map(c=>c.id);
 return{requireMotivationDecision:true,motivationDeferred:i.motivationDeferred===true&&i.selectedMotivationIds.length===0&&i.manualMotivationSignals.length===0,constraintIds:[...i.constraintIds.filter(id=>!i.constraints.some(c=>c.id===id&&c.source==='motivation')),...prefIds],selectedMotivationIds:i.selectedMotivationIds.filter(id=>i.signals.some(s=>s.id===id&&(s.tagId!==null||id.startsWith('mot:pref_')))),manualConstraints:i.manualConstraints,manualMotivationSignals:i.manualMotivationSignals,confirmedConflictIds:i.confirmedConflictIds,disabledConflictIds:i.disabledConflictIds};
}
export function setConflict(i:Intent,id:string,enabled:boolean):Intent{return{...i,confirmedConflictIds:[...i.confirmedConflictIds.filter(x=>x!==id),...(enabled?[id]:[])],disabledConflictIds:[...i.disabledConflictIds.filter(x=>x!==id),...(!enabled?[id]:[])]}}
export function unresolvedConflicts(i:Intent){return i.constraints.filter(c=>c.conflict&&i.constraintIds.includes(c.id)&&!i.confirmedConflictIds.includes(c.id)&&!i.disabledConflictIds.includes(c.id))}

export function needsMotivationDetail(i:Intent){return !i.motivationDeferred&&i.signals.some(s=>s.source==='pending_supplement')&&i.selectedMotivationIds.length===0&&i.manualMotivationSignals.length===0}
