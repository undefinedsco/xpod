import fs from 'node:fs';
/** Cleanup-only lifetime. This helper issues no capability. The collector alone
 * provides its owned projection and rechecks the retained original ZIP. */
export function nativeOriginalLifetime(input:{snapshot:string;closeReaders():void;verifyRetainedOriginal():void}) {
  let active=true;
  return Object.freeze({
    assertReadable(){if(!active) throw Error('Native original custody: compacted original reader');},
    compact():boolean {
      if(!active) return false;
      // A unique original must survive before a rebuildable projection goes.
      input.verifyRetainedOriginal(); active=false; input.closeReaders();
      fs.rmSync(input.snapshot,{recursive:true,force:true}); return true;
    },
  });
}
