import {beforeEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
const state=vi.hoisted(()=>({cap:Object.freeze({}),source:Object.freeze({}),sdk:undefined as any,sourceView:undefined as any,inputs:undefined as any,execution:undefined as any,binary:undefined as any,archives:undefined as any,checksums:undefined as any,signature:undefined as any,tools:undefined as any}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-originals',()=>({qleverSdkOriginalsView:(cap:unknown)=>cap===state.cap?state.sdk:undefined}));
vi.mock('../../scripts/lib/independent-admission/source-context',()=>({derivedSourceView:(cap:unknown)=>cap===state.source?state.sourceView:undefined,assertDerivedSourceCurrent:(cap:unknown)=>{if(cap!==state.source)throw Error('source revoked');}}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-source',()=>({sdkVerifiedInputOriginalView:(cap:unknown)=>cap===state.cap?state.inputs:undefined,sdkVerifiedSourceArchiveOriginalView:(cap:unknown)=>cap===state.cap?state.archives:undefined}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-generation',()=>({qleverSdkExecutionOriginalObservation:(cap:unknown)=>cap===state.cap?state.execution:undefined}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-debian-binary',()=>({qleverSdkDebianBinaryObservation:(cap:unknown)=>cap===state.cap?state.binary:undefined}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-debian-index',()=>({qleverSdkDebianIndexObservation:(cap:unknown)=>cap===state.cap?state.checksums:undefined}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-debian-signature',()=>({qleverSdkDebianSignatureObservation:(cap:unknown)=>cap===state.cap?state.signature:undefined}));
vi.mock('../../scripts/lib/independent-admission/qlever-sdk-observed-tools',()=>({observeQleverSdkObservedToolOriginals:async()=>state.tools}));
import {observeQleverSdkToolchainSourceOriginals} from '../../scripts/lib/independent-admission/qlever-sdk-toolchain-source';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const gap='qlever-sdk-toolchain-exact-source-archive-coverage-private-join-unavailable';
beforeEach(()=>{
 const ref=(path:string,letter='b')=>({path:'inner/'+path,bytes:12,sha256:letter.repeat(64)});
 const dsc=ref('debian-source/package-0000/a.dsc'),archive=ref('debian-source/package-0000/a.orig.tar.xz'),inRelease=ref('debian-source/indexes/0/InRelease'),sources=ref('debian-source/indexes/0/Sources','c'),name='fixture-source',version='1';
 const collection={schemaVersion:1,kind:'qlever-sdk-exact-debian-source-originals',packages:[{name,version,dsc,files:[archive]}],indexOriginals:[{inRelease,sources}]};const data=Buffer.from(JSON.stringify(collection)),collectionRef={path:'inner/debian-source-collection.json',bytes:data.length,sha256:hash(data)},master=Buffer.from(JSON.stringify({debianSources:collectionRef}));
 state.sourceView={sourceSha:'a'.repeat(40)};state.sdk={originFacts:{sourceSha:state.sourceView.sourceSha,target:'linux-arm64'},masterReference:{path:'materials.json',bytes:master.length,sha256:hash(master)},readOriginal:(path:string)=>path==='materials.json'?master:data};
 const identity=['1','7',String(0o100755),'100','1700000000000000001','1700000000000000002'],original={path:'capture-0001.original',bytes:100,sha256:'e'.repeat(64)},file={observedPath:'/usr/bin/tool',identityDecimal:identity,original,originalCaptureSequence:2};
 state.inputs={afterReference:ref('after.json'),rows:[{originalPath:file.observedPath,bytes:100,sha256:original.sha256,mode:0o755}]};
 state.execution={sdkActualConfigureCompileTrackedWaitVerified:true,sdkToolchainOperationCoverage:{schemaVersion:1,operations:[{kind:'exec',phase:'configure',pid:5,entrySequence:1,execEventSequence:3,captureSequence:4,primaryFile:file,mapOriginals:[],expectedFileMappingCount:0,unresolved:[]}],pending:[]}};
 state.tools={facts:{sdkObservedToolAfterShardFiles:[{path:file.observedPath,phase:'configure',captureSequence:2,identityDecimal:identity,bytes:100,sha256:original.sha256,mode:0o755}]},pending:[],assertCurrent:()=>{}};
 state.binary={files:[{installedPath:file.observedPath,bytes:100,sha256:original.sha256,mode:0o755,binary:{name:'fixture',version:'1',architecture:'arm64'},source:{name,version}}],assertCurrent:()=>{}};
 state.archives={sourceSha:state.sourceView.sourceSha,target:'linux-arm64',collection:collectionRef,coordinates:[{name,version,dsc,archives:[archive]}],officialAuthorityVerified:false,assertCurrent:()=>{}};
 state.checksums=[{inReleaseSha256:inRelease.sha256,sourceOriginal:sources,observation:{signedIndexMatches:[{path:'main/source/Sources',form:'plain'}]}}];
 state.signature={sdkDebianOfficialSignatureAndSuiteVerified:true,sdkDebianSignatureOriginals:{observations:[{inRelease,signers:['mock reviewed authority']}]}};
});
it('private-handle protocol closes only exact source archive scope and continuously guards every joined view',async()=>{
 const result=await observeQleverSdkToolchainSourceOriginals(state.cap,state.source);expect(result.facts.sdkToolchainExactSourceArchiveCoverageVerified).toBe(true);expect(result.pending).not.toContain(gap);expect(result.pending).toContain('qlever-sdk-toolchain-execution-lifetime-immutability-unverified');expect(result.facts.sdkToolchainSourceClosureVerified).toBe(false);result.assertCurrent!();state.archives={...state.archives};expect(()=>result.assertCurrent!()).toThrow('source archive/signature/checksum');
});
it('mechanical archive view alone cannot bypass missing/false private signature or same SDK source target',async()=>{
 state.signature.sdkDebianOfficialSignatureAndSuiteVerified=false;let result=await observeQleverSdkToolchainSourceOriginals(state.cap,state.source);expect(result.facts.sdkToolchainExactSourceArchiveCoverageVerified).toBe(false);expect(result.pending).toContain(gap);
 state.signature.sdkDebianOfficialSignatureAndSuiteVerified=true;state.archives.target='linux-x64';result=await observeQleverSdkToolchainSourceOriginals(state.cap,state.source);expect(result.pending).toContain(gap);expect(result.facts.sdkToolchainExactSourceArchiveCoverageVerified).toBe(false);
});
it('changed source refs or binary/after identities never discharge the exact archive pending',async()=>{
 state.archives.collection={...state.archives.collection,sha256:'f'.repeat(64)};let result=await observeQleverSdkToolchainSourceOriginals(state.cap,state.source);expect(result.pending).toContain(gap);
 state.binary.files[0].sha256='f'.repeat(64);result=await observeQleverSdkToolchainSourceOriginals(state.cap,state.source);expect(result.facts.sdkToolchainExactSourceArchiveCoverageVerified).toBe(false);expect(result.pending).toContain(gap);
});
it('caller JSON/serialized reports never resolve any private SDK/source observation',async()=>{const result=await observeQleverSdkToolchainSourceOriginals({...state.cap},{...state.source});expect(result.facts.sdkToolchainExactSourceArchiveCoverageVerified).toBe(false);expect(result.pending.join(' ')).toContain('same private');});
it.each(['signature','checksums','binary','inputs'] as const)('retained source archive fact is revoked when the joined %s private observation changes',async role=>{const result=await observeQleverSdkToolchainSourceOriginals(state.cap,state.source);expect(result.facts.sdkToolchainExactSourceArchiveCoverageVerified).toBe(true);(state as any)[role]=Array.isArray(state[role])?[...state[role]]:{...state[role]};if(role==='inputs')(state.inputs as any).rows=[...state.inputs.rows];expect(()=>result.assertCurrent!()).toThrow();});
it('actual adapter protocol deduplicates signatures by exact InRelease path across component Sources indexes',async()=>{
 const collection=JSON.parse(state.sdk.readOriginal(state.archives.collection.path).toString()),first=collection.indexOriginals[0],sources={...first.sources,path:'inner/debian-source/indexes/1/Sources',sha256:'d'.repeat(64)};
 collection.indexOriginals.push({...first,sources});state.checksums.push({...state.checksums[0],sourceOriginal:sources});
 const bytes=Buffer.from(JSON.stringify(collection)),ref={...state.archives.collection,bytes:bytes.length,sha256:hash(bytes)},master=Buffer.from(JSON.stringify({debianSources:ref}));state.archives.collection=ref;state.sdk.masterReference={path:'materials.json',bytes:master.length,sha256:hash(master)};state.sdk.readOriginal=(path:string)=>path==='materials.json'?master:bytes;
 expect(state.signature.sdkDebianSignatureOriginals.observations).toHaveLength(1);const result=await observeQleverSdkToolchainSourceOriginals(state.cap,state.source);expect(result.facts.sdkToolchainExactSourceArchiveCoverageVerified).toBe(true);expect(result.pending).not.toContain(gap);expect(result.pending).toContain('qlever-sdk-toolchain-execution-lifetime-immutability-unverified');
});
