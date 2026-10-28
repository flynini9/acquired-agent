import type {Bundle,Step} from './walk';
export function queryCoverageNotice(bundle:Bundle):string|null{
 return bundle.meta.unavailable_query_branches?.some(branch=>branch.reason==='invalid_entity_signals')
  ?'部分媒介的关联暂时不可用，已根据其他实测结果完成选路。':null;
}
export function connectionText(bundle:Bundle,step:Step,next?:Step):string{
 if(!next)return '终点站：你想走进的作品本体。';
 const reverse=[step.reverse_link,...(bundle.meta.reverse_links??[])].find(l=>!!l&&l.to_entity_id===step.entity_id&&(l.from_entity_id===next.entity_id||(l.basis==='pack'&&!!next.entity_id&&l.signal_entity_ids?.includes(next.entity_id))));
 if(reverse)return `以《${reverse.from_name}》${reverse.basis==='pack'?'系列':''}为信号找到《${step.name}》，关联 ${reverse.affinity.toFixed(3)}（Qloo倒推实测）`;
 const forward=[step.next_link,...(bundle.meta.forward_links??[])].find(l=>!!l&&l.from_entity_id===step.entity_id&&l?.to_entity_id===next.entity_id);
 return forward?`从《${step.name}》→《${next.name}》关联 ${forward.affinity.toFixed(3)}（Qloo实测）`:'这两站的关联记录暂未补齐。';
}

// A swap/reroute can change the next station. Do not narrate the former
// neighbor as the current connection; keep independent taste/motive facts.
export function explanationText(step:Step,next?:Step):string {
 const why=step.why;if(!why)return '';
 const l=why.routing_link;
 const current=l&&l.to_entity_id===step.entity_id&&next&&(l.from_entity_id===next.entity_id||(l.basis==='pack'&&!!next.entity_id&&l.signal_entity_ids?.includes(next.entity_id)));
 return l&&!current&&why.routing_text?why.text.replace(why.routing_text,''):why.text;
}
