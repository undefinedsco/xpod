import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import limits from '../module-artifact-limits.json';
import {qleverSdkOriginalsView,qleverSdkOuterExecutorOriginAuthority} from './qlever-sdk-originals';
import {qleverSdkExecutionOriginalObservation} from './qlever-sdk-generation';
import {derivedSourceView,assertDerivedSourceCurrent} from './source-context';
import {captureLegalFileIdentity,assertLegalFileIdentity} from './legal-file-custody';
function need(value:unknown,why:string):asserts value {if(!value)throw Error('SDK readonly executor: '+why);}
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const HELPERS:readonly(readonly[string,string])[]=[["qlever/scripts/sdk-readonly-executor-bindings.py", "1a47575d5ca72f93afc0190d4b8d7676ed44edb95433f49f97f08d79fe6f34e6"], ["qlever/scripts/sdk-zip-originals.py", "86cca59ac6a30eb719fe10dbaf6939c4e7c50328e757f22d3d4d34ea90fe6c10"], ["qlever/scripts/sdk-readonly-executor.py", "d07860212e87a3806f382fbde407d658d468b53cd35cd4256ed5beea9e2f32cd"], ["qlever/scripts/sdk-readonly-executor-entry.py", "54f6d66c420965aea80a67e915009dc681424df44577c933b6b8c5fbd36443a9"], ["qlever/scripts/sdk-command-materials.py", "2db81d742b8ea9060ebad2fa0a253555337f457decf09d9ed9a59dd85a598b9a"], ["qlever/scripts/sdk-execution-budget.py", "329194655827de1d03a31db5f311ba1cc59fd0ade7edf2ef48fcc8fae52ebfee"], ["scripts/agentfs-native-ci/supervise.py", "49fd9c7a7a9c9dc1612b1261f0cbc218166f48487df726239437ae9ad98ba407"], ["scripts/lib/module-artifact-limits.json", "c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4"]];
/** No issuer, public registration or caller-provided observations. Reads only
 * the same private SDK and its existing independently verified execution view.
 * This observation alone cannot clear whole/lifetime/source obligations. */
export async function observeQleverSdkReadOnlyExecutor(input:{sdkOriginals:unknown;source:unknown;remainingMilliseconds?:number}):Promise<Readonly<{facts:Readonly<Record<string,unknown>>;pending:readonly string[];assertCurrent?:()=>void}>> {
 const pending=new Set<string>(['qlever-sdk-readonly-executor-whole-source-and-host-kernel-trust-obligations-unverified']);
 const sdk=qleverSdkOriginalsView(input.sdkOriginals),source=derivedSourceView(input.source);
 const unavailable=(why:string)=>Object.freeze({facts:Object.freeze({}),pending:Object.freeze([...pending,why])});
 if(!sdk||!source)return unavailable('qlever-sdk-readonly-executor-private-sdk-source-handles-unavailable');
 const execution=qleverSdkExecutionOriginalObservation(input.sdkOriginals) as any;
 if(!execution)return unavailable('qlever-sdk-readonly-executor-private-operation-observation-unavailable');
 const milliseconds=input.remainingMilliseconds??120000;
 if(!Number.isFinite(milliseconds)||milliseconds<=0||milliseconds>120000)return unavailable('qlever-sdk-readonly-executor-parent-budget-unavailable');
 const end=performance.now()+milliseconds,check=()=>{if(performance.now()>=end)throw Error('same parent deadline exhausted');};
 try{
  need(source.sourceSha===sdk.originFacts.sourceSha,'same immutable source SHA');
  const guard=()=>{need(qleverSdkOriginalsView(input.sdkOriginals)===sdk&&qleverSdkExecutionOriginalObservation(input.sdkOriginals)===execution,'same private SDK/execution handle changed');assertDerivedSourceCurrent(input.source);};check();guard();
  const helpers=HELPERS.map(([name,hash])=>{need(source.trackedPaths.includes(name),'historical source does not implement readonly executor');const path=fileURLToPath(new URL('../../../'+name,import.meta.url));const identity=captureLegalFileIdentity(path);need(identity.size<=BigInt(limits.metadataBytes),'bounded controller source');const bytes=readFileSync(path);need(sha(bytes)===hash&&bytes.equals(source.readTracked(name)),'whole immutable controller/producer helper differs');assertLegalFileIdentity(identity);return identity;});
  const observed=execution.sdkGeneratedInputOriginals as any,coverage=execution.sdkToolchainOperationCoverage as any;
  need(execution.sdkActualConfigureCompileTrackedWaitVerified===true&&observed?.toolchainProcessAuthorityIntervalVerified===true&&Array.isArray(coverage?.operations)&&coverage.operations.length>0&&coverage.operations.length<=limits.sourceMembers,'actual closed authority/operation universe required');
  const providers:any[]=[];
  for(const op of coverage.operations){check();need(Array.isArray(op.mapOriginals)&&Array.isArray(op.unresolved)&&op.unresolved.length===0&&op.mapOriginals.length===op.expectedFileMappingCount,'complete actual operation mapping universe');if(op.kind==='exec'){need(op.primaryFile?.stopReadonlyProvider,'actual exec provider absent');providers.push(op.primaryFile.stopReadonlyProvider);}for(const file of op.mapOriginals){need(file.stopReadonlyProvider,'actual mapped provider absent');providers.push(file.stopReadonlyProvider);}}
  need(providers.length>0&&providers.length<=limits.sourceMembers,'bounded same-private provider universe');
  const python=realpathSync('/usr/bin/python3'),pythonIdentity=captureLegalFileIdentity(python);
  const identity={sourceSha:sdk.originFacts.sourceSha,runHeadSha:sdk.originFacts.runHeadSha,runId:sdk.originFacts.runId,runAttempt:sdk.originFacts.runAttempt,target:sdk.originFacts.target,sdkProfile:'module-bookworm-gcc12'};
  const result=await sdk.withArchiveFile(async archive=>{check();guard();const plan=Buffer.from(JSON.stringify({identity,masterReference:sdk.masterReference,providers,remainingMilliseconds:Math.floor(end-performance.now())}));need(plan.length<=limits.metadataBytes,'bounded same-SDK readonly plan');return JSON.parse(execFileSync(python,['-I','-S','-B',helpers[0]!.path,archive.path],{input:plan,timeout:Math.max(1,Math.floor(end-performance.now())),maxBuffer:limits.metadataBytes,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}}).toString());},{check:()=>{check();guard();},remainingMs:()=>end-performance.now()});
  check();guard();for(const file of [...helpers,pythonIdentity])assertLegalFileIdentity(file);
  need(result.sdkReadOnlyExecutorProtocolOriginalsVerified===true&&result.selectedProvidersBoundToImageRoot===providers.length&&result.wholeSdkSourceVerified===false&&result.toolchainLifetimeImmutabilityVerified===false&&result.globalHostWriterAbsenceVerified===false,'fixed narrow readonly observer scope differs');
  const authority=qleverSdkOuterExecutorOriginAuthority(input.sdkOriginals);
  if(!authority)return Object.freeze({facts:Object.freeze({...result,sdkReadOnlyExecutorOuterAuthorityVerified:false,sdkReadOnlyExecutorOriginalsVerified:false}),pending:Object.freeze([...pending,'qlever-sdk-readonly-executor-reviewed-outer-origin-unavailable']),assertCurrent(){guard();for(const file of [...helpers,pythonIdentity])assertLegalFileIdentity(file);}});
  need(authority.collectorSha256===HELPERS.find(row=>row[0]==='qlever/scripts/sdk-readonly-executor.py')![1],'same reviewed outer collector implementation');
  const facts=Object.freeze({...result,sdkReadOnlyExecutorOuterAuthorityVerified:true,sdkReadOnlyExecutorOriginalsVerified:true});
  return Object.freeze({facts,pending:Object.freeze([...pending]),assertCurrent(){guard();need(qleverSdkOuterExecutorOriginAuthority(input.sdkOriginals)===authority,'same private outer authority revoked');for(const file of [...helpers,pythonIdentity])assertLegalFileIdentity(file);}});
 }catch(error){return unavailable('qlever-sdk-readonly-executor-originals-unverified: '+String(error instanceof Error?error.message:error).slice(0,1024));}
}
