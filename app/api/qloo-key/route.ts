import { env } from 'cloudflare:workers';
import {visitorFromHeaders} from '@/lib/acquired/public-access';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'X-Lab-Revision': 'lab-2' };
function readKey() { return (env as unknown as Record<string,string>).QLOO_API_KEY; }
// No live probe is exposed, including to signed-in visitors.
export async function GET(request:Request) {
  if(!visitorFromHeaders(request.headers,(env as unknown as Record<string,string>).ACQUIRED_OWNER_EMAIL))return Response.json({error:'Not found'},{status:404,headers});
  return Response.json({ configured: Boolean(readKey()?.trim()), upstreamRequests: 0 }, { headers });
}
