export function ExplanationNotice({status}:{status?:'complete'|'partial'|'missing'}){
 if(!status||status==='complete')return null;
 return <p className="constraint-recap" role="status">{status==='partial'?"Some supporting details are incomplete. Only verified facts are shown below.":"A detailed explanation is unavailable. Expand the measured connection record for the available evidence."}</p>;
}
