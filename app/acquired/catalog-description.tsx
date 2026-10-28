import {catalogDescription} from '@/lib/acquired/catalog-description';
import {englishCopy} from '@/lib/acquired/english-copy';
export function CatalogDescription({value,className,candidate=false}:{value:string;className?:string;candidate?:boolean}){
 const copy=catalogDescription(englishCopy(value),candidate);
 return <p className={className}>{copy.text}{copy.note&&<small className="catalog-description-note">{copy.note}</small>}</p>;
}
