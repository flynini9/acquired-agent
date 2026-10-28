export type InputIdentity={id:string;name:string;type:string;image?:string|null;year?:number|null;desc?:string|null;byline?:string|null};
export type IdentityPins={destPinned?:InputIdentity;seedPinned:Record<string,InputIdentity>};
export type IdentityTarget={field:'destination'|'seed';query:string;index?:number};
export function seedQueries(text:string):string[]{return text.split('\n').map(s=>s.trim()).filter(Boolean)}
export function nextIdentity(destination:string,seeds:string,pins:IdentityPins):IdentityTarget|null{
 if(!pins.destPinned)return {field:'destination',query:destination.trim()};
 const queries=seedQueries(seeds),index=queries.findIndex((_,i)=>!pins.seedPinned[String(i)]);
 return index<0?null:{field:'seed',query:queries[index],index};
}
// A pin belongs to the entered name, not to its old position in the textarea.
export function remapSeedPins(before:string,after:string,pins:IdentityPins['seedPinned']):IdentityPins['seedPinned']{
 const available=seedQueries(before).map((query,i)=>({query,pin:pins[String(i)],used:false}));
 const next:IdentityPins['seedPinned']={};
 seedQueries(after).forEach((query,i)=>{const found=available.find(p=>!p.used&&p.query===query&&p.pin);if(found){found.used=true;next[String(i)]=found.pin}});
 return next;
}
export function identitiesReady(destination:string,seeds:string,pins:IdentityPins):boolean{
 return !!destination.trim()&&seedQueries(seeds).length>0&&nextIdentity(destination,seeds,pins)===null;
}
