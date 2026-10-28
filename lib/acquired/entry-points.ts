import type {Step,Item} from './walk';
type Entry={summary:string;creator:string;source:string;checked:string;link?:Item;task:string};
// Editorial metadata is keyed by the exact Qloo identity, never by title alone.
const entries:Record<string,Entry>={
 '5BF04DFD-4D46-4878-B396-AC7F9071690E':{
  summary:'一个愿望成真后，求爱的人开始面对它带来的阴暗代价。',creator:'Curry Barker · 导演',source:'https://www.focusfeatures.com/video/obsession-official-trailer',checked:'2026-10-25',
  link:{title:'Obsession · 官方预告',url:'https://www.focusfeatures.com/video/obsession-official-trailer',pinned:true,kind:'watch'},
  task:'先看官方预告的一小段，留意“愿望实现”的设定是否仍让你好奇。感到不适就停，不用看完。'
 },
 '5AB677F2-830C-4CCD-A2D0-8B8BEA4D5FC0':{
  summary:'一个能观察、学习的仿真人偶，成为孩子的玩伴与保护者。',creator:'Gerard Johnstone · 导演',source:'https://www.blumhouse.com/film/m3gan',checked:'2026-10-25',
  link:{title:'M3GAN · Universal Pictures 官方预告',url:'https://www.youtube.com/watch?v=BRb4U99OU80',pinned:true,kind:'watch'},
  task:'先看一小段官方预告，留意它怎样把熟悉的陪伴变成不安。'
 },
 '03A4150A-6286-4963-BFE8-924313C3F2E9':{
  summary:'一段从邂逅开始的爱情，逐渐出现令人不安的转折。这是2016年的卡纳达语电影。',creator:'Pawan Wadeyar · 创作者',source:'https://tv.apple.com/gb/movie/jessie/umc.cmc.i2ybehfbrzbcqq0egdfo9y6t',checked:'2026-10-25',
  task:'先核对2016年电影版本，看一小段介绍或预告，留意爱情与不安的混合是否对味。'
 }
};
export function entryFor(step:Step):Entry|undefined{return step.entity_id?entries[step.entity_id.toUpperCase()]:undefined;}
export function identityFor(step:Step){const entry=entryFor(step);return {summary:entry?.summary||step.bio||step.description||'',creator:entry?.creator||step.byline||'',source:entry?.source,checked:entry?.checked};}
export function tasteItems(step:Step):Item[]{const link=entryFor(step)?.link;return link?step.tracks.map((item,i)=>i===0?link:item):step.tracks;}
export function tasteTask(step:Step):string{return entryFor(step)?.task||(step.type==='artist'?'先听一小段，留意音色和节奏；不用听完整首，再决定愿不愿意继续。':'先尝一小段，留意最吸引或最劝退你的地方；不用看完，再决定愿不愿意继续。');}
