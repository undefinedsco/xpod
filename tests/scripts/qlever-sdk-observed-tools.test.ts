import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inspectSdkObservedToolAfterFiles} from '../../scripts/lib/independent-admission/qlever-sdk-inputs';
import {observeQleverSdkObservedToolOriginals} from '../../scripts/lib/independent-admission/qlever-sdk-observed-tools';
const file={path:'/usr/bin/tool',bytes:3,sha256:'a'.repeat(64),mode:0o755,phase:'configure',captureSequence:3,identityDecimal:['1','2','33261','3','1760000000000000001','1760000000000000003'],observedBeforeCompile:false};
const row={originalPath:file.path,bytes:file.bytes,sha256:file.sha256,mode:file.mode};
const binary={installedPath:file.path,bytes:file.bytes,sha256:file.sha256,mode:file.mode,binary:{name:'tool',version:'1',architecture:'arm64'},source:{name:'tool',version:'1'}};
describe('observed tools narrow byte joins',()=>{
 it('binds every declared controller helper to its actual original bytes',()=>{
  const source=readFileSync(new URL('../../scripts/lib/independent-admission/qlever-sdk-observed-tools.ts',import.meta.url),'utf8');
  const declaration=source.match(/const HELPERS:[^\n]*?=(\[[^\n]+\]);/);
  expect(declaration,'fixed literal helper declaration').not.toBeNull();
  const helpers:unknown=JSON.parse(declaration![1]!.replace(/'/g,'"'));
  expect(Array.isArray(helpers)).toBe(true);
  const rows=helpers as [string,string][];
  expect(rows.length).toBeGreaterThan(0);
  expect(new Set(rows.map(row=>row[0])).size).toBe(rows.length);
  const verify=(name:string,expected:string)=>{
   expect(name).toMatch(/^sdk-[a-z-]+\.py$/);
   expect(expected).toMatch(/^[a-f0-9]{64}$/);
   const bytes=readFileSync(new URL('../../qlever/scripts/'+name,import.meta.url));
   expect(createHash('sha256').update(bytes).digest('hex'),name+' reviewed bytes').toBe(expected);
  };
  for(const row of rows){expect(row).toHaveLength(2);verify(row[0],row[1]);}
  expect(rows.map(row=>row[0])).toEqual(expect.arrayContaining(['sdk-zip-originals.py','sdk-execution-originals-util.py']));
  expect(()=>verify('sdk-zip-originals.py','304a8d26c8a124af31f2b240f1b2af52312520982cd6e1f4cba70fde2602bcb8')).toThrow();
 });
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
