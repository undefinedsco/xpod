/** Read-only post-build observer. Exit zero means observation completed; this
 * command never accepts a candidate or publication qualification. It does issue
 * the private WHOLE-service aggregate (source+ABI+legal) when every axis is
 * genuinely verified, which is what `--require-qualification` asserts. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {acquireCandidateServiceOriginals,type ArtifactAcquisitionInput} from './acquire-independent-product-input';
import {observeCandidateServiceImageGitHubOrigin} from './lib/independent-admission/github-origin';
import {collectNativeAdmissionOriginals,nativeOriginalsView,assertCollectedNativeOriginalCustody} from './lib/independent-admission/native-original-collector';
import {deriveCandidateServiceSource,assertDerivedSourceCurrent,bindDerivedSourceBudget} from './lib/independent-admission/source-context';
import {collectRelatedQleverSdkOriginals} from './lib/independent-admission/qlever-sdk-originals';
import {observeQleverSdkSourceAdmission,qleverSdkSourceAdmissionView} from './lib/independent-admission/qlever-sdk-source';
import {observeCandidateServiceRootMutation} from './lib/independent-admission/candidate-service-root-mutation';
import {observeCandidateServicePackOutput} from './lib/independent-admission/candidate-service-pack-output';
import {collectRelatedCandidateServiceNativeRuntimeOriginals} from './lib/independent-admission/candidate-service-native-runtime-related';
import {readCandidateServiceRelationship} from './lib/independent-admission/qlever-sdk-service-relationship';
import {createCandidateServiceQualificationBudget} from './lib/independent-admission/candidate-service-qualification-budget';
import {observeCandidateServiceRuntimeArtifact} from './lib/independent-admission/candidate-service-runtime-artifact';
import {observeCandidateServiceWholeQualification,assertWholeServiceQualification,sealWholeServiceQualification,candidateServiceWholeQualificationView,type WholeServiceQualificationInput} from './lib/independent-admission/candidate-service-whole-qualification';
import {runCandidateServiceNormalPipeline} from './lib/independent-admission/candidate-service-normal-pipeline';

export function candidateServiceObservationArguments(argv:readonly string[]){
 const names=['source-sha','run-id','run-attempt','service-artifact-id','service-artifact-digest','service-master-bytes','service-master-sha256','checkout','output'];const values=new Map<string,string>();
 for(let i=0;i<argv.length;i+=2){const name=argv[i]?.replace(/^--/u,'');if(!name||argv[i]!==`--${name}`||!names.includes(name)||values.has(name)||!argv[i+1])throw Error('Exact candidate service observer arguments required');values.set(name,argv[i+1]!);}
 if(values.size!==names.length)throw Error('Complete candidate service observer arguments required');
 const get=(key:string)=>values.get(key)!;const positive=(key:string)=>{const value=get(key);if(!/^[1-9][0-9]*$/u.test(value)||!Number.isSafeInteger(Number(value)))throw Error('Positive exact observer integer required');return Number(value);};
 if(!/^[a-f0-9]{40}$/u.test(get('source-sha'))||!['service-artifact-digest','service-master-sha256'].every(key=>/^[a-f0-9]{64}$/u.test(get(key))))throw Error('Exact observer SHA required');
 const input:ArtifactAcquisitionInput={schemaVersion:1,sourceSha:get('source-sha'),runHeadSha:get('source-sha'),runId:positive('run-id'),runAttempt:positive('run-attempt'),artifactId:positive('service-artifact-id'),artifactSha256:get('service-artifact-digest')};
 const bytes=positive('service-master-bytes');if(bytes>4*1024**2)throw Error('Bounded service master required');
 return {input,master:{bytes,sha256:get('service-master-sha256')},checkout:get('checkout'),output:get('output')};
}

/** Release-gate assertion over the ONE private whole-service aggregate. It never
 * accepts report JSON or caller booleans: without a genuine aggregate capability
 * it fails closed with the aggregate's concrete missing-axis message. */
export function requireCandidateServiceQualification(value?:unknown,input?:WholeServiceQualificationInput):true|never{
 try{
  if(input===undefined)throw Error('genuine whole-service aggregate capability required (source+ABI+legal private observations)');
  return assertWholeServiceQualification(value,input);
 }catch(error){
  throw Error('Candidate service qualification pending: '+String((error as Error)?.message??error));
 }
}
/** Release-gate entry: only a sealed aggregate for the exact same private
 * handles/budget may pass. */
export function requireCandidateServiceWholeQualification(value:unknown,input:WholeServiceQualificationInput):true{
 return requireCandidateServiceQualification(value,input);
}

/** The normal CLI: one acquisition → one source derivation → one runtime
 * artifact → one shared parent ledger → real registry/Bun/Git/dependency
 * staging → one materialized workspace → one App replay → the three
 * independent axes → the whole-service aggregate. Nothing is passed in from
 * outside this process and nothing is fabricated. */
export async function observeCandidateServiceSdkSource(argv:readonly string[],requireQualification=false){
 const args=candidateServiceObservationArguments(argv);const output=path.resolve(args.output);
 if(fs.existsSync(output)||fs.realpathSync(path.dirname(output))!==path.dirname(output))throw Error('Fresh canonical owned observer output required');
 fs.mkdirSync(output,{mode:0o700});
 const token=process.env.GITHUB_TOKEN;
 let aggregate:unknown,aggregateInput:WholeServiceQualificationInput|undefined;
 // A1: ONE explicitly owned lifecycle callback for the materialized workspace
 // scratch. It is set once by the pipeline and invoked exactly once in the
 // finally below, AFTER every observation has been consumed. The owned output
 // report, acquisition evidence and bounded raw diagnostics are NOT removed.
 let releaseOwnedScopes:(()=>void)|undefined;
 try{
  const origin=await observeCandidateServiceImageGitHubOrigin(args.input,{token});
  const acquisition=path.join(output,'service-acquisition');
  await acquireCandidateServiceOriginals(args.input,acquisition,origin,{token});
  const native=await collectNativeAdmissionOriginals({githubOrigin:origin,acquisitionRoot:acquisition});
  const view=nativeOriginalsView(native)!;
  const member=view.members.find(row=>row.path==='service-image-materials.json');
  if(!member||member.bytes!==args.master.bytes||member.sha256!==args.master.sha256)throw Error('Actual retained service master differs from build job outputs');
  const raw=view.readOriginal(member.path,4*1024**2);
  if(createHash('sha256').update(raw).digest('hex')!==args.master.sha256)throw Error('Actual retained service master SHA differs');
  const source=deriveCandidateServiceSource(native,args.checkout);
  const sdk=await collectRelatedQleverSdkOriginals({nativeOriginals:native,output:path.join(output,'sdk-acquisition'),token});
  const relationship=readCandidateServiceRelationship(native);
  const nativeRuntime=relationship.master.nativeRuntimeArtifact===undefined?undefined
   :await collectRelatedCandidateServiceNativeRuntimeOriginals({serviceOriginals:native,output:path.join(output,'native-runtime-acquisition'),token});
  const budget=createCandidateServiceQualificationBudget(native);
  bindDerivedSourceBudget(source,budget);
  readCandidateServiceRelationship(native,budget);
  budget.check();
  const rootMutation=observeCandidateServiceRootMutation({originals:native,source});rootMutation.assertCurrent();budget.check();
  const pack=await observeCandidateServicePackOutput({originals:native,source,budget});budget.check();pack?.assertCurrent();
  const observation=await observeQleverSdkSourceAdmission({sdkOriginals:sdk,source,remainingMilliseconds:budget.remainingMs()});
  budget.check();observation.assertCurrent();pack?.assertCurrent();rootMutation.assertCurrent();
  assertDerivedSourceCurrent(source);assertCollectedNativeOriginalCustody(native);budget.check();
  const runtimeArtifact=await observeCandidateServiceRuntimeArtifact({originals:native,source,budget});
  if(!runtimeArtifact)throw Error('Genuine whole-service runtime artifact observation required');
  if(!pack)throw Error('Genuine completed pack observation required for the normal build pipeline');
  // B1: the CLI no longer invents a staging path. The pipeline asks the existing
  // staging module for a unique owned root under that module's canonical parent,
  // so every stage satisfies the unchanged path guard. The CLI's own output
  // report, acquisition and evidence stay where they are.
  const pipeline=await runCandidateServiceNormalPipeline({originals:native,source,sdk,runtimeArtifact,pack,budget:budget as never});
  // Hold the single release callback. If the pipeline already threw, its own
  // catch released; if it returned, ownership transfers to this CLI.
  releaseOwnedScopes=pipeline.releaseMaterialized;
  const nativeContext={qualification:nativeRuntime,originals:native,sdkOriginals:sdk,sdkAdmission:observation};
  aggregateInput={originals:native,source,sdk,runtimeArtifact,pack,
   materialized:pipeline.materialized,materializedInput:pipeline.materializedInput,
   replay:pipeline.replay,nativeContext,budget};
  // A2: the SDK source admission is a HARD prerequisite for the WHOLE
  // aggregate and for any qualified report. Resolve it through the actual
  // private getter for the SAME SDK/source handles and the SAME parent budget:
  // forged JSON, copied objects, wrong handles, stale views and
  // verified:false/pending admissions never resolve. On failure we throw a
  // concrete pending and write NO qualified-true report.
  const admissionView=qleverSdkSourceAdmissionView(observation,{sdkOriginals:sdk,source});
  if(!admissionView)
   throw Error('Candidate service qualification pending: genuine verified SDK source admission required for the same SDK/source handles (pending or forged admission rejected): '
    +(Array.isArray((observation as any).pending)?(observation as any).pending.join(','):'no-pending-list'));
  if(admissionView.verified!==true||!Array.isArray(admissionView.pending)||admissionView.pending.length!==0)
   throw Error('Candidate service qualification pending: SDK source admission is not verified with zero pending: '
    +String(admissionView.pending.join(',')||'pending'));
  budget.check();admissionView.assertCurrent();
  aggregate=await observeCandidateServiceWholeQualification(aggregateInput);
  // V2-2 fix: SEAL, then RESOLVE through the sealed private getter, then run the
  // release assert — ALL BEFORE the report is constructed or written. The report
  // below is derived from that one authoritative sealed view (plus the genuine
  // SDK admission), never from duplicated literals that precede the gate.
  if(!sealWholeServiceQualification(aggregate))throw Error('Whole-service aggregate did not seal');
  const sealed=candidateServiceWholeQualificationView(aggregate,aggregateInput);
  if(!sealed)throw Error('Sealed whole-service aggregate did not resolve through its private getter');
  if(requireQualification)requireCandidateServiceWholeQualification(aggregate,aggregateInput);
  // The SDK admission must be genuinely verified through the actual SOURCE
  // native-binding contract; a pending admission may not be reported as success
  // and may not be pruned away.
  const sdkVerified=observation.verified===true
   &&Array.isArray(observation.pending)&&observation.pending.length===0;
  const sdkPending=Array.isArray(observation.pending)?observation.pending.map((row:unknown)=>String(row)):[];
  const reportPending=[...sdkPending];
  if(!sdkVerified)reportPending.push('qlever-sdk-source-admission-not-verified');
  const report=Object.freeze({schemaVersion:1,sourceSha:args.input.sourceSha,runId:args.input.runId,runAttempt:args.input.runAttempt,
   serviceArtifactId:args.input.artifactId,observationCompleted:true,releaseAccepted:false,
   // Derived from the sealed aggregate view, which only exists when all three
   // axes passed their own current gates.
   wholeServiceSourceVerified:sealed.wholeServiceSourceVerified===true,
   serviceAbiVerified:sealed.serviceAbiVerified===true,
   legalCoverageVerified:sealed.legalCoverageVerified===true,
   wholeServiceQualificationVerified:sealed.wholeServiceQualificationVerified===true,
   aggregateSourceSha:sealed.sourceSha,aggregateSdkSourceSha:sealed.sdkSourceSha,
   aggregateAppSdkSameSourceSha:sealed.appSdkSameSourceSha,
   serviceImageReferenceByDigest:relationship.master.serviceImageReferenceByDigest,
   serviceConfigDigest:relationship.master.images.service.configDigest,sdkImageReferenceByDigest:relationship.sdkImage,
   sdkSourceSha:(sdk as any).originFacts?.sourceSha,appSdkSameSourceSha:(source as any).sourceSha===(sdk as any).originFacts?.sourceSha,
   bunSha256:pipeline.bunView?.executableSha256,bunTarget:pipeline.bunView?.target,
   networkIsolation:pipeline.replayView?.networkIsolation,pipelineStages:pipeline.stages,
   sdkSourceAdmissionVerified:sdkVerified,
   pending:Object.freeze(reportPending),
   rootMutationObservation:{facts:rootMutation.facts,pending:rootMutation.pending},
   packOutputObservation:{facts:pack.facts,pending:pack.pending},
   sdkSourceObservation:{verified:observation.verified,facts:observation.facts,pending:observation.pending}});
  fs.writeFileSync(path.join(output,'service-source-observation.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  return report;
 }finally{
  // A1: release the owned materialized workspace scratch exactly once, on
  // SUCCESS and on EVERY throw (including a throw after materialize but before
  // the pipeline returned, and partial-staging failure where it is undefined).
  // Bounded raw diagnostics, the owned output report and the acquisition
  // evidence live elsewhere and are never deleted here.
  const release=releaseOwnedScopes;releaseOwnedScopes=undefined;
  if(release)release();
 }
 // NOTE (V3): this function deliberately does NOT seal on failure. Sealing MOVES
 // the provisional entry into the `issued` map, i.e. it PUBLISHES the aggregate
 // for candidateServiceWholeQualificationView; doing that after a failed axis
 // would make a failed aggregate resolvable. The success path seals explicitly
 // above, before the report; on failure the provisional entry is never promoted.
}
if(import.meta.main){const argv=process.argv.slice(2);const requireQualification=argv[argv.length-1]==='--require-qualification';if(requireQualification)argv.pop();observeCandidateServiceSdkSource(argv,requireQualification).catch(error=>{console.error((error as Error).message);process.exitCode=1;});}
