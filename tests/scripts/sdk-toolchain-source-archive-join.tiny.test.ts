import {test,expect} from 'bun:test';
import {inspectSdkToolchainSourceArchiveJoin} from '../../scripts/lib/independent-admission/qlever-sdk-toolchain-source';
const ref=(name:string,letter='a')=>({path:'inner/'+name,bytes:12,sha256:letter.repeat(64)});
function fixture(){
 const dsc=ref('debian-source/package-0000/tool.dsc'),archive=ref('debian-source/package-0000/tool.orig.tar.xz'),inRelease=ref('debian-source/indexes/0/InRelease','b'),sources=ref('debian-source/indexes/0/Sources','c');
 const coordinate={name:'tool-source',version:'1:2.3-1',dsc,archives:[archive]};
 return {files:[{path:'/usr/bin/tool',source:{name:coordinate.name,version:coordinate.version}}],coordinates:[coordinate],collection:{schemaVersion:1,kind:'qlever-sdk-exact-debian-source-originals',packages:[{name:coordinate.name,version:coordinate.version,dsc,files:[archive]}],indexOriginals:[{inRelease,sources}]},checksums:[{inReleaseSha256:inRelease.sha256,sourceOriginal:sources,observation:{signedIndexMatches:[{path:'main/source/Sources.xz',form:'decoded-plain'}]}}],signedReleases:[{inRelease,signers:['reviewed-primary-fingerprint']}]};
}
test('all actual tool source coordinates bind complete DSC/archives and the same signed Sources originals',()=>{
 const f=fixture(),result=inspectSdkToolchainSourceArchiveJoin(f);expect(result.sdkToolchainExactSourceArchiveCoverageVerified).toBe(true);expect(result.sdkToolchainSourceArchiveCoordinates).toEqual(f.coordinates);
});
test('missing or mixed source/signature/checksum/collection tuples never close the source archive axis',()=>{
 const mutations=[(f:any)=>f.files[0].source.version='2.3-1',(f:any)=>f.coordinates=[],(f:any)=>f.coordinates[0].archives=[],(f:any)=>f.coordinates[0].archives[0]={...f.coordinates[0].archives[0],sha256:'f'.repeat(64)},(f:any)=>f.signedReleases=[],(f:any)=>f.signedReleases[0].inRelease={...f.signedReleases[0].inRelease,sha256:'d'.repeat(64)},(f:any)=>f.signedReleases[0].signers=[],(f:any)=>f.checksums[0].sourceOriginal={...f.checksums[0].sourceOriginal,path:'inner/other-Sources'},(f:any)=>f.collection.packages[0].dsc={...f.collection.packages[0].dsc,bytes:13},(f:any)=>f.coordinates.push(f.coordinates[0])];
 for(const mutate of mutations){const f=fixture();mutate(f);expect(()=>inspectSdkToolchainSourceArchiveJoin(f)).toThrow();}
});
test('multiple Sources components share exactly one signature for the same distinct InRelease original',()=>{
 const f=fixture(),index={...f.collection.indexOriginals[0]!,sources:ref('debian-source/indexes/1/Sources','e')};f.collection.indexOriginals.push(index);f.checksums.push({...f.checksums[0]!,sourceOriginal:index.sources});expect(inspectSdkToolchainSourceArchiveJoin(f).sdkToolchainExactSourceArchiveCoverageVerified).toBe(true);
 const duplicate=structuredClone(f);duplicate.signedReleases.push(duplicate.signedReleases[0]!);expect(()=>inspectSdkToolchainSourceArchiveJoin(duplicate)).toThrow('distinct');
 const missing=structuredClone(f);missing.signedReleases=[];expect(()=>inspectSdkToolchainSourceArchiveJoin(missing)).toThrow('distinct');
 const extra=structuredClone(f);extra.signedReleases.push({inRelease:ref('debian-source/indexes/other/InRelease','f'),signers:['reviewed-primary-fingerprint']});expect(()=>inspectSdkToolchainSourceArchiveJoin(extra)).toThrow('distinct');
 const conflict=structuredClone(f);conflict.collection.indexOriginals[1]!.inRelease={...index.inRelease,sha256:'f'.repeat(64)};expect(()=>inspectSdkToolchainSourceArchiveJoin(conflict)).toThrow('conflicting');
});
test('distinct exact InRelease originals each need their own unique signature, including path and bytes',()=>{
 const f=fixture(),release=ref('debian-source/indexes/1/InRelease','f'),index={inRelease:release,sources:ref('debian-source/indexes/1/Sources','e')};f.collection.indexOriginals.push(index);f.checksums.push({...f.checksums[0]!,inReleaseSha256:release.sha256,sourceOriginal:index.sources});f.signedReleases.push({inRelease:release,signers:['reviewed-primary-fingerprint']});expect(inspectSdkToolchainSourceArchiveJoin(f).sdkToolchainExactSourceArchiveCoverageVerified).toBe(true);
 f.signedReleases[1]={...f.signedReleases[0]!};expect(()=>inspectSdkToolchainSourceArchiveJoin(f)).toThrow('signed authority');
});
test('the single caller deadline is checked during each bounded source and file join',()=>{expect(()=>inspectSdkToolchainSourceArchiveJoin(fixture(),()=>{throw Error('expired');})).toThrow('expired');});
