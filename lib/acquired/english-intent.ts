// Bounded English equivalents of the existing verified concepts. Pending
// Chinese mappings remain pending; these aliases do not invent new tags.
export const englishConceptAliases:Record<string,string[]>={
 wish:['wish granting','wish fulfillment','wish-fulfillment','wishes come true'],
 'time-travel':['time travel','time-travel'],'outer-space':['outer space','space exploration'],
 'artificial-intelligence':['artificial intelligence','AI'],robots:['robot','robots'],magic:['magic','wizards'],
 dinosaurs:['dinosaur','dinosaurs'],dragons:['dragon','dragons'],vampires:['vampire','vampires'],zombies:['zombie','zombies'],
 'post-apocalypse':['post-apocalypse','post-apocalyptic','apocalypse','wasteland'],cyberpunk:['cyberpunk'],steampunk:['steampunk'],
 superheroes:['superhero','superheroes'],detective:['detective','detectives'],spies:['spy','spies','espionage'],war:['war','military'],
 love:['romance','romantic'],family:['family bonds','family'], 'coming-of-age':['coming of age','coming-of-age'],revenge:['revenge'],
 adventure:['adventure'],comedy:['comedy','humor','humour'],mystery:['mystery','mysteries','suspense'],pirates:['pirate','pirates'],
 western:['western','westerns'],music:['band','bands','music'],dance:['dance','dancing'],culinary:['culinary','cooking','food'],
 travel:['travel','voyage'],mythology:['mythology','mythical creatures'],history:['history','historical','period drama'],biography:['biography','biopic'],
 ocean:['ocean','sea','underwater'],ghosts:['ghost','ghosts'],dreams:['dream','dreams','dreamscapes'],
 multiverse:['multiverse','parallel universe','parallel worlds'],'time-loop':['time loop','time-loop'],
};
export function englishKeywordIndex(text:string,word:string){
 const low=text.toLowerCase(),needle=word.toLowerCase();let from=0;
 while(from<low.length){const i=low.indexOf(needle,from);if(i<0)return -1;
  if(!/[a-z0-9]/i.test(low[i-1]??'')&&!/[a-z0-9]/i.test(low[i+needle.length]??''))return i;from=i+needle.length;
 }return -1;
}
function clauses(text:string){return text.replace(/[’]/g,"'").split(/[,.;!?，。；！？]|\b(?:but|however|although|yet)\b/i).map(x=>x.trim()).filter(Boolean);}

/** Bind an avoidance/interest cue to the topic that follows it. A cue
 * belonging to a later topic cannot negate an earlier positive mention.
 * Only a clear new affirmative predicate resets a carried negative list. */
function negativeBeforeTopic(before:string):boolean{
 const text=before.replace(/[’]/g,"'");
 type Cue={start:number;end:number;negative:boolean};
 const cues:Cue[]=[];
 const neutral=/\b(?:not (?:afraid|scared) of|(?:do not|don't) (?:mind|dislike|hate|avoid|skip)|(?:do not|don't) (?:want|need) to (?:avoid|skip)|no (?:need|reason) to (?:avoid|skip)|no (?:problems?|issues?|trouble|difficulty) (?:with|watching|reading))\b/gi;
 for(const m of text.matchAll(neutral))cues.push({start:m.index,end:m.index+m[0].length,negative:false});
 const overlap=(start:number,end:number)=>cues.some(c=>start<c.end&&end>c.start);
 const negative=/\b(?:not interested in|not curious about|not into|avoid|skip|without|dislike|hate|afraid of|scared of|can't (?:handle|stand|watch|read)|cannot (?:handle|stand|watch|read)|don't (?:like|want)|do not (?:like|want))\b/gi;
 for(const m of text.matchAll(negative)){const end=m.index+m[0].length;if(!overlap(m.index,end))cues.push({start:m.index,end,negative:true});}
 // "No books" and "no horror and gore" are explicit exclusion lists.
 // "No problem with horror" and "no time for books" are not such lists.
 const noList=/\bno(?!\s+(?:problems?|issues?|trouble|difficulty|need|reason|time|idea)\b)(?:\s+(?:any|more))?\s*(?:(?:[a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2})\s+(?:and|or)\s+)*$/i.exec(text);
 if(noList&&!overlap(noList.index,noList.index+2))cues.push({start:noList.index,end:noList.index+2,negative:true});
 // An explicit subject and affirmative verb is a clear new clause. A
 // coordinated "love/enjoy/prefer" also states an affirmative preference;
 // a bare noun list ("...time travel and dragons") never resets negation.
 const positive=/(?:^|\b(?:and|or)\s+)(?:i|we)\s+(?:really\s+)?(?:like|love|enjoy|prefer|want|am (?:interested in|curious about|into|fine with|okay with))\b|\band\s+(?:really\s+)?(?:love|enjoy|prefer)\b/gi;
 for(const m of text.matchAll(positive)){const end=m.index+m[0].length;if(!overlap(m.index,end))cues.push({start:m.index,end,negative:false});}
 return cues.sort((a,b)=>b.start-a.start)[0]?.negative??false;
}
export function englishAvoidance(text:string,topics:RegExp):string|null{
 const flags=[...new Set((topics.flags.replace(/y/g,'')+'g').split(''))].join('');
 for(const clause of clauses(text))for(const match of clause.matchAll(new RegExp(topics.source,flags))){
  if(negativeBeforeTopic(clause.slice(0,match.index)))return match[0];
 }
 return null;
}
export function englishNegatedInterest(text:string,index:number,length:number){
 const normalized=text.replace(/[’]/g,"'");
 const before=normalized.slice(0,index).split(/[,.;!?，。；！？]|\b(?:but|however|although|yet)\b/i).at(-1)??'';
 const after=normalized.slice(index+length).split(/[,.;!?，。；！？]|\b(?:but|however|although|yet|and)\b/i)[0]??'';
 return negativeBeforeTopic(before)||/^\s*(?:do not|don't|does not|doesn't) interest me/i.test(after);
}
