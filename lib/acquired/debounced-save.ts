type Clock={set:(callback:()=>void,delay:number)=>unknown;clear:(handle:unknown)=>void};
type Options<T>={local:(value:T)=>void;save:(value:T)=>Promise<boolean>;failed:(error:unknown)=>void;delay?:number;clock?:Clock};

// Coalesces only unsent edits. The caller retains its existing serialized
// save queue, revision guards, drafts and CAS acknowledgement.
export function createDebouncedSave<T>(options:Options<T>){
 const clock=options.clock??{set:(fn:()=>void,ms:number)=>setTimeout(fn,ms),clear:(id:unknown)=>clearTimeout(id as ReturnType<typeof setTimeout>)};
 let timer:unknown,scheduled=false,pending:{value:T}|null=null,flight:Promise<boolean>|null=null;
 function clearTimer(){if(scheduled)clock.clear(timer);scheduled=false;timer=undefined;}
 function cancel(){clearTimer();pending=null;}
 function flush():Promise<boolean>{
  clearTimer();
  if(!pending)return flight??Promise.resolve(true);
  const {value}=pending;pending=null;
  let request:Promise<boolean>;
  try{request=options.save(value);}catch(error){options.failed(error);return Promise.resolve(false);}
  const result=Promise.resolve(request).catch(error=>{options.failed(error);return false;});
  flight=result;
  void result.then(()=>{if(flight===result)flight=null;});
  return result;
 }
 function schedule(value:T){
  options.local(value);pending={value};clearTimer();scheduled=true;
  timer=clock.set(()=>{scheduled=false;timer=undefined;void flush();},options.delay??700);
 }
 return {schedule,flush,cancel,hasPending:()=>pending!==null};
}
