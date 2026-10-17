import { bindPublicationGateMaterials } from './publication-gate-materials';
import {compactCollectedSourceOriginals} from './artifact-collector';
import { preflightPublicationResources } from './publication-resource-preflight';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { GroupPreparationDispatcher, PublicationProductSelector } from '../../run-independent-publication';
import { acquireIndependentProductInput, type ArtifactAcquisitionInput } from '../../acquire-independent-product-input';
import { observeCliGitHubOrigin } from './github-origin';
import { collectAdmissionArtifact, collectRelatedAdmissionArtifact, collectRegistryPeerArtifact, collectedArtifactView } from './artifact-collector';
import { deriveAdmissionSource } from './source-context';
import { collectPublicationPeerInputPlan, publicationPeerInputPlanView, type PublicationPeerInputPlanCapability } from './peer-input-plan';
import { observeClientConsumer, observeCliConsumer } from './consumer-context';
import { observeRegistryArtifactIfPublished } from './registry-context';
import type { CollectedArtifactCapability } from './artifact-contract';
const fail = (message: string): never => { throw Error('Central publication group: ' + message); };

/** Selectors identify immutable products only. Versions, approval flags, local
 * source paths, tags and caller-picked policy never enter the acquisition plan. */
export function validatePublicationGroupSelectors(selectors: readonly PublicationProductSelector[]): void {
  if (!Array.isArray(selectors) || selectors.length < 1 || selectors.length > 14) fail('bounded immutable product selectors required');
  const selected = new Set<string>(); let sourceSha: string | undefined;
  for (const selector of selectors) {
    if (!selector || typeof selector !== 'object' || Object.keys(selector).some(key => !['module', 'target', 'sourceSha', 'runHeadSha', 'runId', 'runAttempt', 'artifactId', 'artifactSha256'].includes(key))) fail('unknown product selector field');
    if (!['client', 'cli', 'api', 'css', 'afs'].includes(selector.module) || !/^[a-f0-9]{40}$/u.test(selector.sourceSha)
      || !/^[a-f0-9]{40}$/u.test(selector.runHeadSha) || !/^[a-f0-9]{64}$/u.test(selector.artifactSha256)
      || ![selector.runId, selector.runAttempt, selector.artifactId].every(value => Number.isSafeInteger(value) && value > 0)) fail('exact immutable product coordinates required');
    if (['client', 'cli'].includes(selector.module) ? selector.target !== undefined : !/^(?:linux|darwin)-(?:x64|arm64)$/u.test(selector.target ?? '')) fail('canonical product target required');
    if (sourceSha !== undefined && sourceSha !== selector.sourceSha) fail('one immutable source per publication group required');
    sourceSha = selector.sourceSha;
    const key = selector.module + ':' + (selector.target ?? 'portable');
    if (selected.has(key)) fail('duplicate product selector'); selected.add(key);
  }
}

import {validatePublicationConsumerRuns,type PublicationConsumerRunLocator} from './consumer-run-locators';
import {observeArchiveInstalledProductConsumer,observeGitHubArchiveProductConsumer,observeGitHubRegistryInstalledProductConsumer} from './consumer-context';
import {verifyCollectedPublicationAdmission,collectedPublicationSourceMaterials} from './index';
import {collectPublicationLegalMaterials} from './publication-legal-materials';
import {publicationMaterialView} from './artifact-collector';

export type PublicationGroupPreparationInput=Parameters<NonNullable<GroupPreparationDispatcher['preparePublicationGroup']>>[0]&{
 readonly consumerRuns?:readonly PublicationConsumerRunLocator[];
};
interface PreparationSession {
 portable?:{cli:CollectedArtifactCapability;client:CollectedArtifactCapability;source:ReturnType<typeof deriveAdmissionSource>};
 peerPlan?:PublicationPeerInputPlanCapability;
 requests:Map<string,CollectedArtifactCapability>;
}
/** Acquire and qualify one normal product at a time. Missing original axes stop
 * before another multi-GiB source snapshot is acquired. Consumer locators are
 * re-observed, never restored as permits from a previous process. */
export async function preparePublicationGroup(input:PublicationGroupPreparationInput):Promise<import('../../run-independent-publication').GroupPreparationResult>{
 validatePublicationGroupSelectors(input.selectors);
 validatePublicationConsumerRuns(input.consumerRuns??[],input.selectors[0]!.sourceSha);
 if(!path.isAbsolute(input.checkout)||!path.isAbsolute(input.output)||fs.existsSync(input.output))fail('canonical checkout and new absolute output required');
 fs.mkdirSync(input.output,{mode:0o700});
 const resources=await preflightPublicationResources({selectors:input.selectors,output:input.output,token:input.token,reservationDirectory:fs.realpathSync(os.tmpdir())});
 if(resources.status==='pending')return {status:'pending',pending:resources.pending};
 const session:PreparationSession={requests:new Map()},products:import('./publication').ProductGroupPublicationInput['products'][number][]=[],registryDependencies:{artifact:CollectedArtifactCapability;registry:NonNullable<Awaited<ReturnType<typeof observeRegistryArtifactIfPublished>>>}[]=[];
 const selectedNames=new Set<string>(),portableReady=new Set<CollectedArtifactCapability>();
 const pending=(selector:PublicationProductSelector,reasons:readonly string[])=>({status:'pending' as const,pending:reasons.map(reason=>selector.module+'/'+(selector.target??'portable')+': '+reason)});
 for(const [index,selector] of input.selectors.entries()){
  const prepared=await prepareRegistryConsumerProductInSession({...input,module:selector.module,target:selector.target,output:path.join(input.output,'product-'+index)},session);
  if(prepared.status==='pending')return pending(selector,prepared.pending);
  const artifact=prepared.artifact,source=deriveAdmissionSource(artifact,input.checkout),view=collectedArtifactView(artifact)!;
  selectedNames.add(view.identity.package);
  const related=[...new Set([session.portable?.cli,session.portable?.client,prepared.client,...prepared.peers,...prepared.dependencies].filter(value=>value!==undefined&&value!==artifact))];
  const base={artifact,derivedSource:source,relatedArtifacts:related};
  const sourceReport=verifyCollectedPublicationAdmission('source',base);
  if(sourceReport.status!=='verified')return pending(selector,[sourceReport.reason]);
  const sourceMaterials=collectedPublicationSourceMaterials(artifact,source);
  const legal=await collectPublicationLegalMaterials({artifact,source,legalSourceMaterials:sourceMaterials});
  let nativeMaterials:Awaited<ReturnType<typeof prepareNormalProductNativeContext>>|undefined;
  const nativePending:string[]=[];
  if(view.identity.target!==undefined){
   try{nativeMaterials=await prepareNormalProductNativeContext({artifact,source,output:path.join(input.output,'native-'+index),token:input.token});}
   catch(error){nativePending.push(error instanceof Error?error.message:'native original collection failed');}
  }
  const nativeReport=view.identity.target===undefined?undefined:verifyCollectedPublicationAdmission('native',{...base,nativeMaterials});
  const legalReport=verifyCollectedPublicationAdmission('legal',{...base,legalOriginals:legal.originals,legalSourceMaterials:sourceMaterials});
  const gaps=[...nativePending,...(!nativeReport||nativeReport.status==='verified'?[]:[nativeReport.reason]),...(legalReport.status==='verified'?[]:[legalReport.reason]),...legal.pending];
  if(gaps.length)return pending(selector,gaps);
  const pre=input.consumerRuns?.find(row=>row.module===selector.module&&row.target===selector.target&&row.stage==='prepublish');
  const materials={artifact,client:prepared.client,peers:[...prepared.peers],dependencies:[...prepared.dependencies],peerPlan:prepared.peerPlan};
  const evidenceDirectory=path.join(input.output,'pre-consumer-'+index);
  if(!pre&&view.identity.target!==undefined)return pending(selector,['Matching-host archive consumer immutable original locator required']);
  const prepublishConsumer=pre?await observeGitHubArchiveProductConsumer({...materials,consumerRun:pre.consumerRun,evidenceDirectory,token:input.token})
   :await observeArchiveInstalledProductConsumer({...materials,stage:'prepublish',evidenceDirectory});
  const runtimeReport=verifyCollectedPublicationAdmission('runtime-closure',{...base,consumerObservation:prepublishConsumer});
  if(runtimeReport.status!=='verified')return pending(selector,[runtimeReport.reason]);
  const registry=await observeRegistryArtifactIfPublished(artifact);
  const post=input.consumerRuns?.find(row=>row.module===selector.module&&row.target===selector.target&&row.stage==='postpublish');
  const postpublishConsumer=post?await observeGitHubRegistryInstalledProductConsumer({...materials,consumerRun:post.consumerRun,
   evidenceDirectory:path.join(input.output,'post-consumer-'+index),token:input.token}):undefined;
  bindPublicationGateMaterials(artifact,source,{relatedArtifacts:related,legalOriginals:legal.originals,legalSourceMaterials:sourceMaterials,nativeOriginals:nativeMaterials?nativeOriginalBindings.get(nativeMaterials as object):undefined});
  const finalContext={...base,consumerObservation:prepublishConsumer,nativeMaterials,legalOriginals:legal.originals,legalSourceMaterials:sourceMaterials};
  for(const gate of (view.identity.target===undefined?['source','runtime-closure','legal','consumer']:['source','runtime-closure','native','legal','consumer']) as readonly import('./index').Gate[]){
   const report=verifyCollectedPublicationAdmission(gate,finalContext);
   if(report.status!=='verified')return pending(selector,[report.reason]);
  }
  if(view.identity.target!==undefined){
   const {compactModuleSourceMaterials}=await import('./module-source-admission');
   compactModuleSourceMaterials(sourceMaterials);compactCollectedSourceOriginals(artifact);
   if(nativeMaterials){const original=nativeOriginalBindings.get(nativeMaterials as object);if(original){const {compactCollectedNativeOriginals}=await import('./native-original-collector');compactCollectedNativeOriginals(original);}}
  }else{
   portableReady.add(artifact);
   if(session.portable&&portableReady.has(session.portable.cli)&&portableReady.has(session.portable.client)){
    const cleanup=await import('./source-execution') as typeof import('./source-execution')&{compactPortableSourceMaterials?:(artifact:unknown)=>void};
    if(!cleanup.compactPortableSourceMaterials)fail('Reviewed portable source cleanup adapter required');
    cleanup.compactPortableSourceMaterials!(session.portable.cli);
    compactCollectedSourceOriginals(session.portable.cli);compactCollectedSourceOriginals(session.portable.client);
   }
  }
  products.push(Object.freeze({...materials,source,prepublishConsumer,nativeMaterials,...(registry?{registry}:{}),...(postpublishConsumer?{postpublishConsumer}:{})}));
 }
 for(const artifact of session.requests.values()){
  const view=collectedArtifactView(artifact)!;if(selectedNames.has(view.identity.package))continue;
  const observation=await observeRegistryArtifactIfPublished(artifact);if(!observation)return {status:'pending',pending:['Exact immutable-lock dependency disappeared from registry: '+view.identity.package]};
  registryDependencies.push({artifact,registry:observation});
 }
 // If CLI/client are tool dependencies outside this selected cohort, bind their
 // current registry originals as well. They are never fabricated version rows.
 for(const artifact of session.portable?[session.portable.cli,session.portable.client]:[]){
  const view=collectedArtifactView(artifact)!;if(selectedNames.has(view.identity.package))continue;
  const observation=await observeRegistryArtifactIfPublished(artifact);if(!observation)return {status:'pending',pending:['Exact public consumer tool must be selected or already in registry: '+view.identity.package]};registryDependencies.push({artifact,registry:observation});
 }
 return Object.freeze({status:'material-ready',products:Object.freeze(products),registryDependencies:Object.freeze(registryDependencies)});
}
const nativeOriginalBindings=new WeakMap<object,unknown>();
async function prepareNormalProductNativeContext(input:{artifact:CollectedArtifactCapability;source:ReturnType<typeof deriveAdmissionSource>;output:string;token?:string}){
 const material=publicationMaterialView(input.artifact)!;
 const {collectNativeAdmissionContext}=await import('./native-context');
 let nativeOriginals:unknown;
 if(material.identity.package.startsWith('@undefineds.co/xpod-css-')){
  const receipt=JSON.parse(material.readOriginal(material.producerReceipt.path,8*1024**2).toString());
  const acquisition=receipt.nativeAcquisition,zip=acquisition?.originals?.find((row:any)=>row.path==='originals/native.zip');
  if(!zip||!Number.isSafeInteger(acquisition.artifactId)||!/^[a-f0-9]{64}$/u.test(zip.sha256))fail('CSS independent native original locator missing');
  const tuple:ArtifactAcquisitionInput={schemaVersion:1,sourceSha:material.identity.sourceSha,runHeadSha:material.producer.runHeadSha,
    runId:material.producer.runId,runAttempt:material.producer.runAttempt,artifactId:acquisition.artifactId,artifactSha256:zip.sha256};
  const {observeQleverNativeGitHubOrigin}=await import('./github-origin');
  const origin=await observeQleverNativeGitHubOrigin(tuple,material.identity.target!,'css-module',{token:input.token});
  const {acquireNativeAdmissionOriginals}=await import('../../acquire-independent-product-input');
  const {collectNativeAdmissionOriginals}=await import('./native-original-collector');
  fs.mkdirSync(input.output,{mode:0o700});const acquisitionRoot=path.join(input.output,'acquired');
  const resources=await preflightPublicationResources({selectors:[tuple],output:input.output,token:input.token});
  if(resources.status==='pending')fail(resources.pending.join('; '));
  await acquireNativeAdmissionOriginals(tuple,acquisitionRoot,{token:input.token});
  nativeOriginals=await collectNativeAdmissionOriginals({githubOrigin:origin,acquisitionRoot});
 }
 const context=await collectNativeAdmissionContext({artifact:input.artifact,source:input.source,nativeOriginals});
 if(nativeOriginals)nativeOriginalBindings.set(context as object,nativeOriginals);
 return context;
}

export interface RegistryConsumerProductPreparationInput {
  readonly selectors: readonly PublicationProductSelector[];
  readonly module: 'client' | 'cli' | 'api' | 'css' | 'afs';
  readonly target?: string;
  readonly checkout: string;
  readonly output: string;
  readonly token?: string;
}
export interface RegistryConsumerProductMaterials {
  readonly status: 'material-ready';
  readonly peerPlan: PublicationPeerInputPlanCapability;
  readonly artifact: CollectedArtifactCapability;
  readonly client?: CollectedArtifactCapability;
  readonly peers: readonly CollectedArtifactCapability[];
  readonly dependencies: readonly CollectedArtifactCapability[];
}
export type RegistryConsumerProductPreparationResult = RegistryConsumerProductMaterials | { readonly status: 'pending'; readonly pending: readonly string[] };
/** Material-only bootstrap for a single matching-host registry worker. It does
 * not execute any consumer, native probe, publisher or gate and issues no permit. */
export async function prepareRegistryConsumerProduct(input:RegistryConsumerProductPreparationInput):Promise<RegistryConsumerProductPreparationResult>{
 return prepareRegistryConsumerProductInSession(input,{requests:new Map()});
}
async function prepareRegistryConsumerProductInSession(input: RegistryConsumerProductPreparationInput,session:PreparationSession): Promise<RegistryConsumerProductPreparationResult> {
  validatePublicationGroupSelectors(input.selectors);
  const selector = input.selectors.find(row => row.module === input.module && row.target === input.target);
  if (!selector) return { status: 'pending', pending: ['Selected consumer product is absent from immutable group'] };
  if (!path.isAbsolute(input.checkout) || !path.isAbsolute(input.output) || fs.existsSync(input.output)) fail('absolute clean checkout and new material output required');
  const checkout = fs.realpathSync(input.checkout);
  const git = (args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
  if (git(['rev-parse', 'HEAD']) !== selector.sourceSha || git(['status', '--porcelain', '--untracked-files=all'])) fail('clean exact source checkout required');
  const portable = input.selectors.find(row => row.module === 'cli') ?? input.selectors.find(row => row.module === 'client');
  if (!portable) return { status: 'pending', pending: ['Normal CLI/client producer selector required for fixed registry consumer'] };
  const tuple = (row: PublicationProductSelector): ArtifactAcquisitionInput => ({ schemaVersion: 1, sourceSha: row.sourceSha,
    runHeadSha: row.runHeadSha, runId: row.runId, runAttempt: row.runAttempt, artifactId: row.artifactId, artifactSha256: row.artifactSha256 });
  const portablePair = input.selectors.filter(row => ['cli', 'client'].includes(row.module));
  if (portablePair.some(row => JSON.stringify(tuple(row)) !== JSON.stringify(tuple(portable)))) fail('normal CLI/client selectors must bind one real producer artifact');
  fs.mkdirSync(input.output, { mode: 0o700 });
  const custody = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xpod-central-consumer-materials-')); fs.chmodSync(custody, 0o700);
  fs.writeFileSync(path.join(input.output, 'custody-locator.json'), JSON.stringify({ directory: custody, sourceSha: selector.sourceSha }) + '\n', { flag: 'wx', mode: 0o600 });
  const required=[...(!session.portable?[portable]:[]),...(['api','css','afs'].includes(input.module)?[selector]:[])];
  if(required.length){const resources=await preflightPublicationResources({selectors:required,output:custody,token:input.token});if(resources.status==='pending')return {status:'pending',pending:resources.pending};}
  let portableMaterials=session.portable;
  if(!portableMaterials){
  const origin = await observeCliGitHubOrigin(tuple(portable), { token: input.token });
  const acquisitionRoot = path.join(custody, 'portable-acquired'), projectionOutput = path.join(custody, 'portable-projected');
  await acquireIndependentProductInput(tuple(portable), acquisitionRoot, { token: input.token });
  const cli = await collectAdmissionArtifact({ githubOrigin: origin, acquisitionRoot, projectionOutput, product: 'cli' });
  const client = collectRelatedAdmissionArtifact(cli, 'client');
  const source = deriveAdmissionSource(cli, checkout); deriveAdmissionSource(client, checkout);
    portableMaterials={cli,client,source};session.portable=portableMaterials;
  }
  const {cli,client,source}=portableMaterials;
  let artifact = input.module === 'client' ? client : cli;
  if (input.module === 'api' || input.module === 'css' || input.module === 'afs') {
    const { observeModuleProductGitHubOrigin, observeAfsModuleProductGitHubOrigin } = await import('./github-origin');
    const { collectModuleAdmissionArtifact } = await import('./artifact-collector');
    const moduleOrigin = input.module === 'afs'
      ? await observeAfsModuleProductGitHubOrigin(tuple(selector), input.target!, { token: input.token })
      : await observeModuleProductGitHubOrigin(tuple(selector), input.module, input.target!, { token: input.token });
    const acquired = path.join(custody, 'module-acquired');
    await acquireIndependentProductInput(tuple(selector), acquired, { token: input.token });
    artifact = await collectModuleAdmissionArtifact({ module: input.module, githubOrigin: moduleOrigin,
      acquisitionRoot: acquired, projectionOutput: path.join(custody, 'module-projected') });
    deriveAdmissionSource(artifact, checkout);
  }
  const peerPlan = session.peerPlan??collectPublicationPeerInputPlan({ cli, client, source }), plan = publicationPeerInputPlanView(peerPlan)!;session.peerPlan=peerPlan;
  const reachable = new Set(input.module === 'client' ? ['client'] : ['cli', 'client']);
  const requestKeys = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of plan.edges) if (reachable.has(edge.from) && edge.version) {
      requestKeys.add(edge.package + '@' + edge.version);
      if (edge.lockKey && !reachable.has(edge.lockKey)) { reachable.add(edge.lockKey); changed = true; }
    }
  }
  const selectedRequests = plan.requests.filter(request => requestKeys.has(request.requestKey));
  // Registry peers are retained as private Buffers by the existing collector;
  // they allocate no acquisition ZIP on disk. Their later installed/materialized
  // writes are inside the separately reserved fixed 2GiB consumer phase.
  const peerPending=selectedRequests.filter(request=>!session.requests.has(request.requestKey));
  const peerDisk=fs.statfsSync(custody,{bigint:true});
  if(peerDisk.bavail*peerDisk.bsize<BigInt(2*1024**3+2*1024**3))return {status:'pending',pending:['publication-peer-consumer-disk-insufficient: fixed consumer phase plus 2GiB floor required']};
  fs.writeFileSync(path.join(input.output,'registry-peer-resource-plan.json'),JSON.stringify({kind:'private-registry-buffer-reservation',
    requests:peerPending.map(row=>({package:row.package,version:row.version,integrity:row.integrity})),
    maximumPackedResidentBytes:peerPending.length*8*1024**2,acquisitionDiskBytes:0,
    consumerWriteReservationBytes:2*1024**3,scope:'bounded private Buffer downloads, not observed actual tarball sizes; fixed consumer write phase reserved separately'})+'\n',{flag:'wx',mode:0o400});
  const handles = new Map<string, CollectedArtifactCapability>();
  for (const request of selectedRequests){let artifact=session.requests.get(request.requestKey);if(!artifact){artifact=await collectRegistryPeerArtifact({plan:peerPlan,requestKey:request.requestKey});session.requests.set(request.requestKey,artifact);}handles.set(request.requestKey,artifact);}
  fs.writeFileSync(path.join(input.output,'registry-peer-resources.actual.json'),JSON.stringify({
    artifacts:[...handles.values()].map(value=>{const row=collectedArtifactView(value)!;return {package:row.identity.package,version:row.identity.version,archiveBytes:row.identity.archiveBytes,sha256:row.identity.archiveSha256,integrity:row.identity.integrity};}),
    scope:'actual privately retained registry peer bytes; no additional filesystem acquisition copy'})+'\n',{flag:'wx',mode:0o400});
  const rootRoles = input.module === 'client' ? ['client'] : ['cli', 'client'];
  const peerKeys = new Set(plan.edges.filter(edge => edge.kind === 'peer' && rootRoles.includes(edge.from))
    .map(edge => edge.package + '@' + edge.version));
  const peers = [...handles].filter(([key]) => peerKeys.has(key)).map(([, handle]) => handle);
  const dependencies = [...handles].filter(([key]) => !peerKeys.has(key)).map(([, handle]) => handle);
  const { bindPublicationConsumerPeerPlan } = await import('./consumer-context');
  bindPublicationConsumerPeerPlan(artifact, peerPlan);
  return Object.freeze({ status: 'material-ready', peerPlan, artifact, ...(input.module === 'client' ? {} : { client }), peers: Object.freeze(peers),
    dependencies: Object.freeze(input.module === 'api' || input.module === 'css' || input.module === 'afs' ? [cli, client, ...dependencies] : dependencies) });
}
