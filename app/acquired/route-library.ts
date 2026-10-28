export type RouteLink={route_id:string;title:string;destination:string};
export type SessionLink={id:number;route_id:string|null;route_title:string|null;finished:boolean;updated_at:string};
export type RouteLibrary={routes:RouteLink[];sessions:SessionLink[]};

// A session is another view of its route, not another route. Titles are never
// identities: different routes may have the same title.
export function uniqueRouteCount(library:RouteLibrary):number{
 const ids=new Set(library.routes.map(r=>'route:'+r.route_id));
 for(const s of library.sessions)ids.add(s.route_id?'route:'+s.route_id:'session:'+s.id);
 return ids.size;
}
type Read=(action:string,args:unknown)=>Promise<{result?:{routes?:RouteLink[];sessions?:SessionLink[];session?:{data:string;route_data?:string|null}|null}}>;
export async function readRouteLibrary(read:Read):Promise<RouteLibrary>{
 const [a,b]=await Promise.all([read('listRoutes',{}),read('listSessions',{})]);
 const sessions=await Promise.all((b.result?.sessions??[]).map(async s=>{
  if(s.route_id)return s;
  // Older summaries may lack an identity. Use their existing saved snapshot;
  // never guess an association by display title or write a migration.
  const row=(await read('getSession',{id:s.id})).result?.session;
  try{const w=JSON.parse(row?.data??'null');if(typeof w?.routeId==='string'&&w.routeId)return {...s,route_id:w.routeId};const route=JSON.parse(w?.routeData??row?.route_data??'null');return typeof route?.route_id==='string'&&route.route_id?{...s,route_id:route.route_id}:s;}catch{return s;}
 }));
 return {routes:a.result?.routes??[],sessions};
}
