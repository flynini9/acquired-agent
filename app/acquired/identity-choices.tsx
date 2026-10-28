'use client';
import {useEffect,useId,useState} from 'react';
import type {InputIdentity} from '@/lib/acquired/intake-flow';
import {isUnavailable} from '@/lib/acquired/signal-recovery';
import {CatalogDescription} from './catalog-description';
import {Artwork} from './artwork';

const labels:Record<string,string>={book:"Book",movie:"Film",tv_show:"TV show",artist:"Artist",album:"Album",videogame:"Game",video_game:"Game",podcast:"Podcast",author:"Author",person:"Person",place:"Place",brand:"Brand"};

export function IdentityChoices({candidates,busy,unavailable,onPick}:{candidates:InputIdentity[];busy:boolean;unavailable:string[];onPick:(pin:InputIdentity)=>void}){
  const [type,setType]=useState('all'),[visible,setVisible]=useState(6),listId=useId();
  useEffect(()=>{setType('all');setVisible(6)},[candidates]);
  const types=[...new Set(candidates.map(p=>p.type))];
  const filtered=type==='all'?candidates:candidates.filter(p=>p.type===type);
  const select=(next:string)=>{setType(next);setVisible(6)};
  return <div className="identity-choices">
    {candidates.length>0&&<div className="candidate-tools">
      <div className="candidate-filters" role="group" aria-label="Filter by medium">
        {['all',...types].map(t=><button key={t} type="button" disabled={busy} aria-pressed={type===t} aria-controls={listId} onClick={()=>select(t)}>{t==='all'?"All":labels[t]??t}<span>{t==='all'?candidates.length:candidates.filter(p=>p.type===t).length}</span></button>)}
      </div>
      <p className="candidate-count" aria-live="polite">Showing {Math.min(visible,filtered.length)} / {filtered.length} matches</p>
    </div>}
    <div id={listId} className="candidate-list">{filtered.slice(0,visible).map(p=><button key={p.id} disabled={busy||isUnavailable(p.id,unavailable)} className="candidate-card" onClick={()=>onPick(p)}><Artwork name={p.name} type={p.type} image={p.image} entityId={p.id} className="candidate-artwork"/><div className="candidate-copy"><span>{labels[p.type]??p.type}{p.year?' · '+p.year:''}</span><h2>{p.name} <b>↗</b></h2><small>{p.byline}</small><CatalogDescription candidate value={p.desc||"No description is available. Please check the exact version."}/>{isUnavailable(p.id,unavailable)&&<small>The association check did not pass for this entry</small>}</div></button>)}</div>
    {visible<filtered.length&&<button type="button" className="secondary candidate-more" disabled={busy} onClick={()=>setVisible(n=>n+6)}>Show more · {filtered.length-visible} remaining</button>}
  </div>;
}
