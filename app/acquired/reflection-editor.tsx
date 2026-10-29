type Props={value:string;disabled:boolean;onChange:(value:string)=>void};

// Completion locks the route, not the visitor's reflections on it.
export function ReflectionEditor({value,disabled,onChange}:Props){
 return <label className="reflection">How do your reasons feel now?
  <textarea disabled={disabled} value={value} placeholder="Optional. A little more curious? Has anything that held you back eased?" onChange={event=>onChange(event.target.value)}/>
 </label>;
}
