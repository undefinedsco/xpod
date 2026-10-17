/** Internal process-local observation memo. Only the operational central gate
 * calls remember after a verified result; no public capability is minted here. */
export function verifiedAdmissionCache<T extends {status:string}>(){
 const issued=new WeakMap<object,{gate:string;keys:readonly unknown[];sets:readonly (readonly unknown[])[];result:T}[]>();
 const equalSet=(left:readonly unknown[],right:readonly unknown[])=>left.length===right.length&&left.every(value=>right.includes(value));
 const normalize=(sets:readonly (readonly unknown[])[])=>sets.map(values=>Object.freeze([...new Set(values)]));
 const matches=(row:{gate:string;keys:readonly unknown[];sets:readonly (readonly unknown[])[]},gate:string,keys:readonly unknown[],sets:readonly (readonly unknown[])[])=>row.gate===gate&&row.keys.length===keys.length&&row.keys.every((value,i)=>value===keys[i])&&row.sets.length===sets.length&&row.sets.every((value,i)=>equalSet(value,sets[i]!));
 return Object.freeze({
  get(artifact:object,gate:string,keys:readonly unknown[],sets:readonly (readonly unknown[])[],assertCurrent?:()=>void):T|undefined{
   const result=issued.get(artifact)?.find(row=>matches(row,gate,keys,normalize(sets)))?.result;
   if(result)assertCurrent?.();return result;
  },
  remember(artifact:object,gate:string,keys:readonly unknown[],sets:readonly (readonly unknown[])[],result:T):T{
   if(result.status!=='verified')return result;
   const normalized=normalize(sets),previous=issued.get(artifact)??[];
   if(previous.length>=64&&!previous.some(row=>matches(row,gate,keys,normalized)))throw Error('Verified observation cache binding budget exceeded');
   // Reports contain facts only, never material handles. Copy and recursively
   // freeze so a caller cannot mutate the saved successful observation.
   const saved=structuredClone(result);
   const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}};freeze(saved);
   const existing=previous.find(row=>matches(row,gate,keys,normalized));
   if(existing)return existing.result;
   previous.push({gate,keys:Object.freeze([...keys]),sets:normalized,result:saved});issued.set(artifact,previous);return saved;
  },
 });
}
