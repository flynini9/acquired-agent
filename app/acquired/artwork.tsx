'use client';
import {useState} from 'react';
import {artworkSrc} from '@/lib/acquired/artwork';
export function Artwork({name,type,image,entityId,priority=false,className=''}:{name:string;type?:string;image?:string|null;entityId?:string|null;priority?:boolean;className?:string}){
 const src=artworkSrc(image,entityId);
 return <ArtworkFrame key={src??name} src={src} name={name} type={type} priority={priority} className={className}/>;
}
function ArtworkFrame({src,name,type,priority,className}:{src:string|null;name:string;type?:string;priority:boolean;className:string}){
 const [failed,setFailed]=useState(false);
 return <div className={`work-artwork ${className}`} data-medium={type}>
  <div className="artwork-paper" aria-hidden="true"><span className="artwork-orbit"/><span className="artwork-monogram">{name.trim().slice(0,1)}</span><span className="artwork-fallback-label">{failed||!src?"No cover available":'ACQUIRED'}</span></div>
  {src&&!failed&&<img src={src} alt={`${name} artwork`} loading={priority?'eager':'lazy'} decoding="async" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>}
 </div>;
}
