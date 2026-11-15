/** Every controlled review phase may inspect each member of the bounded
 * fourteen-product cohort. This deliberately covers cold normalize/readback
 * passes rather than imposing a small per-product cache miss count. */
export const PRODUCT_PROJECTION_REVIEW_PHASES=Object.freeze([
 'collection','source','native','legal','archive-consumer','runtime-closure',
 'final-admission','publication-normalization','publication-plan',
 'registry-readback','registry-consumer','promotion-normalization','promotion-plan',
]);
export const PRODUCT_PROJECTION_COHORT_BOUND=14;
/** I/O accounting only. This object issues no archive or admission capability. */
export function productProjectionIoBudget(){
 const originals=new Map<string,number>();let reservedBytes=0,ioMilliseconds=0;
 const maximumBytes=()=>[...originals.values()].reduce((sum,value)=>sum+value,0)*PRODUCT_PROJECTION_COHORT_BOUND*PRODUCT_PROJECTION_REVIEW_PHASES.length;
 const maximumIoMilliseconds=()=>originals.size*PRODUCT_PROJECTION_REVIEW_PHASES.length*30000;
 return Object.freeze({
  register(digest:string,bytes:number){
   if(!/^[a-f0-9]{64}$/u.test(digest)||!Number.isSafeInteger(bytes)||bytes<0||bytes>2*1024**3)throw Error('Exact indexed projection identity required');
   const previous=originals.get(digest);if(previous!==undefined&&previous!==bytes)throw Error('Conflicting indexed projection size');
   if(previous===undefined&&originals.size>=PRODUCT_PROJECTION_COHORT_BOUND)throw Error('Product projection cohort exceeds fourteen distinct originals');
   originals.set(digest,bytes);
  },
  reserve(bytes:number){
   if(!Number.isSafeInteger(bytes)||bytes<0||reservedBytes+bytes>maximumBytes()||ioMilliseconds>=maximumIoMilliseconds())throw Error('Product projection operation I/O budget exceeded');
   reservedBytes+=bytes;
  },
  recordIo(milliseconds:number){
   if(!Number.isSafeInteger(milliseconds)||milliseconds<0)throw Error('Actual projection I/O duration required');
   ioMilliseconds+=milliseconds;if(ioMilliseconds>maximumIoMilliseconds())throw Error('Product projection operation I/O time exceeded');
  },
  remainingIoMilliseconds(){return Math.max(0,maximumIoMilliseconds()-ioMilliseconds);},
  snapshot(){return Object.freeze({distinctOriginals:originals.size,reservedBytes,maximumBytes:maximumBytes(),ioMilliseconds,maximumIoMilliseconds:maximumIoMilliseconds()});},
 });
}
