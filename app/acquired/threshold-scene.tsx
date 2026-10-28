'use client';
import {useId,useRef} from 'react';
/** A small, native scene: no WebGL download or loading gate before the form. */
export function ThresholdScene(){
 const id=useId().replace(/:/g,''),ref=useRef<HTMLDivElement>(null);
 const g=(name:string)=>`${id}-${name}`;
 return <div className="threshold-scene" ref={ref} aria-hidden="true" onPointerMove={e=>{if(e.pointerType!=='mouse')return;const r=e.currentTarget.getBoundingClientRect();ref.current?.style.setProperty('--scene-x',`${((e.clientX-r.left)/r.width-.5)*8}deg`);ref.current?.style.setProperty('--scene-y',`${((e.clientY-r.top)/r.height-.5)*-5}deg`);}} onPointerLeave={()=>{ref.current?.style.setProperty('--scene-x','0deg');ref.current?.style.setProperty('--scene-y','0deg');}}>
 <div className="threshold-caption"><span>A SMALL WAY IN</span><span>01 — ∞</span></div>
 <svg className="threshold-landscape" viewBox="0 0 600 640" fill="none">
 <defs>
  <linearGradient id={g('sky')} x1="300" y1="0" x2="300" y2="640" gradientUnits="userSpaceOnUse"><stop stopColor="#e5ddf7"/><stop offset=".52" stopColor="#efeafa"/><stop offset="1" stopColor="#d6c9eb"/></linearGradient>
  <linearGradient id={g('water')} x1="300" y1="350" x2="300" y2="640" gradientUnits="userSpaceOnUse"><stop stopColor="#c5b4de"/><stop offset="1" stopColor="#e9e0f4"/></linearGradient>
  <linearGradient id={g('inside')} x1="230" y1="140" x2="375" y2="360" gradientUnits="userSpaceOnUse"><stop stopColor="#ede6ff"/><stop offset=".55" stopColor="#fffaff"/><stop offset="1" stopColor="#cfb9f1"/></linearGradient>
  <linearGradient id={g('path')} x1="300" y1="350" x2="300" y2="600" gradientUnits="userSpaceOnUse"><stop stopColor="#fff7ed" stopOpacity=".8"/><stop offset="1" stopColor="#fff9f0" stopOpacity="0"/></linearGradient>
  <linearGradient id={g('edge')} x1="220" y1="160" x2="380" y2="355" gradientUnits="userSpaceOnUse"><stop stopColor="#fff"/><stop offset=".45" stopColor="#f8e8ff"/><stop offset="1" stopColor="#9a76c7"/></linearGradient>
  <filter id={g('blur')} x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="20"/></filter>
  <filter id={g('glow')} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5"/></filter>
  <clipPath id={g('clip')}><rect width="600" height="640" rx="230"/></clipPath>
 </defs>
 <g clipPath={`url(#${g('clip')})`}>
 <rect width="600" height="640" fill={`url(#${g('sky')})`}/>
 <circle cx="377" cy="166" r="91" fill="#f9eeff" filter={`url(#${g('blur')})`}/>
 <path d="M0 324Q85 264 149 304T300 302T452 284T600 324V410H0Z" fill="#cbbce0"/>
 <path d="M0 353Q89 310 172 343T354 330T600 347V421H0Z" fill="#ae96cd"/>
 <path d="M0 369Q129 346 247 370T442 362T600 372V640H0Z" fill={`url(#${g('water')})`}/>
 <path d="M247 358L145 628H471L355 358Z" fill={`url(#${g('path')})`}/>
 <g className="portal-breath">
 <path d="M220 357V217C220 103 380 103 380 217V357" stroke="#eedbff" strokeWidth="18" filter={`url(#${g('glow')})`}/>
 <path d="M212 357V215C212 94 388 94 388 215V357L380 363H220Z" fill="#b09bc7"/>
 <path d="M228 357V216C228 112 372 112 372 216V357Z" fill={`url(#${g('inside')})`}/>
 <path d="M220 357V217C220 103 380 103 380 217V357" stroke={`url(#${g('edge')})`} strokeWidth="4"/>
 <path d="M236 355V220C236 125 364 125 364 220V355" stroke="#fff" strokeOpacity=".65"/>
 <path d="M222 359H379" stroke="#fff6f1" strokeWidth="4"/>
 </g>
 <g stroke="#fff" strokeOpacity=".4"><ellipse cx="300" cy="377" rx="112" ry="5"/><ellipse cx="301" cy="406" rx="137" ry="7"/><ellipse className="portal-ripple" cx="300" cy="448" rx="169" ry="9"/><path d="M59 493Q300 509 541 491M90 552Q301 573 512 552"/></g>
 <g fill="#9672bf" fillOpacity=".43"><ellipse cx="300" cy="400" rx="15" ry="3"/><ellipse cx="294" cy="432" rx="21" ry="4"/><ellipse cx="311" cy="474" rx="29" ry="5"/><ellipse cx="293" cy="527" rx="37" ry="6"/></g>
 <path d="M0 529Q50 497 97 535L147 640H0Z" fill="#a18bbb" fillOpacity=".46"/>
 <path d="M600 520Q550 505 508 542L475 640H600Z" fill="#987eb6" fillOpacity=".42"/>
 <g className="threshold-motes" fill="#fff"><circle cx="182" cy="207" r="2"/><circle cx="414" cy="281" r="2.4"/><circle cx="166" cy="323" r="1.5"/><circle cx="404" cy="129" r="1.7"/><circle cx="269" cy="93" r="1.4"/><circle cx="327" cy="258" r="2"/><circle cx="288" cy="296" r="1.6"/></g>
 </g></svg>
 <div className="threshold-bottom"><span>A little familiar.</span><i/><em>A little unexpected.</em></div>
 </div>;
}
