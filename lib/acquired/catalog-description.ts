/** Display only: keep stored catalog evidence and routing inputs unchanged.
 * Legacy catalog adapters cap descriptions at 220 characters, and candidate
 * cards cap them at 60 plus an ellipsis. Neither cap records the next letter.
 * Omit the uncertain final token rather than display half a word. */
export function catalogDescription(value:string, candidate=false):{text:string;note:string;kind:'excerpt'|'source-fragment'|'complete'}{
 const text=value.trim();
 if(!text)return {text:'',note:'',kind:'complete'};
 const cardCap=candidate&&text.length===61&&text.endsWith('…');
 const localCap=text.length===220||cardCap;
 if(localCap){
  const body=(cardCap?text.slice(0,-1):text).trimEnd();
  const safe=/[.!?。！？][”’"')\]]?$/.test(body)?body:body.replace(/\s+\S*$/u,'').trimEnd();
  return {text:(safe||'')+'…',note:'Catalog excerpt; the app shortened this description.',kind:'excerpt'};
 }
 if(text.endsWith('…')||text.endsWith('...'))return {text,note:'Catalog excerpt; no further text was supplied.',kind:'source-fragment'};
 if(!/[.!?。！？][”’"')\]]?$/.test(text))return {text:text+' …',note:'Catalog text ends here; no further text was supplied.',kind:'source-fragment'};
 return {text,note:'',kind:'complete'};
}
