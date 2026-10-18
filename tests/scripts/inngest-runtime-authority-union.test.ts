/** Tests the private-getter protocol; mocks never represent genuine cap issuance. */
import {beforeEach,expect,it,vi} from 'vitest';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
vi.mock('../../scripts/lib/independent-admission/artifact-collector',()=>({collectedArtifactView:vi.fn(),assertCollectedPublicationCustody:vi.fn()}));
vi.mock('../../scripts/lib/independent-admission/inngest-release-originals',()=>({officialInngestReleaseView:vi.fn()}));
vi.mock('../../scripts/lib/independent-admission/module-source-admission',()=>({moduleNativeBuildOriginals:vi.fn()}));
vi.mock('../../scripts/lib/independent-admission/consumer-context',()=>({apiInngestRuntimeOriginalView:vi.fn()}));
import {collectedArtifactView,assertCollectedPublicationCustody} from '../../scripts/lib/independent-admission/artifact-collector';
import {officialInngestReleaseView} from '../../scripts/lib/independent-admission/inngest-release-originals';
import {moduleNativeBuildOriginals} from '../../scripts/lib/independent-admission/module-source-admission';
import {apiInngestRuntimeOriginalView} from '../../scripts/lib/independent-admission/consumer-context';
import {observeInstalledInngestRuntime,installedInngestRuntimeObservation,officialInngestRuntimeObservation} from '../../scripts/lib/independent-admission/inngest-runtime-originals';
import {runtimeFixture} from '../fixtures/independent-admission/inngest-runtime-protocol';
import controlledPolicy from '../../packages/xpod-api/scripts/inngest-controlled-build-policy.json';
import contract from '../../packages/xpod-api/scripts/inngest-controlled-materials-contract.json';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function fixture(){
 const data=runtimeFixture('linux','arm64'),artifact={},consumer={},source={},official={};const binary=Buffer.alloc(128,7);
 const identity={...data.input.product,integrity:'sha512-fixture',archiveSha256:'c'.repeat(64),archiveBytes:1};const product={identity,members:data.input.productMembers,producerOriginals:[],readMember:()=>Buffer.from(binary),readProducerOriginal:()=>{throw Error('fixture has no producer originals');}};
 const collection=Buffer.from(JSON.stringify({schemaVersion:1,sourceKind:controlledPolicy.sourceKind,target:'linux-arm64',sourceCommit:controlledPolicy.sourceCommit,binary:{path:'products/inngest',bytes:binary.length,sha256:hash(binary)},license:{path:'source/LICENSE.md',bytes:1,sha256:'e'.repeat(64)},sourceArchive:{path:'originals/'+controlledPolicy.source.file,bytes:controlledPolicy.source.bytes,sha256:controlledPolicy.source.sha256},inputs:{path:'inputs.original.json',bytes:1,sha256:'e'.repeat(64)},preparation:{path:'preparation.original.json',bytes:1,sha256:'e'.repeat(64)}}));
 const view={sourceKind:'xpod-controlled-inngest-build-v1' as const,target:'linux-arm64',sourceSha:identity.sourceSha,productIdentity:identity,collection:{path:contract.sidecarPrefix+contract.collection,bytes:collection.length,sha256:hash(collection)},phaseRows:[],readOriginal:(name:string,_maximum=4*1024**2,_budget?:{remainingMilliseconds():number})=>{if(name!==contract.collection)throw Error('fixed collection');return Buffer.from(collection);},readOriginalRange:(name:string,offset:number,length:number,_budget?:{remainingMilliseconds():number})=>{if(name!=='products/inngest')throw Error('fixed binary');return Buffer.from(binary.subarray(offset,offset+length));},assertCurrent:vi.fn(),assertProduct:vi.fn()};
 vi.mocked(collectedArtifactView).mockImplementation(c=>c===artifact?product:undefined);
 vi.mocked(assertCollectedPublicationCustody).mockImplementation(c=>{if(c!==artifact)throw Error('current product');});
 vi.mocked(moduleNativeBuildOriginals).mockImplementation((c,p)=>c===source&&p===artifact?view:undefined);
 const original={path:'fixture-original',bytes:1,sha256:'e'.repeat(64)};const officialView={identity,target:'linux-arm64',sourceCommit:controlledPolicy.sourceCommit,releaseID:362726265,releaseTag:'v1.40.0',archive:original,sourceArchive:original,license:original,binary:{path:'node_modules/inngest-cli/bin/inngest',bytes:binary.length,sha256:hash(binary)},officialOriginVerified:true as const,releaseMembersVerified:true as const,sourceArchiveScope:'reviewed-fixed-commit-archive-digest-and-collected-full-bytes' as const,metadataOriginals:[],retainedDirectory:'/fixture-only',readMetadataOriginal:()=>Buffer.alloc(0),assertCurrent:vi.fn()};
 // Complete typed protocol shape; every object remains a test-owned mock.
 vi.mocked(officialInngestReleaseView).mockImplementation(c=>c===official?officialView:undefined);
 const consumerView={identity,stage:'prepublish' as const,result:data.input.result,readOriginal:data.input.readOriginal,assertCurrent:vi.fn()};
 vi.mocked(apiInngestRuntimeOriginalView).mockImplementation(c=>c===consumer?consumerView:undefined);
 return {artifact,consumer,source,official,view,binary,data};
}
beforeEach(()=>{vi.clearAllMocks();});
it('uses the single observer/map for explicit controlled source authority and guards the same handles',async()=>{
 const f=fixture(),input={artifact:f.artifact,consumerObservation:f.consumer,controlledBuildMaterials:f.source};const report=await observeInstalledInngestRuntime(input);expect(report.inngestInstalledVersionExecutionVerified).toBe(true);expect(report.fullRuntimeAbiVerified).toBe(false);expect(report.toolchainSourceClosureVerified).toBe(false);expect(installedInngestRuntimeObservation({controlledBuildMaterials:f.source})).toBe(report);expect(()=>officialInngestRuntimeObservation(f.source)).toThrow('authority kind');
 await expect(observeInstalledInngestRuntime({...input,consumerObservation:{}})).rejects.toThrow('exact observed runtime handles');
 vi.mocked(moduleNativeBuildOriginals).mockReturnValue(undefined);expect(()=>installedInngestRuntimeObservation({controlledBuildMaterials:f.source})).toThrow('same controlled');
});
it('preserves the historical official route and refuses authority mixing or serialized material handles',async()=>{
 const f=fixture(),report=await observeInstalledInngestRuntime({artifact:f.artifact,consumerObservation:f.consumer,officialReleaseOriginals:f.official});expect(officialInngestRuntimeObservation(f.official)).toBe(report);
 await expect(observeInstalledInngestRuntime({artifact:f.artifact,consumerObservation:f.consumer,controlledBuildMaterials:JSON.parse(JSON.stringify(f.source))})).rejects.toThrow('same issued');
 const mixed={artifact:f.artifact,consumerObservation:f.consumer,officialReleaseOriginals:f.official,controlledBuildMaterials:f.source};await expect(observeInstalledInngestRuntime(mixed as never)).rejects.toThrow('one explicit');
});
it('rejects altered compiled bytes, wrong target and expired observation budget before issuing facts',async()=>{
 const f=fixture();f.binary[0]=0;await expect(observeInstalledInngestRuntime({artifact:f.artifact,consumerObservation:f.consumer,controlledBuildMaterials:f.source})).rejects.toThrow('full SHA');expect(installedInngestRuntimeObservation({controlledBuildMaterials:f.source})).toBeUndefined();
 f.binary[0]=7;f.view.target='linux-x64';await expect(observeInstalledInngestRuntime({artifact:f.artifact,consumerObservation:f.consumer,controlledBuildMaterials:f.source})).rejects.toThrow('same issued');
 f.view.target='linux-arm64';await expect(observeInstalledInngestRuntime({artifact:f.artifact,consumerObservation:f.consumer,controlledBuildMaterials:f.source,remainingMilliseconds:0})).rejects.toThrow('deadline');
});

it('passes the same remaining budget into cold-reader blocking work before it starts',async()=>{
 const f=fixture();let spawned=false;f.view.readOriginal=(_name,_maximum,budget)=>{expect(budget).toBeDefined();const remaining=budget!.remainingMilliseconds();expect(remaining).toBeGreaterThan(0);spawned=true;const result=spawnSync(process.execPath,['-e','setTimeout(()=>{},250)'],{timeout:Math.max(1,Math.floor(remaining)),encoding:'utf8'});expect(result.error).toBeDefined();throw Error('controlled cold reader timed out under inherited budget');};
 const started=performance.now();await expect(observeInstalledInngestRuntime({artifact:f.artifact,consumerObservation:f.consumer,controlledBuildMaterials:f.source,remainingMilliseconds:30})).rejects.toThrow('cold reader timed out');expect(spawned).toBe(true);expect(performance.now()-started).toBeLessThan(230);expect(installedInngestRuntimeObservation({controlledBuildMaterials:f.source})).toBeUndefined();
});
