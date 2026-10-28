import {visitorFromHeaders,type Visitor} from './public-access.ts';

export const GUEST_COOKIE='__Host-acquired-guest';
export const GUEST_LIFETIME=30*86400;
export type GuestSettings={ownerEmail?:string;guestSecret?:string};
export type SiteVisitor=Visitor&{guest?:boolean};
async function signingKey(secret:string){
 if(secret.length<32)throw Error('Guest access is not configured.');
 return crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const unhex=(text:string)=>Uint8Array.from(text.match(/../g)??[],b=>parseInt(b,16));
export async function guestToken(secret:string,now=Date.now()){
 const id=hex(crypto.getRandomValues(new Uint8Array(32))),expires=Math.floor(now/1000)+GUEST_LIFETIME;
 const payload=`v1.${id}.${expires}`;
 const signature=hex(new Uint8Array(await crypto.subtle.sign('HMAC',await signingKey(secret),new TextEncoder().encode(payload))));
 return {token:`${payload}.${signature}`,visitor:{userId:`guest:${id}`,isOwner:false,guest:true} satisfies SiteVisitor};
}
export async function visitorForRequest(request:Request,settings:GuestSettings,now=Date.now()):Promise<SiteVisitor|null>{
 const account=visitorFromHeaders(request.headers,settings.ownerEmail);if(account)return {...account,guest:false};
 const values=(request.headers.get('cookie')??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(GUEST_COOKIE+'='));
 if(values.length!==1||!settings.guestSecret)return null;
 const token=values[0].slice(GUEST_COOKIE.length+1);
 const match=/^v1\.([a-f0-9]{64})\.(\d{10})\.([a-f0-9]{64})$/.exec(token);if(!match)return null;
 const expires=Number(match[2]),seconds=Math.floor(now/1000);
 if(expires<=seconds||expires>seconds+GUEST_LIFETIME+60)return null;
 const payload=token.slice(0,token.lastIndexOf('.'));
 const valid=await crypto.subtle.verify('HMAC',await signingKey(settings.guestSecret),unhex(match[3]),new TextEncoder().encode(payload));
 return valid?{userId:`guest:${match[1]}`,isOwner:false,guest:true}:null;
}
export function guestCookie(token:string){return `${GUEST_COOKIE}=${token}; Path=/; Max-Age=${GUEST_LIFETIME}; HttpOnly; Secure; SameSite=Lax`;}
export function viewerPayload(visitor:SiteVisitor|null){return visitor?{authenticated:!visitor.guest,visitorReady:true,...visitor}:{authenticated:false,visitorReady:false};}
