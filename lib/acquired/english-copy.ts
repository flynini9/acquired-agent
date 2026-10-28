import type {Bundle,Step} from './walk';

/** Presentation-only English copy. Persisted metric keys, identifiers, names
 * and the original route evidence are never rewritten. */
const labels:Record<string,string>={
 '熟悉':'Familiarity','陌生':'Unfamiliarity',
 '许愿 / 愿望成真':'Wishes / wishes coming true','太空/宇宙探索':'Space / cosmic exploration','人工智能':'Artificial intelligence','机器人':'Robots','恐龙':'Dinosaurs','吸血鬼':'Vampires','僵尸':'Zombies','末日/废土':'Post-apocalypse / wastelands','赛博朋克':'Cyberpunk','蒸汽朋克':'Steampunk','侦探/推理':'Detectives / deduction','间谍':'Spies','战争':'War','爱情/浪漫':'Love / romance','成长/青春':'Coming of age / youth','复仇':'Revenge','喜剧/搞笑':'Comedy / humor','海盗':'Pirates','西部':'Westerns','音乐/乐队':'Music / bands','舞蹈':'Dance','美食/烹饪':'Food / cooking','旅行':'Travel','神话':'Mythology','历史':'History','传记':'Biography','动物':'Animals','海洋':'Ocean','幽灵/灵异':'Ghosts / the supernatural','梦境':'Dreams','分身/平行世界':'Alternate selves / parallel worlds','循环/轮回':'Loops / recurrence',
 '这份心动暂时测不了':'This interest cannot currently be measured','中间步避开动画':'Avoid animation along the way','中间步避开书':'Avoid books along the way','避开老作品（1990 年前）':'Prefer to avoid older works (before 1990)','偏好近几年（2015 年后）':'Prefer recent works (2015 onward)','篇幅/时间（测不了）':'Length / duration (not measurable)','节奏快慢（测不了）':'Pacing (not measurable)','偏好吓人的（恐怖题材）':'Prefer frightening / horror topics','偏好老作品（1990 年前）':'Prefer older works (before 1990)',

 '好感':'Liking','熟悉度':'Familiarity','理解度':'Understanding','愿意继续':'Willingness to continue','舒适度':'Comfort','新鲜感':'Novelty','吸引力':'Appeal','难度':'Difficulty',
 '中间站避开血腥内容':'Avoid graphic content along the way','中间站避开恐怖题材':'Avoid horror along the way','中间站避开动画':'Avoid animation along the way','中间站避开书籍':'Avoid books along the way','更想看近期作品':'Prefer more recent works','更想看老作品':'Prefer older works',
 '避开血腥内容':'Avoid graphic content','避开恐怖题材':'Avoid horror','避开动画':'Avoid animation','避开书籍':'Avoid books','想看的设定还没说具体':'This interest needs more detail',
 '时间旅行':'Time travel','龙':'Dragons','龙与奇幻':'Dragons and fantasy','家庭':'Family','浪漫':'Romance','友情':'Friendship','魔法':'Magic','冒险':'Adventure','科幻':'Science fiction','悬疑':'Mystery','恐怖':'Horror','奇幻':'Fantasy','超级英雄':'Superheroes','幽默':'Humor','成长':'Coming of age',
 '先听一小段，留意音色和节奏；不用听完整首，再决定愿不愿意继续。':'Listen to a short sample and notice the sound and rhythm. You do not need to finish a whole song before deciding whether to continue.',
 '先尝一小段，留意最吸引或最劝退你的地方；不用看完，再决定愿不愿意继续。':'Try a short sample and notice what draws you in or puts you off. You do not need to finish it before deciding whether to continue.',
 '先看官方预告的一小段，留意“愿望实现”的设定是否仍让你好奇。感到不适就停，不用看完。':'Try a short part of the official trailer. Does the wish-come-true premise still make you curious? Stop if it feels uncomfortable; there is no need to finish.',
 '先看一小段官方预告，留意它怎样把熟悉的陪伴变成不安。':'Try a short part of the official trailer and notice how familiar companionship becomes unsettling.',
 '先核对2016年电影版本，看一小段介绍或预告，留意爱情与不安的混合是否对味。':'Check that this is the 2016 film, then try a short introduction or trailer. See whether its blend of romance and unease appeals to you.',
 '一个愿望成真后，求爱的人开始面对它带来的阴暗代价。':'After a wish comes true, a person seeking love begins to face its dark consequences.',
 '一个能观察、学习的仿真人偶，成为孩子的玩伴与保护者。':'A lifelike doll that can observe and learn becomes a child’s companion and protector.',
 '一段从邂逅开始的爱情，逐渐出现令人不安的转折。这是2016年的卡纳达语电影。':'A romance that begins with an encounter gradually takes unsettling turns. This is the 2016 Kannada-language film.',
 'Curry Barker · 导演':'Curry Barker · Director','Gerard Johnstone · 导演':'Gerard Johnstone · Director','Pawan Wadeyar · 创作者':'Pawan Wadeyar · Creator',
 'Obsession · 官方预告':'Obsession · Official trailer','M3GAN · Universal Pictures 官方预告':'M3GAN · Universal Pictures official trailer',
 '部分媒介的关联暂时不可用，已根据其他实测结果完成选路。':'Associations in some media were unavailable. This route was completed using other measured results.',
 '备选不在这一站':'This alternative does not belong to this stop.','重修结果不符合路线边界':'The rebuilt route did not meet the route boundaries.','重修改变了已走过的路线':'The rebuilt route changed an already visited stop.','这条路线的记录读不出来':'This route record could not be restored.',
};
export function englishCopy(value:string):string{
 if(labels[value])return labels[value];
 if(value.startsWith('避开 '))return 'Avoid '+value.slice(3);
 if(value.endsWith('（搜索页）'))return value.slice(0,-5)+' (search)';
 if(value.endsWith(' · 官网/酒单'))return value.slice(0,-8)+' · Official website / menu';
 return value;
}
export function englishRouteTitle(title:string,destination?:string):string{
 if(title.startsWith('自动路线：'))return 'Route: '+title.slice(5);
 if(/^自动路线[：:]/.test(title))return 'Your route: '+title.replace(/^自动路线[：:]\s*/,'');
 if(/^走向[：: ]?/.test(title))return 'Your way to '+(destination||title.replace(/^走向[：: ]?/,''));
 return title;
}
export function englishConnection(bundle:Bundle,step:Step,next?:Step):string{
 if(!next)return 'Final stop: the work you chose as your destination.';
 const reverse=[step.reverse_link,...(bundle.meta.reverse_links??[])].find(l=>!!l&&l.to_entity_id===step.entity_id&&(l.from_entity_id===next.entity_id||(l.basis==='pack'&&!!next.entity_id&&l.signal_entity_ids?.includes(next.entity_id))));
 if(reverse)return `Using “${reverse.from_name}”${reverse.basis==='pack'?' as a series signal':' as the signal'}, Qloo found “${step.name}”: measured reverse association ${reverse.affinity.toFixed(3)}.`;
 const forward=[step.next_link,...(bundle.meta.forward_links??[])].find(l=>!!l&&l.from_entity_id===step.entity_id&&l.to_entity_id===next.entity_id);
 return forward?`“${step.name}” → “${next.name}”: measured Qloo association ${forward.affinity.toFixed(3)}.`:'The association record for these two stops is incomplete.';
}
export function englishWhy(step:Step,next?:Step):string{
 const why=step.why as (NonNullable<Step['why']>&{seed?:string|null;tags?:string[];pair?:[string,string]|null;kin_affinity?:number|null})|undefined;
 if(!why)return 'No more specific supporting explanation is available.';
 const l=why.routing_link;
 const current=l&&l.to_entity_id===step.entity_id&&next&&(l.from_entity_id===next.entity_id||(l.basis==='pack'&&!!next.entity_id&&l.signal_entity_ids?.includes(next.entity_id)));
 // Same stale-neighbor cleanup as explanationText, including English records.
 if(why.text&&!/[\u3400-\u9fff]/.test(why.text))return l&&!current&&why.routing_text?why.text.replace(why.routing_text,''):why.text;
 const facts:string[]=[];
 const affinity=(step as Step&{aff_from_seeds?:number|null}).aff_from_seeds;
 if(typeof affinity==='number'&&Number.isFinite(affinity))facts.push(`Measured association with your familiar favorites: ${affinity.toFixed(3)}.`);
 if(why.seed&&why.tags?.length)facts.push(`Qloo measured an association with your favorite “${why.seed}”. Shared taste tags: ${why.tags.join(', ')}.`);
 else if(why.seed)facts.push(`Qloo measured an association with your favorite “${why.seed}”.`);
 if(why.pair&&typeof why.kin_affinity==='number')facts.push(`The tags “${why.pair[0]}” and “${why.pair[1]}” have a measured Qloo tag relationship of ${why.kin_affinity.toFixed(2)}.`);
 if(l&&l.to_entity_id===step.entity_id&&next&&(l.from_entity_id===next.entity_id||(l.basis==='pack'&&!!next.entity_id&&l.signal_entity_ids?.includes(next.entity_id))))facts.push(`To move toward “${l.from_name}”${l.basis==='pack'?' as a series':''}, the agent used it as the signal to find this stop (reverse association ${l.affinity.toFixed(3)}).`);
 return facts.join(' ')||'The original supporting note is retained in your route file. See the measured connection record below.';
}
export function englishReport(detail:string,status:string,kind:'constraint'|'motivation'='constraint'):string{
 if(!/[\u3400-\u9fff]/.test(detail))return detail;
 if(kind==='motivation')return status==='applied_changed'?'This interest participated in comparing candidates and changed the selection.':status==='applied_no_change'?'This interest participated in comparing candidates; the route did not change.':'This interest did not guide selection in this attempt. The original note is retained in your route file.';
 return status==='applied'?'This preference was applied when comparing or filtering candidates.':status==='no_effect'?'This preference did not change the selected route in this attempt.':'This preference could not be applied. The original note is retained in your route file.';
}
export function englishRerouteLog(line:string,index:number):string{return /[\u3400-\u9fff]/.test(line)?`Route rebuild ${index+1}. Earlier progress was retained; the destination stayed the same.`:line}
