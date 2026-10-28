type Identity = { id:string; name:string; type:string };
const normalized = (name:string) => name.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

/** Qloo books can append a bibliographic series position, e.g.
 * "Dune (Dune, #1)". Use the work title for grouping only: preserve
 * the complete catalogue name, ID, type and edition in the choice. */
export function identityTitleKey(candidate: Pick<Identity,'name'|'type'>):string {
  const title = candidate.type === 'book'
    ? candidate.name.replace(/\s*[（(][^()（）]*#\s*\d+(?:\.\d+)?[^()（）]*[)）]\s*$/u, '')
    : candidate.name;
  return normalized(title);
}

/** Keep one representative per matching medium before filling extra
 * versions. Duplicate movie/album entries must not consume every slot. */
export function identityChoices<T extends Identity>(candidates:T[], limit=6):T[] {
  const result:T[]=[], ids=new Set<string>(), types=new Set<string>();
  const add=(candidate:T)=>{result.push(candidate);ids.add(candidate.id.toLowerCase());};
  for(const candidate of candidates){
    if(result.length>=limit)break;
    if(ids.has(candidate.id.toLowerCase())||types.has(candidate.type))continue;
    types.add(candidate.type);add(candidate);
  }
  for(const candidate of candidates){
    if(result.length>=limit)break;
    if(!ids.has(candidate.id.toLowerCase()))add(candidate);
  }
  return result;
}
