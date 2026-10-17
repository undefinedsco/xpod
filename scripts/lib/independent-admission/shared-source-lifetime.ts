/** Reference lifetime only, never an admission issuer. CLI and client share the
 * same authenticated source snapshot until both live archive handles release. */
export function sharedSourceLifetime(originals:{compact():void;dispose():void}){
 let users=0,disposed=false,compacted=false;
 return Object.freeze({
  retain():()=>void{
   if(disposed)throw Error('Source snapshot already disposed');users++;let released=false;
   return ()=>{if(released)return;released=true;if(--users===0){disposed=true;originals.dispose();}};
  },
  compact():void{
   if(disposed)throw Error('Source snapshot already disposed');
   if(!compacted){originals.compact();compacted=true;}
  },
 });
}
