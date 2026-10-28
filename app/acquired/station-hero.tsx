import {CatalogDescription} from './catalog-description';
import {englishCopy,englishWhy} from '@/lib/acquired/english-copy';
import {identityFor} from '@/lib/acquired/entry-points';
import type {Step} from '@/lib/acquired/walk';
import {Artwork} from './artwork';
import {ExplanationNotice} from './explanation-notice';
const media:Record<string,string>={movie:"Film",tv_show:"TV show",artist:"Artist",book:"Book",podcast:"Podcast",video_game:"Game"};
export function StationHero({step,index,total,swapped=false,connectionNote,reason}:{step:Step;index:number;total:number;swapped?:boolean;connectionNote:string;reason?:string}){
 const identity=identityFor(step);
 return <section className="station-hero" aria-label="The work at this stop">
  <Artwork name={step.name} type={step.type} image={step.image} entityId={step.entity_id} priority className="station-artwork"/>
  <div className="station-story"><div className="step-heading"><p className="eyebrow">Stop {index+1} / {total} · {media[step.type]??step.type}{step.year?` · ${step.year}`:''}{swapped?" · Replaced":''}{step.rerouted?" · Rebuilt from here":''}</p><h1>{step.name}</h1>{identity.creator&&<p className="work-creator">{englishCopy(identity.creator)}</p>}</div></div>
  <details key={step.entity_id} className="step-context"><summary>About this work & its connections <span>↗</span></summary>{identity.summary&&<CatalogDescription className="station-description" value={identity.summary}/>}<div className="agent-note"><span className="spark small" aria-hidden="true">✳</span><div><span>CONNECTIONS THE AGENT FOUND</span><p>{(reason??englishWhy(step))||"No more specific explanation is available. You can inspect the measured connection record."}</p></div></div><p>{connectionNote}</p>{identity.source&&<a href={identity.source} target="_blank" rel="noreferrer">Work information source ↗</a>}</details>
  <ExplanationNotice status={step.why?.explanation_status}/>
 </section>;
}
