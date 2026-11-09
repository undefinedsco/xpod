/**
 * NORMAL CLI pipeline: build the verifier workspace and run the App replay from
 * the SAME single acquisition, using only genuine retained originals and the
 * official tool artifact. No caller JSON, no injected capabilities, no second
 * acquisition, no reserved test-only shortcuts.
 *
 * Every stage consumes the one shared parent ledger created by the CLI. The
 * returned handles are exactly what the whole-service aggregate needs for the
 * SOURCE axis (`materialized`, `materializedInput`, `replay`).
 */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {derivedSourceView,assertDerivedSourceCurrent,deriveCandidateServiceGitDependencySource} from './source-context';
import {nativeOriginalsView,assertCollectedNativeOriginalCustody} from './native-original-collector';
import {candidateServicePackSelectedInputView,candidateServiceFinalPackView} from './candidate-service-pack-output';
import {observeCandidateServiceRegistryOriginal} from './legal-registry-originals';
import {observeCandidateServiceBun142Runtime,candidateServiceBun142RuntimeView} from './legal-bun-runtime';
import {stageCandidateServiceBuildRegistryLayout,stageCandidateServiceBuildBun,stageCandidateServiceBuildGit,stageCandidateServiceBuildGitDependency,allocateCandidateServiceStagingRoot} from './candidate-service-workspace-inputs';
import {materializeCandidateServiceBuildWorkspace,candidateServiceBuildMaterializedWorkspaceView} from './candidate-service-workspace-materialize';
import {observeCandidateServiceWorkspaceReplay,candidateServiceWorkspaceReplayView} from './candidate-service-workspace-replay';

const fail=(reason:string):never=>{throw Error('Candidate service normal pipeline: '+reason);};
function need(value:unknown,reason:string):asserts value{if(!value)fail(reason);}
/** N2: combine a primary failure with a cleanup failure using standard ES2021
 * AggregateError (NO ES2022 `cause` option). Plain JS `Error` has no `addNote`,
 * so the former addNote path silently dropped cleanup diagnostics.
 * Semantics:
 *   - cleanup succeeds -> the ORIGINAL primary object is preserved unchanged;
 *   - cleanup alone fails -> the raw cleanup failure is propagated;
 *   - both fail -> AggregateError([primary, cleanup]) keeps BOTH, primary first.
 * The CLI prints `error.message`, so the message still starts with the primary
 * cause and stays bounded. */
function combinePrimaryAndCleanup(primary:unknown,cleanup:unknown,label:string):Error{
 if(cleanup===undefined)return primary as Error;
 const primaryError=primary instanceof Error?primary:Error(String(primary));
 const cleanupError=cleanup instanceof Error?cleanup:Error(String(cleanup));
 if(primary===undefined)return cleanupError;
 return new AggregateError([primaryError,cleanupError],primaryError.message+' ['+label+': '+cleanupError.message.slice(0,512)+']');
}
/** Run a cleanup thunk, returning its failure (if any) instead of throwing. */
function captureCleanup(run:()=>void):unknown{
 try{run();return undefined;}catch(error){return error;}
}


export type NormalPipelineBudget=Readonly<{
 check():void;remainingMs():number;reserveBytes(bytes:number):void;chargeReadBytes(bytes:number):void;
 remainingReadBytes():number;remainingOriginalBytes():number;
 reserveOriginalMaximum(maximum:number):object;
 settleOriginalReservation(token:object,actual:number,unusedOriginalsAbsent:boolean):void;
}>;

export interface NormalPipelineInput {
 readonly originals:unknown;readonly source:unknown;readonly sdk:unknown;
 readonly runtimeArtifact:unknown;readonly pack:unknown;
 readonly budget:NormalPipelineBudget;
 /** Optional caller-provided owned scratch root. When absent the pipeline uses
  * the ONE allocator exported by the staging module, which creates a unique
  * owned root under that module's own canonical staging parent. The normal CLI
  * passes nothing: it must not invent a path outside that parent. */
 readonly ownedRoot?:string;
 /** Optional verified local checkouts for declared GitHub dependencies, keyed by
  * package name. When absent the pipeline clones from the immutable coordinate. */
 readonly dependencyCheckouts?:Readonly<Record<string,string>>;
}

export interface NormalPipelineResult {
 readonly materialized:unknown;readonly materializedInput:object;readonly replay:unknown;
 readonly materializedView:ReturnType<typeof candidateServiceBuildMaterializedWorkspaceView>;
 readonly replayView:ReturnType<typeof candidateServiceWorkspaceReplayView>;
 readonly bunView:ReturnType<typeof candidateServiceBun142RuntimeView>;
 readonly stages:readonly string[];
 /** One-shot owner of the materialized workspace lifecycle. The caller MUST
  * call this after its last observation on `materialized`/`materializedView`;
  * calling it twice is a no-op. */
 readonly releaseMaterialized:()=>void;
}

const SAFE_NAME=/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

/** Derive the declared GitHub dependency coordinates from the immutable source
 * itself (package.json + bun.lock), never from caller fields. */
export function declaredGitDependencies(source:unknown){
 const view=derivedSourceView(source);need(view,'genuine immutable source required');
 const manifest=JSON.parse(view.readTracked('package.json').toString('utf8'));
 const lock=view.readTracked('bun.lock');
 const out:{name:string;repository:string;commit:string}[]=[];
 for(const field of ['dependencies','devDependencies','optionalDependencies'] as const){
  for(const [name,value] of Object.entries(manifest[field]??{})){
   if(typeof value!=='string'||!value.startsWith('github:'))continue;
   need(SAFE_NAME.test(name),'canonical declared dependency name');
   const match=/^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([a-f0-9]{40})$/u.exec(value);
   need(match,'complete immutable GitHub dependency declaration: '+name);
   need(lock.includes(Buffer.from(name+'@github:'+match[1]+'#'+match[2].slice(0,7)))||lock.includes(Buffer.from(name+'@github:'+match[1]+'#')),
    'declared dependency has no immutable lock coordinate: '+name);
   out.push(Object.freeze({name,repository:match[1]!,commit:match[2]!}));
  }
 }
 return Object.freeze(out.sort((left,right)=>left.name<right.name?-1:left.name>right.name?1:0));
}

/** Clone one declared dependency into the owned scratch root and let the real
 * dependency-source issuer validate remote/commit/object graph. The clone is a
 * transport step: authority comes from the verified immutable coordinate. */
export function cloneDeclaredDependency(input:{repository:string;commit:string;directory:string;budget:{check():void;remainingMs():number}}){
 need(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository),'canonical dependency repository');
 need(/^[a-f0-9]{40}$/u.test(input.commit),'complete dependency commit');
 need(path.isAbsolute(input.directory),'absolute owned dependency directory');
 need(!fs.existsSync(input.directory),'absent owned dependency directory');
 input.budget.check();
 execFileSync('git',['clone','--quiet','--no-checkout','--filter=blob:none','https://github.com/'+input.repository+'.git',input.directory],{
  stdio:['ignore','pipe','pipe'],timeout:Math.max(1,Math.min(120000,Math.floor(input.budget.remainingMs())))});
 input.budget.check();
 execFileSync('git',['-C',input.directory,'checkout','--quiet','--detach',input.commit],{
  stdio:['ignore','pipe','pipe'],timeout:Math.max(1,Math.min(120000,Math.floor(input.budget.remainingMs())))});
 input.budget.check();
 return input.directory;
}

/** Build the pristine verifier workspace + App replay from the one acquisition.
 * Every stage is a real existing issuer; nothing is synthesized. */
export async function runCandidateServiceNormalPipeline(input:NormalPipelineInput):Promise<NormalPipelineResult>{
 need(input&&typeof input==='object','typed normal pipeline input required');
 const budget=input.budget;
 need(budget&&typeof budget==='object','one shared parent budget required');
 for(const name of ['check','remainingMs','reserveBytes','chargeReadBytes','remainingReadBytes','remainingOriginalBytes','reserveOriginalMaximum','settleOriginalReservation'])
  need(typeof (budget as unknown as Record<string,unknown>)[name]==='function','complete shared parent budget required: '+name);
 const native=nativeOriginalsView(input.originals),source=derivedSourceView(input.source);
 need(native&&source,'same issued native originals/immutable source required');
 need(native.originFacts.sourceSha===source.sourceSha,'native originals and immutable source are not the same commit');
 assertCollectedNativeOriginalCustody(input.originals);assertDerivedSourceCurrent(input.source,budget as never);
 const packOutput=candidateServiceFinalPackView(input.pack,input.originals,input.source);
 need(packOutput,'same issued completed pack view required');
 const selected=candidateServicePackSelectedInputView(input.pack,input.originals,input.source);
 need(selected,'same issued pack selected-input view required');
 const stages:string[]=[];
 // B1/S1: the allocated stage root owns the registry/bun/git/dependency
 // directories. These handles are declared OUTSIDE the staging try so the
 // materializer can consume them after a successful staging run.
 let registryOriginals:unknown[]=[];
 let registryStage:unknown;
 let bunRuntime:unknown;
 let bunView:ReturnType<typeof candidateServiceBun142RuntimeView>;
 let bunStage:unknown;
 let gitStage:unknown;
 const gitDependencies:{stage:object;dependencySource:unknown;originals:unknown;name:string}[]=[];
 // N1: the owned root is created as the FIRST statement INSIDE this protected
 // try, after every pre-allocation need() above. A failure in those needs (for
 // example an invalid pack view) therefore never creates a root at all, and any
 // later failure releases the root below. One allocator, one owner, no second
 // initialization.
 let stagingOwned:{root:string;release():void}|undefined;
 const releaseStaging=()=>{const owned=stagingOwned;stagingOwned=undefined;if(owned)owned.release();};
 try{
 // B1: ONE stage-root authority. Without a caller root the pipeline asks the
 // staging module for a unique owned root under its own canonical parent, so
 // every stage satisfies the unchanged `canonical isolated staging parent`
 // guard. The allocator owns exactly that root and this pipeline releases it.
 if(input.ownedRoot===undefined){
  stagingOwned=allocateCandidateServiceStagingRoot();
 }else{
  const provided=input.ownedRoot;
  need(path.isAbsolute(provided)&&fs.existsSync(provided)&&fs.realpathSync(provided)===provided,'canonical owned scratch root required');
  stagingOwned=Object.freeze({root:provided,release(){}});
 }
 const ownedRoot=stagingOwned.root;

 // 1. Registry layout originals from the ACTUAL selected source set.
 registryOriginals=[];
 for(const row of selected.list()){
  budget.check();
  need(SAFE_NAME.test(row.name)&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(row.version),'canonical selected registry coordinate');
  // `workspace` selections are the immutable workspace build inputs this stage
  // lays out. An `installed` selection is a post-pack runtime artifact and needs
  // the separately issued installed-source capability: refuse rather than
  // fabricate one.
  need(row.inputKind!=='installed','post-pack installed selection requires the separately issued installed source capability: '+row.name);
  registryOriginals.push(await observeCandidateServiceRegistryOriginal({
   originals:input.originals,source:input.source,pack:input.pack,name:row.name,version:row.version,
   sourceRoot:row.sourceRoot,budget:budget as never}));
  stages.push('registry-original:'+row.name+'@'+row.version);
 }
 // The materializer requires a genuine registry layout stage, so an empty
 // selected coordinate set is refused here with an explicit reason rather than
 // failing later inside materialize with a generic message.
 need(registryOriginals.length>0,'at least one immutable selected registry coordinate is required for the verifier workspace');
 registryStage=await stageCandidateServiceBuildRegistryLayout({
  source:input.source,originals:registryOriginals,directory:path.join(ownedRoot,'registry'),budget:budget as never});
 stages.push('registry-layout');

 // 2. The one official Bun artifact, staged for the executed verifier.
 const bunParent=budget as never;
 bunRuntime=await observeCandidateServiceBun142Runtime(`${process.platform}-${process.arch}` as 'darwin-arm64',bunParent);
 bunView=candidateServiceBun142RuntimeView(bunRuntime,bunParent);
 need(bunView,'same current official Bun capability required');
 bunStage=await stageCandidateServiceBuildBun({source:input.source,original:bunRuntime,directory:path.join(ownedRoot,'bun'),budget:bunParent});
 stages.push('official-bun:'+bunView.target+':'+bunView.executableSha256);

 // 3. Immutable source stage and every declared GitHub dependency.
 gitStage=await stageCandidateServiceBuildGit({source:input.source,directory:path.join(ownedRoot,'git'),budget:budget as never});
 stages.push('git-source');
 for(const dependency of declaredGitDependencies(input.source)){
  budget.check();
  const checkout=input.dependencyCheckouts?.[dependency.name]
   ??cloneDeclaredDependency({repository:dependency.repository,commit:dependency.commit,
     directory:path.join(ownedRoot,'dependency-'+dependency.name.replace(/[^a-z0-9._-]/giu,'_')),budget});
  const dependencySource=deriveCandidateServiceGitDependencySource({originals:input.originals,source:input.source,
   name:dependency.name,checkout,budget});
  const stage=await stageCandidateServiceBuildGitDependency({source:input.source,originals:input.originals,
   name:dependency.name,dependencySource,directory:path.join(ownedRoot,'dependency-stage-'+dependency.name.replace(/[^a-z0-9._-]/giu,'_')),budget:budget as never});
  gitDependencies.push({stage,dependencySource,originals:input.originals,name:dependency.name});
  stages.push('git-dependency:'+dependency.name+'@'+dependency.commit);
 }

 }catch(stagingError){
  // Partial-staging failure: release the stage root. Both failures are kept
  // (primary first), and cleanup-alone failure propagates its own raw error.
  const cleanupFailure=captureCleanup(releaseStaging);
  throw combinePrimaryAndCleanup(stagingError,cleanupFailure,'stage root release failed');
 }

 // 4. One pristine materialized workspace, observed once.
 const materializedInput={source:input.source,gitStage,registryStage,
  registryOriginals:Object.freeze([...registryOriginals]),bunStage,bunOriginal:bunRuntime,
  gitDependencies:Object.freeze(gitDependencies),budget};
 // A1: the materialized workspace owns real extracted scratch on disk and R
 // exposes `release():void` on its view (candidate-service-workspace-materialize
 // :36, impl :529 = closeParent() + owned.cleanup()). Hold the single release
 // callback and invoke it on SUCCESS and on EVERY throw, including a throw after
 // materialize but before this function returns, and partial-staging failure
 // (where nothing is owned yet and the callback is a no-op).
 let releaseMaterialized:(()=>void)|undefined;
 const releaseOnce=()=>{const run=releaseMaterialized;releaseMaterialized=undefined;if(run)run();};
 try{
  const materialized=await materializeCandidateServiceBuildWorkspace(materializedInput as never);
  const materializedView=candidateServiceBuildMaterializedWorkspaceView(materialized,materializedInput as never);
  need(materializedView,'fresh pristine materialized workspace required');
  // Exactly one owner of the release lifecycle for this workspace.
  need(typeof materializedView.release==='function','materialized workspace release contract required');
  let released=false;
  releaseMaterialized=()=>{
   if(released)return;
   released=true;
   try{materializedView.release();}
   finally{
    // The stage root (registry/bun/git/dependency) belongs to this same owned
    // lifecycle and is released once, after the materialized view.
    releaseStaging();
   }
  };
  stages.push('materialize');

  // 5. One App replay over that workspace, same pack and originals.
  const replay=await observeCandidateServiceWorkspaceReplay({source:input.source,originals:input.originals,
   pack:input.pack,materialized,materializedInput:materializedInput as never,budget:budget as never});
  const replayView=candidateServiceWorkspaceReplayView(replay,{source:input.source,originals:input.originals,
   pack:input.pack,materialized,materializedInput:materializedInput as never});
  need(replayView,'issued App replay capability required');
  replayView.assertCurrent();
  stages.push('replay');

  return Object.freeze({materialized,materializedInput:Object.freeze(materializedInput),replay,
   materializedView,replayView,bunView,stages:Object.freeze(stages),
   // The caller must consume the workspace during its observations and then
   // release; we never release behind a returned live view.
   releaseMaterialized:releaseOnce});
 }catch(error){
  // Any failure after (or during) materialization releases the owned workspace
  // and the stage root. A single cleanup thunk owns both, so they are never
  // released twice; primary + cleanup are both preserved.
  const cleanupFailure=captureCleanup(()=>{releaseOnce();releaseStaging();});
  throw combinePrimaryAndCleanup(error,cleanupFailure,'materialized release failed');
 }
}
