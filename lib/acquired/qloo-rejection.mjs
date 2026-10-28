// Qloo's observed 400 has a precise meaning for this result-type query.
// Never turn an arbitrary HTTP 400, provider outage or malformed body into
// an empty neighborhood. The raw provider body is discarded after checking.
export const rejectionHeader='X-Acquired-Qloo-Rejection';
export function classifyQlooRejection(data){
 if(!data||typeof data!=='object')return null;
 const errors=data.errors;
 if(!Array.isArray(errors)||errors.length!==1)return null;
 const error=errors[0];
 if(!error||typeof error!=='object')return null;
 return error.path==='signal.interests.entities'&&typeof error.message==='string'&&error.message.trim()==='All of the provided signal.interests.entities were invalid. At least one valid signal or filter is required for entity insights.'?'invalid_entity_signals':null;
}
export async function readQlooRejection(response){
 const reader=response.body?.getReader();if(!reader)return null;
 const decoder=new TextDecoder();let text='',size=0;
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();return null;}text+=decoder.decode(value,{stream:true});}
  return classifyQlooRejection(JSON.parse(text+decoder.decode()));
 }catch{return null;}finally{await reader.cancel().catch(()=>{});}
}
