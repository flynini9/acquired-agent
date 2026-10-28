/** Public Qloo image CDN; never send the Site URL, Secret or free-form input. */
export function artworkSrc(image?:string|null,entityId?:string|null):string|null{
  if(image){try{const u=new URL(image);if(u.protocol==='https:'&&u.hostname==='images.qloo.com'&&!u.port&&!u.username&&!u.password)return u.href;}catch{}}
  // Older saved routes omitted image. The CDN's entity image path is
  // observed in Qloo payloads; a missing image still falls back in the UI.
  return entityId&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entityId)
    ?`https://images.qloo.com/i/${entityId.toUpperCase()}-420x-auto.jpg`:null;
}
