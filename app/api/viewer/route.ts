import { env } from 'cloudflare:workers';
import {sameOrigin} from '@/lib/acquired/public-access';
import {visitorForRequest,guestToken,guestCookie,viewerPayload} from '@/lib/acquired/guest-identity';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store','Vary':'Cookie'};
const settings=()=>{const e=env as unknown as Record<string,string>;return {ownerEmail:e.ACQUIRED_OWNER_EMAIL,guestSecret:e.ACQUIRED_GUEST_SECRET};};
export async function GET(request:Request){
 try{return Response.json(viewerPayload(await visitorForRequest(request,settings())),{headers});}
 catch{return Response.json({error:'Visitor access is temporarily unavailable.'},{status:503,headers});}
}
export async function POST(request:Request){
 if(!sameOrigin(request)||!request.headers.get('content-type')?.startsWith('application/json'))return Response.json({error:'ORIGIN_REJECTED'},{status:403,headers});
 try{
  const config=settings(),existing=await visitorForRequest(request,config);
  if(existing)return Response.json(viewerPayload(existing),{headers});
  if(!config.guestSecret)throw Error();
  const created=await guestToken(config.guestSecret);
  return Response.json(viewerPayload(created.visitor),{headers:{...headers,'Set-Cookie':guestCookie(created.token)}});
 }catch{return Response.json({error:'Visitor access is temporarily unavailable.'},{status:503,headers});}
}
