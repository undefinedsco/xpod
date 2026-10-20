import {test,expect} from 'bun:test';
import {verifiedNoticeSupplementDirectories as inspect} from '../../scripts/lib/independent-admission/module-source-phases';
const directory='packages/xpod-api/notice-supplements',name=directory+'/index.json',bytes=Buffer.from('actual immutable original');
const source=()=>({trackedPaths:[name],readTracked:()=>Buffer.from(bytes),readTrackedGitObject:()=>({mode:'100644',bytes:Buffer.from(bytes)})});
test('notice selection is empty by default and otherwise derives the complete immutable regular-file closure',()=>{
 expect(inspect(source(),undefined)).toEqual([]);expect(inspect(source(),[{directory,files:[name]}])).toEqual([directory]);
 for(const input of [[],[{directory,files:[]}],[{directory:'elsewhere',files:[name]}],[{directory,files:[name,name]}],[{directory,files:[directory+'/missing']}],[{directory,files:[name]},{directory,files:[name]}]])expect(()=>inspect(source(),input)).toThrow();
 for(const changed of [{...source(),trackedPaths:[name,directory+'/extra']},{...source(),readTrackedGitObject:()=>({mode:'120000',bytes})},{...source(),readTracked:()=>Buffer.from('drift')},{...source(),readTrackedGitObject:undefined}])expect(()=>inspect(changed,[{directory,files:[name]}])).toThrow();
});
