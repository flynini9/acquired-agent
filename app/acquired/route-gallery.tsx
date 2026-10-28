'use client';
import {CatalogDescription} from './catalog-description';
import {englishCopy,englishConnection,englishWhy} from '@/lib/acquired/english-copy';
import {identityFor} from '@/lib/acquired/entry-points';
import {useEffect,useId,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import type {Bundle} from '@/lib/acquired/walk';
import {Artwork} from './artwork';
import {ExplanationNotice} from './explanation-notice';
import {QueryCoverageNotice} from './query-coverage-notice';
const media:Record<string,string>={movie:"Film",tv_show:"TV show",artist:"Artist",book:"Book",podcast:"Podcast",video_game:"Game"};
type Props={bundle:Bundle;disabled:boolean;onBegin:()=>void;onExport:()=>void;notes?:ReactNode};
export function RouteGallery(props:Props){return <GalleryContent key={props.bundle.route_id} {...props}/>}
function GalleryContent({bundle,disabled,onBegin,onExport,notes}:Props){
 const [selected,setSelected]=useState(0),pointer=useRef<{x:number;y:number}|null>(null),detailId=useId(),swiped=useRef(false);
 const [compact,setCompact]=useState(false),[mobileView,setMobileView]=useState<'covers'|'details'>('covers');
 const corridorId=useId(),infoId=useId(),coversTabId=useId(),detailsTabId=useId(),tabs=useRef<Array<HTMLButtonElement|null>>([]),infoScroll=useRef<HTMLDivElement|null>(null);
 useEffect(()=>{const media=window.matchMedia('(max-width:800px)'),update=()=>setCompact(media.matches);update();media.addEventListener('change',update);return()=>media.removeEventListener('change',update)},[]);
 useEffect(()=>{infoScroll.current?.scrollTo({top:0,behavior:'instant'})},[selected]);
 function switchTab(index:number){setMobileView(index===0?'covers':'details');tabs.current[index]?.focus()}
 const step=bundle.steps[selected],first=bundle.steps[0];
 if(!step)return null;
 function select(index:number){if(!disabled)setSelected(Math.max(0,Math.min(bundle.steps.length-1,index)))}
 return <section className="route-preview gallery-preview">
  <header className="route-summary"><div className="route-summary-copy"><div className="route-summary-line"><h1>Your way to <em>{bundle.meta.destination}</em></h1><span className="route-step-count">{bundle.steps.length} stops</span><span className="route-saved" role="status">✓ Saved</span></div><p>{compact&&mobileView==='details'?"Switch to the cover gallery to preview another stop.":"Choose a cover or swipe to see what is waiting along the way."}</p></div><button className="primary" disabled={disabled} onClick={onBegin}>Begin at the first stop <span>↗</span></button></header>
  <div className="gallery-view-tabs" role="tablist" aria-label="Route preview" hidden={!compact} onKeyDown={e=>{const index=mobileView==='covers'?0:1;if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();switchTab(1-index)}if(e.key==='Home'){e.preventDefault();switchTab(0)}if(e.key==='End'){e.preventDefault();switchTab(1)}}}>
   <button ref={el=>{tabs.current[0]=el}} id={coversTabId} role="tab" disabled={disabled} aria-selected={mobileView==='covers'} aria-controls={corridorId} tabIndex={mobileView==='covers'?0:-1} onClick={()=>setMobileView('covers')}>Cover gallery</button>
   <button ref={el=>{tabs.current[1]=el}} id={detailsTabId} role="tab" disabled={disabled} aria-selected={mobileView==='details'} aria-controls={infoId} tabIndex={mobileView==='details'?0:-1} onClick={()=>setMobileView('details')}>Works & evidence</button>
  </div>
  <div className="gallery-workspace">
  <div className="corridor" id={corridorId} role={compact?'tabpanel':'region'} aria-labelledby={compact?coversTabId:undefined} aria-label="Work gallery" hidden={compact&&mobileView!=='covers'} tabIndex={0} onKeyDown={e=>{if(e.target!==e.currentTarget)return;if(e.key==='ArrowRight'){e.preventDefault();select(selected+1)}if(e.key==='ArrowLeft'){e.preventDefault();select(selected-1)}if(e.key==='Home'){e.preventDefault();select(0)}if(e.key==='End'){e.preventDefault();select(bundle.steps.length-1)}}} onPointerDown={e=>{swiped.current=false;pointer.current={x:e.clientX,y:e.clientY}}} onPointerUp={e=>{const p=pointer.current;pointer.current=null;if(p&&Math.abs(e.clientX-p.x)>45&&Math.abs(e.clientX-p.x)>Math.abs(e.clientY-p.y)*1.3){swiped.current=true;select(selected+(e.clientX<p.x?1:-1))}}} onPointerCancel={()=>{pointer.current=null}}>
   <div className="corridor-horizon" aria-hidden="true"/>
   <div className="corridor-topline"><span>YOUR WAY IN</span><span>{String(selected+1).padStart(2,'0')} / {String(bundle.steps.length).padStart(2,'0')}</span></div>
   <ol className="corridor-posters" onDragStart={e=>e.preventDefault()} aria-label={`${bundle.steps.length}-stop route`}>{bundle.steps.map((s,index)=>{const d=index-selected,far=Math.abs(d)>2;return <li key={`${s.entity_id??s.name}-${index}`} className={'corridor-stop'+(d===0?' is-current':'')} style={{'--offset':d,'--distance':Math.abs(d),'--depth':-Math.abs(d)*80,'--turn':d===0?'0deg':`${d<0?24:-24}deg`,zIndex:10-Math.abs(d),visibility:far?'hidden':'visible'} as CSSProperties}>
    <button className="corridor-card" disabled={disabled} tabIndex={far?-1:0} aria-pressed={d===0} aria-controls={detailId} aria-label={`Preview stop ${index+1}: ${s.name}`} onClick={e=>{if(e.detail===0||!swiped.current)select(index)}}><Artwork name={s.name} type={s.type} image={s.image} entityId={s.entity_id} priority={Math.abs(d)<2}/><span className="corridor-card-label"><b>{String(index+1).padStart(2,'0')}</b><span>{s.name}</span></span></button>
   </li>})}</ol>
   <div className="corridor-controls"><button className="corridor-arrow" disabled={disabled||selected===0} aria-label="Preview previous stop" onClick={()=>select(selected-1)}>←</button><div className="corridor-dots" aria-label="Choose a stop to preview">{bundle.steps.map((s,k)=><button key={k} disabled={disabled} aria-label={`Choose stop ${k+1}: ${s.name}`} aria-pressed={k===selected} onClick={()=>select(k)}><span>{String(k+1).padStart(2,'0')}</span></button>)}</div><button className="corridor-arrow" disabled={disabled||selected===bundle.steps.length-1} aria-label="Preview next stop" onClick={()=>select(selected+1)}>→</button></div>
  </div>
  <aside className="gallery-info" id={infoId} role={compact?'tabpanel':undefined} aria-labelledby={compact?detailsTabId:undefined} aria-label="Works & evidence" hidden={compact&&mobileView!=='details'}>
  <div className="gallery-info-scroll" ref={infoScroll} tabIndex={0} aria-label="Work details, evidence and preferences">
  <article className="corridor-detail" id={detailId}><div className="corridor-detail-title"><p className="eyebrow" aria-live="polite">Preview stop {selected+1} · {selected===bundle.steps.length-1?"Destination":media[step.type]??step.type}{step.year?` · ${step.year}`:''}</p><h2>{step.name}</h2>{identityFor(step).creator&&<p className="work-creator">{englishCopy(identityFor(step).creator)}</p>}</div><div><CatalogDescription className="corridor-description" value={identityFor(step).summary||"Try a little, then decide whether you want to continue."}/><details key={`${selected}-${step.entity_id}`} className="poster-evidence"><summary><span>✳</span> Why this step? <b>＋</b></summary><p>{englishWhy(step,bundle.steps[selected+1])||"No more specific supporting explanation is available."}</p><p className="muted">{englishConnection(bundle,step,bundle.steps[selected+1])}</p>{identityFor(step).source&&<a href={identityFor(step).source} target="_blank" rel="noreferrer">Work information source ↗</a>}</details><ExplanationNotice status={step.why?.explanation_status==='complete'?bundle.meta.explanation_status:step.why?.explanation_status??bundle.meta.explanation_status}/></div></article>
  <QueryCoverageNotice bundle={bundle}/>
  <details className="gallery-conditions"><summary>Preferences for this route <span>＋</span></summary><div className="gallery-conditions-body">{notes}</div></details>
  </div>
  <div className="gallery-panel-actions"><p>{first?`Begin with “${first.name}”. Previewing does not change the order of your journey.`:"Try a little. Then decide."}</p><button className="text-button" disabled={disabled} onClick={onExport}>Download route ↗</button></div>
  </aside>
  </div>
 </section>;
}
