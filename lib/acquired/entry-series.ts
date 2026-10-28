/** Local entry-route guard. Affinity is not evidence that a sequel can
 * introduce its own original. Use catalog facts only; never infer a
 * franchise from genre, actors, director, release year or affinity. */
export type EntrySeries = { groups: string[]; description: string };
export type EntryWork = { id?: string; entity_id?: string; name: string; type: string; byline?: string; desc?: string; bio?: string; description?: string; entrySeries?: EntrySeries };
const narrative = new Set(['movie', 'tv_show', 'book', 'videogame', 'video_game']);
const object = (v: unknown): Record<string, unknown> => v != null && typeof v === 'object' ? v as Record<string, unknown> : {};
const text = (v: unknown) => typeof v === 'string' ? v : '';
const norm = (v: string) => v.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const typeOf = (v: string) => v.replace('urn:entity:', '').replace('video_game', 'videogame');

export function catalogEntrySeries(raw: unknown): EntrySeries {
  const entity = object(raw), props = object(entity.properties), groups = new Set<string>();
  const type = text((Array.isArray(entity.types) ? entity.types[0] : null) || entity.subtype || entity.type).replace('urn:entity:', '');
  const bookSeries = type === 'book' ? text(entity.name).match(/[（(]([^()（）]+?)\s*,?\s*#\s*\d+(?:\.\d+)?(?:\s*[-–—]\s*\d+(?:\.\d+)?)?[)）]\s*$/u)?.[1]?.replace(/,\s*$/, '').trim() : null;
  if (bookSeries) groups.add(norm(bookSeries));
  // Read only explicitly labelled series/franchise fields, when present.
  // Taste/genre tags (e.g. Vampire) are deliberately not series evidence.
  for (const key of ['franchise', 'franchises', 'franchise_name', 'film_series', 'book_series', 'series', 'series_name']) {
    const values = Array.isArray(props[key]) ? props[key] as unknown[] : [props[key]];
    for (const value of values) {
      const label = typeof value === 'string' ? value : text(object(value).name);
      if (norm(label).length >= 4) groups.add(norm(label));
    }
  }
  for (const rawTag of Array.isArray(entity.tags) ? entity.tags : []) {
    const tag = object(rawTag), id = text(tag.tag_id) || text(tag.id);
    if (/^urn:tag:(?:franchise|media_franchise|film_series|book_series|tv_series|video_game_series):/i.test(id)) {
      const label = norm(text(tag.name));
      if (label.length >= 4) groups.add(label);
    }
  }
  const descriptions = Array.isArray(props.short_descriptions) ? props.short_descriptions.map(object) : [];
  const english = descriptions.find(d => d.language === 'en') ?? descriptions[0];
  return { groups: [...groups].slice(0, 20), description: (text(props.description) || text(props.short_description) || text(english?.value)).replace(/<[^>]+>/g, ' ').slice(0, 4000) };
}

function titleRoot(name: string): string {
  return norm(name.replace(/^the\s+/i, '')
    .replace(/\s+(?:saga|series)\b.*$/i, '')
    .split(/\s*[:：]\s*/)[0]
    .replace(/\s+(?:(?:part|chapter|episode|volume|vol\.?|book)\s+)?(?:\d+|[ivx]+)\b.*$/i, '')
    .replace(/([\p{Script=Han}])\d+$/u, '$1')
    .replace(/[：:\s]*第[一二三四五六七八九十\d]+[部集卷章].*$/u, ''));
}

function extendsTitle(name: string, base: string): boolean {
  const title = norm(name.replace(/^the\s+/i, '')), root = norm(base.replace(/^the\s+/i, ''));
  if (root.length < 2) return false;
  if (title === root) return false;
  if (!title.startsWith(root + ' ')) return false;
  // A shared word alone is not a series relationship (Twilight Zone).
  const tail = title.slice(root.length).trim();
  return /^(?:saga|series|part|chapter|episode|volume|vol|\d+|[ivx]+)\b/.test(tail)
    || new RegExp('^\\s*(?:the\\s+)?' + escapeRe(base) + '\\s*[:：]', 'i').test(name);
}

function escapeRe(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const workTitle = (name: string) => name.replace(/\s*[（(][^()（）]*#\s*\d+(?:\.\d+)?[^()（）]*[)）]\s*$/u, '').replace(/^the\s+/i, '');
const namesWork = (value: string, name: string) => new RegExp('(?:^| )' + escapeRe(name) + '(?: |$' + (/\p{Script=Han}/u.test(name) ? '|的?(?:导读|解读|解析|指南|手册|研究|评论|幕后|百科)' : '') + ')').test(value);
function companionTitle(title: string, name: string): boolean {
  if (!namesWork(title, name)) return false;
  if (/\p{Script=Han}/u.test(name)) return new RegExp(escapeRe(name) + '的?(?:导读|解读|解析|指南|手册|研究|评论|幕后|百科)').test(title);
  const suffix = new RegExp('(?:^| )' + escapeRe(name) + '(?: series| franchise| novel| book| film| movie)?(?: s)? (?:(?:the|a|an|official|unofficial|illustrated|complete|ultimate|unauthorized|study|survival|readers?) ){0,6}(?:guide|companion|handbook|essays|analysis|criticism|encyclop[ae]+dia|concordance)(?: |$)');
  if (suffix.test(title)) return true;
  const relation = title.match(/\b(?:guide (?:to|for)|companion (?:to|for)|essays (?:on|about)|analysis of|study of|studies of|criticism of|authors? on|making of|art of)\b(.{0,220})/);
  if (!relation) return false;
  const target = new RegExp('(?:^| )' + escapeRe(name) + '(?: |$)').exec(relation[1]);
  const prefix = target ? relation[1].slice(0,target.index).trim() : '';
  return !!target && prefix.split(/\s+/).length <= 8 && !/\b(?:compared|comparison|inspired|unlike|versus|rather|not)\b/.test(prefix);
}

/** Direct work/companion evidence. An essay collection or study guide
 * about the destination already enters that work; it is not a bridge.
 * A shared author, genre or passing mention is deliberately insufficient. */
function destinationContentReason(candidate: EntryWork, destination: EntryWork): string | null {
  const candidateId = candidate.id || candidate.entity_id, destinationId = destination.id || destination.entity_id;
  if (candidateId && destinationId && candidateId.toLowerCase() === destinationId.toLowerCase()) return '目的地本体不能提前作为桥梁';
  const ct = typeOf(candidate.type), dt = typeOf(destination.type);
  if (!narrative.has(ct) || !narrative.has(dt)) return null;
  const cTitle = norm(workTitle(candidate.name)), dTitle = norm(workTitle(destination.name));
  const creator = norm(candidate.byline || ''), targetCreator = norm(destination.byline || '');
  if (ct === dt && cTitle === dTitle && creator && creator === targetCreator) return '标题和创作者相同的目的地版本不能提前作为桥梁';
  // Legacy saved choices may predate series_name extraction. A named
  // multi-book collection with the same author and a multiword target
  // prefix is explicit collection evidence, not a shared-author ban.
  const collection = ct === 'book' && dt === 'book' && creator && creator === targetCreator
    ? cTitle.match(/^(.+?) (?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten) )?(?:books? collection|boxed set|box set|collection set|omnibus)\b/)
    : null;
  if (collection && collection[1].split(' ').length >= 2 && (dTitle === collection[1] || dTitle.startsWith(collection[1] + ' '))) return '标题与创作者标明终点系列的合集';
  const names = [...new Set([dTitle, ...(destination.entrySeries?.groups || []).map(norm)])].filter(n => n.length >= 4 || (n.length >= 2 && /\p{Script=Han}/u.test(n)));
  const title = norm(candidate.name), description = candidate.entrySeries?.description || candidate.desc || candidate.description || candidate.bio || '';
  for (const name of names) {
    // Title explicitly names the target alongside a companion/analysis
    // format. This also covers “Authors on ... Series” without relying
    // on an incomplete franchise tag or publication date.
    if (companionTitle(title, name)) return '标题明确标明围绕目的地的导读、解析或配套作品';
    for (const clause of description.split(/[.;。；]/).map(norm)) {
      // Bound the relation to its named object; a guide about another
      // work that merely compares it to the target must remain available.
      const companion = clause.match(/\b(?:guide to|guide for|companion to|companion for|essays on|essays about|analysis of|study of|studies of|criticism of|making of|art of)\b(.{0,220})/);
      if (companion && new RegExp('^(?:(?:the|a|an|novel|book|film|movie|series|franchise) ){0,5}' + escapeRe(name) + '(?: |$)').test(companion[1].trim())) return '目录简介明确标明围绕目的地的导读、解析或配套作品';
      const adaptation = clause.match(/\b(?:adaptation of|adapted from|based on)\b(.{0,220})/);
      if (adaptation && new RegExp('^(?:(?:the|a|an|\\d{4}|novel|book|film|movie|series|franchise) ){0,5}' + escapeRe(name) + '(?: |$)').test(adaptation[1].trim())) return '目录简介明确标明目的地的改编版本';
    }
  }
  return null;
}

export function entrySeriesReason(candidate: EntryWork, destination: EntryWork): string | null {
  const contentReason = destinationContentReason(candidate, destination);
  if (contentReason) return contentReason;
  const ct = typeOf(candidate.type), dt = typeOf(destination.type);
  if (!narrative.has(ct) || !narrative.has(dt)) return null;
  const candidateGroups = Array.isArray(candidate.entrySeries?.groups) ? candidate.entrySeries.groups : [];
  const destinationGroups = Array.isArray(destination.entrySeries?.groups) ? destination.entrySeries.groups : [];
  const shared = candidateGroups.find(group => destinationGroups.includes(group));
  if (shared) return `目录标明同系列：${shared}`;
  // Avoid classifying an adaptation or soundtrack as a sequel from its title.
  if (ct !== dt) return null;
  const cRoot = titleRoot(candidate.name), dRoot = titleRoot(destination.name);
  const cTitle = norm(candidate.name.replace(/^the\s+/i, '')), dTitle = norm(destination.name.replace(/^the\s+/i, ''));
  if ((cRoot.length >= 2 && cRoot === dRoot && cTitle !== dTitle)
    || extendsTitle(candidate.name, destination.name) || extendsTitle(destination.name, candidate.name)) {
    return '标题明确指向终点同系列';
  }
  const description = candidate.entrySeries?.description || candidate.desc || candidate.description || candidate.bio || '';
  const destinationNames = [destination.name.replace(/^the\s+/i, ''), dRoot].map(norm).filter(n => n.length >= 4);
  // Only explicit sequel/prequel/series wording with the destination's name
  // in that relationship clause. Mere mention/inspiration does not qualify.
  const clauses = description.split(/[.;。；]/).map(norm);
  for (const clause of clauses) {
    const relation = clause.match(/\b(?:sequel to|prequel to|spin off (?:of|from)|installment (?:in|of)|(?:film|movie|book|novel) in)\b(.{0,180})/);
    const namesTarget = relation && destinationNames.some(name =>
      new RegExp('^(?:(?:the|a|an|\\d{4}|s|film|movie|book|novel|television|tv|show|series|franchise) ){0,6}' + escapeRe(name) + '(?: |$)').test(relation[1].trim()));
    if (namesTarget) {
      return '目录简介明确标明终点的续作、前传或同系列作品';
    }
  }
  return null;
}

/** Explicit catalogue series numbering, never release-year sorting. The
 * order concerns reading/entry sequence, not fictional-world chronology. */
function numberedSeries(work: EntryWork): {series:string;position:number;end:number;explicit:boolean} {
  const book = typeOf(work.type) === 'book' && work.name.match(/[（(]([^()（）]+?)\s*,?\s*#\s*(\d+(?:\.\d+)?)(?:\s*[-–—]\s*(\d+(?:\.\d+)?))?[)）]\s*$/u);
  if (book) return {series:norm(book[1].replace(/,\s*$/, '')),position:Number(book[2]),end:Number(book[3]??book[2]),explicit:true};
  const name = work.name.replace(/^the\s+/i, '').trim();
  const suffix = name.match(/^(.+?)[\s:：-]+(?:(?:part|chapter|episode|volume|vol\.?|book)\s+)?(\d{1,2}|[ivx]{1,5}|one|two|three|four|five|six|seven|eight|nine|ten)$/i);
  const chinese = name.match(/^(.+?[\p{Script=Han}])([1-9]\d?)$/u);
  if (chinese) return {series:norm(chinese[1]),position:Number(chinese[2]),end:Number(chinese[2]),explicit:true};
  if (suffix) {
    const token = suffix[2].toLowerCase(), words=['one','two','three','four','five','six','seven','eight','nine','ten'];
    const romans=['i','ii','iii','iv','v','vi','vii','viii','ix','x','xi','xii','xiii','xiv','xv'];
    const position = /^\d+$/.test(token) ? Number(token) : words.indexOf(token)>=0 ? words.indexOf(token)+1 : romans.indexOf(token)+1;
    if (position>0) return {series:norm(suffix[1]),position,end:position,explicit:true};
  }
  return {series:norm(name),position:1,end:1,explicit:false};
}

export function seriesOrderConflict(earlier: EntryWork, later: EntryWork): string|null {
  const type=typeOf(earlier.type);
  if (!narrative.has(type) || type!==typeOf(later.type)) return null;
  const a=numberedSeries(earlier),b=numberedSeries(later);
  if (a.series && a.series===b.series && (a.explicit||b.explicit)) {
    const aRange=a.end>a.position,bRange=b.end>b.position;
    if((aRange||bRange)&&a.position<=b.end&&b.position<=a.end)return `同系列合集《${earlier.name}》与《${later.name}》覆盖卷号重叠，不能作为两站重复推荐`;
    if(a.end>b.position)return `同系列第 ${a.position}${aRange?'–'+a.end:''} 部《${earlier.name}》不能排在第 ${b.position} 部《${later.name}》之前`;
  }
  // Explicitly named sequel dependencies also work when the sequel has a
  // different title. A mere comparison or shared genre is not evidence.
  const target=norm(later.name.replace(/\s*[（(][^()（）]*#\s*\d+(?:\.\d+)?[^()（）]*[)）]\s*$/u, '').replace(/^the\s+/i, ''));
  const description=earlier.entrySeries?.description||earlier.desc||earlier.description||earlier.bio||'';
  if(target.length>=4){
    for(const clause of description.split(/[.;。；]/).map(norm)){
      const relation=clause.match(/\bsequel to\b(.{0,180})/);
      if(relation&&new RegExp('^(?:(?:the|a|an|\\d{4}|s|film|movie|book|novel) ){0,6}'+escapeRe(target)+'(?: |$)').test(relation[1].trim())){
        return `目录明确标明《${earlier.name}》是《${later.name}》的续作，不能排在前作之前`;
      }
    }
  }
  return null;
}

export function routeSeriesConflict(steps: readonly EntryWork[]): {earlier:number;later:number;reason:string}|null {
  for(let i=0;i<steps.length;i++)for(let j=i+1;j<steps.length;j++){
    const reason=seriesOrderConflict(steps[i],steps[j]);
    if(reason)return {earlier:i,later:j,reason};
  }
  return null;
}
