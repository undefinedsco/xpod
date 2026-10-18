import {describe,it,expect} from 'vitest';
import {inspectSdkObservedToolAfterFiles} from '../../scripts/lib/independent-admission/qlever-sdk-inputs';
import {observeQleverSdkObservedToolOriginals} from '../../scripts/lib/independent-admission/qlever-sdk-observed-tools';
const file={path:'/usr/bin/tool',bytes:3,sha256:'a'.repeat(64),mode:0o755,phase:'configure',captureSequence:3,identityDecimal:['1','2','33261','3','1760000000000000001','1760000000000000003'],observedBeforeCompile:false};
const row={originalPath:file.path,bytes:file.bytes,sha256:file.sha256,mode:file.mode};
const binary={installedPath:file.path,bytes:file.bytes,sha256:file.sha256,mode:file.mode,binary:{name:'tool',version:'1',architecture:'arm64'},source:{name:'tool',version:'1'}};
describe('observed tools narrow byte joins',()=>{
 it('joins only actual full-shard and exact private binary file projection; does not invent before',()=>{
  const result=inspectSdkObservedToolAfterFiles({files:[file],verifiedRows:[row],binaryFiles:[binary]});expect(result.pending).toEqual([]);expect(result.files[0]?.observedBeforeCompile).toBe(false);expect(result.files[0]?.declaredSource).toEqual(binary.source);
  expect(inspectSdkObservedToolAfterFiles({files:[file],verifiedRows:[row],binaryFiles:[]}).pending[0]?.reason).toBe('observed-tool-official-Debian-binary-original-unavailable');
 });
 it('rejects changed after rows, duplicate capture, or a fake before claim',()=>{
  for(const input of [{files:[file],verifiedRows:[{...row,sha256:'b'.repeat(64)}],binaryFiles:[binary]},{files:[file,file],verifiedRows:[row],binaryFiles:[binary]},{files:[{...file,observedBeforeCompile:true}],verifiedRows:[row],binaryFiles:[binary]}])expect(()=>inspectSdkObservedToolAfterFiles(input)).toThrow();
 });
 it('plain JSON cannot enter existing private SDK/execution observations',async()=>{
  const value=await observeQleverSdkObservedToolOriginals({identity:{sourceSha:'a'.repeat(40)}},{sourceSha:'a'.repeat(40)});
  expect(value.facts.sdkObservedToolAfterShardBytesVerified).toBe(false);expect(value.facts.sdkWholeToolchainVerified).toBe(false);expect(value.pending.join(' ')).toContain('same private');
 });
});
