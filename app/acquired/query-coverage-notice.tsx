import {englishCopy} from '@/lib/acquired/english-copy';
import type {Bundle} from '@/lib/acquired/walk';
import {queryCoverageNotice} from '@/lib/acquired/route-evidence';
export function QueryCoverageNotice({bundle}:{bundle:Bundle}){
 const message=queryCoverageNotice(bundle);
 return message?<p className="constraint-recap" role="note">{englishCopy(message)}</p>:null;
}
