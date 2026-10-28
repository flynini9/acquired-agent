// Sites dispatch supplies and sanitizes these identity headers. A service
// access token is not a visitor identity and cannot access personal data.
export type Visitor = { userId: string; isOwner: boolean };
export function visitorFromHeaders(headers: Headers, ownerEmail?: string): Visitor | null {
 const userId=headers.get('oai-authenticated-user-id')?.trim(),email=headers.get('oai-authenticated-user-email')?.trim();
 if(!userId||!email||userId.length>256||email.length>320)return null;
 return {userId,isOwner:Boolean(ownerEmail&&email.toLowerCase()===ownerEmail.trim().toLowerCase())};
}
export function sameOrigin(request: Request) {const origin=request.headers.get('origin');return !origin||origin===new URL(request.url).origin;}
export async function limitedJson(request: Request, maximum=1_600_000): Promise<Record<string, unknown>> {
 if(Number(request.headers.get('content-length')??0)>maximum)throw Error('INPUT_TOO_LARGE');
 const reader=request.body?.getReader();if(!reader)throw Error('INVALID_INPUT');
 const chunks:Uint8Array[]=[];let length=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>maximum){await reader.cancel();throw Error('INPUT_TOO_LARGE');}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 const result:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 if(!result||typeof result!=='object'||Array.isArray(result))throw Error('INVALID_INPUT');
 return result as Record<string,unknown>;
}
