import {expect,it,vi} from 'vitest';
import {observeAfsSourceOriginals} from '../../scripts/lib/independent-admission/afs-source-originals';
it('serialized sourcekit/native approvals cannot invoke the observer or qualify source closure',async()=>{
 const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('must not fetch'));
 try{const report=await observeAfsSourceOriginals({artifact:{identity:{package:'@undefineds.co/xpod-afs-linux-x64'}},source:{sourceSha:'a'.repeat(40)},nativeOriginals:{sourceKit:true,compilerVerified:true}});expect(report.verified).toBe(false);expect(report.facts.afsNativeSourceClosureVerified).toBe(false);expect(report.pending).toEqual(['AFS source originals: same issued normal product/source/native originals required']);expect(network).not.toHaveBeenCalled();}finally{network.mockRestore();}
});
