import {inspectReviewedSdkOuterExecutorOrigin,type QleverSdkOuterExecutorOriginAuthority} from './qlever-sdk-outer-authority';
import {QLEVER_SDK_WORKFLOW,QLEVER_SDK_WORKFLOW_SHA,QLEVER_SDK_EXECUTION_GROUPS,QLEVER_LINUX_EXECUTION_GROUPS,QLEVER_READONLY_SDK_WORKFLOW_SHA,QLEVER_SERVICE_SDK_WORKFLOW_SHA,QLEVER_CURRENT_SDK_WORKFLOW_SHA} from './qlever-sdk-origin-policy';
import {acquireOwnedSecondaryBindings,selectGitHubSourceBindingGroup,secondaryGitHubSourceBindingSelectors,sourceBindingKey,type GitHubSourceBindingGroup} from './github-source-binding-groups';
import {immutableGitContentsEndpoint,cachedGitContentsOriginal,retainGitContentsOriginal} from './github-immutable-original-cache';
import {QLEVER_LINUX_SOURCE_BINDINGS} from './qlever-linux-origin-policy';
import {QLEVER_OBSERVER_PATH,QLEVER_OBSERVER_V20,QLEVER_OBSERVER_V22,QLEVER_OBSERVER_V23,qleverObserverCompanionBindings} from './qlever-observer-policy';
import { CLI_SOURCE_POLICY } from './source-rules';
import { registryConsumerArtifactName } from './registry-consumer-originals';
import { archiveConsumerArtifactName } from './archive-consumer-originals';
import { CONSUMER_SOURCE_GROUPS, CI_CONSUMER_SOURCE_GROUPS, CI_PUBLICATION_WORKFLOW_SHA, CALLABLE_PUBLICATION_WORKFLOW_SHA, STAGING_CHECKED_PUBLICATION_WORKFLOW_SHA } from './consumer-observer-policy';
import { createHash } from 'node:crypto';
import { CLI_PRODUCT_WORKFLOW, cliPublicationArtifactNames, type ArtifactAcquisitionInput } from '../../acquire-independent-product-input';
import { productTarget } from '../../module-product-targets';
import { MODULE_TARGETS } from '../../../packages/xpod-cli/src/module-catalog';
import {candidateServiceNativeRuntimeArtifactName} from './candidate-service-native-runtime-contract';

declare const originBrand: unique symbol;
/** Only the controlled observers below can issue this in-process capability. */
export interface GitHubOriginObservation { readonly [originBrand]: true }
export interface GitHubOriginFacts {
  readonly sdkOuterExecutorAuthority?:QleverSdkOuterExecutorOriginAuthority;
  readonly repository: 'undefinedsco/xpod';
  readonly workflowPath: string;
  readonly workflowSourceSha256: string;
  readonly sourceSha: string;
  readonly runHeadSha: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly artifactId: number;
  readonly artifactSha256: string;
  readonly producerJobId: number;
  readonly target?: string;
  readonly scope: 'github-api-run-workflow-artifact-observation-only';
  readonly originals: readonly { name: string; endpoint: string; sha256: string; bytes: number }[];
}
type Original = { name: string; endpoint: string; data: Buffer };
const nativeOrigins = new WeakSet<object>();
const sdkOrigins = new WeakSet<object>();
const candidateServiceOrigins = new WeakSet<object>();
const candidateServiceNativeRuntimeOrigins = new WeakSet<object>();
export function isCandidateServiceImageGitHubOrigin(value:unknown):value is GitHubOriginObservation {return value!==null&&typeof value==='object'&&candidateServiceOrigins.has(value);}
export function isCandidateServiceNativeRuntimeGitHubOrigin(value:unknown):value is GitHubOriginObservation {return value!==null&&typeof value==='object'&&candidateServiceNativeRuntimeOrigins.has(value);}
export function isQleverSdkGitHubOrigin(value:unknown):value is GitHubOriginObservation {return value!==null&&typeof value==='object'&&sdkOrigins.has(value);}
const normalModuleOrigins = new WeakSet<object>();
export function isRoutedCssProductGitHubOrigin(value:unknown):value is GitHubOriginObservation {
 const facts=value!==null&&typeof value==='object'?issued.get(value)?.facts:undefined;
 return Boolean(facts&&normalModuleOrigins.has(value as object)&&facts.workflowPath===CSS_NATIVE_PRODUCTS_WORKFLOW&&[CSS_NATIVE_PARENT_SHA,CSS_STAGING_PARENT_SHA].includes(facts.workflowSourceSha256));
}
/** Issuer purpose is private; matching a workflow string cannot turn a normal
 * CSS product observation into an independently observed native artifact. */
export function isNativeGitHubOrigin(value:unknown):value is GitHubOriginObservation {
  return value!==null && typeof value==='object' && nativeOrigins.has(value);
}
const issued = new WeakMap<object, { facts: GitHubOriginFacts; originals: Original[] }>();
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => { throw new Error('Independent GitHub origin: ' + message); };
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const repository = 'undefinedsco/xpod' as const;
const api = 'https://api.github.com/repos/' + repository + '/';

export function githubOriginFacts(value: unknown): GitHubOriginFacts | undefined {
  return value !== null && typeof value === 'object' ? issued.get(value)?.facts : undefined;
}
/** Copies actual API originals; caller mutation cannot change issued facts. */
export function githubOriginOriginals(value: GitHubOriginObservation): Original[] {
  const entry = issued.get(value);
  if (!entry) return fail('unknown observation capability');
  return entry.originals.map(row => ({ ...row, data: Buffer.from(row.data) }));
}

/** GitHub API truncates implicit matrix job display names to 100 characters.
 * Only the exact reviewed name or its exact observed representation matches;
 * arbitrary prefixes and caller-selected names are never policy. */
export function matchesObservedJobName(actual: unknown, expected: string): boolean {
  return actual === expected || (expected.length > 100 && actual === expected.slice(0, 97) + '...');
}

/** Fixed HTTPS transport and code-reviewed workflow policy. No transport callback,
 * caller workflow allowlist or serialized observation can grant this authority.
 * This does not download a product or attest the builder's actual checkout. */
interface OriginPolicy {
  sourceBindingGroups?:readonly GitHubSourceBindingGroup[];
  workflowPath: string;
  workflowSha256: string;
  reviewedWorkflowVersions?: readonly { workflowSha256: string; jobName(artifactName: string): string; sourceBindingGroups?:readonly GitHubSourceBindingGroup[]; sourceBindings?: readonly { path: string; sha256: string; reviewedSha256?: readonly string[]; ref?:'run-head' }[] }[];
  events: readonly string[];
  stagingPushWorkflowSha256?: string;
  stagingPushWorkflowSha256s?: readonly string[];
  artifactNames(input: ArtifactAcquisitionInput): readonly string[];
  jobName(artifactName: string): string;
  jobNames?(artifactName:string):readonly string[];
  sourceGroupJobContract?(group:GitHubSourceBindingGroup|undefined):Readonly<{name:string;requiredStep:string;requiredSteps:readonly string[]}>;
  maximumJobPages?:number;
  allowRunningRun?:true;
  /** Candidate producer roles only. A completed-failure OVERALL run is still
   * accepted for observation, but the issuer's existing same-attempt producer
   * job/step/artifact/source/ancestor closure below remains mandatory before
   * any observation capability is issued. It never grants RC qualification. */
  allowCandidateProducerFailure?:true;
  requiredBranch?: string;
  sourceMayDiffer?:true;
  workflowRef?:'run-head';
  requiredStep: string;
  requiredSteps?: readonly string[];
  requiredAncestorJobs?: readonly string[];
  sourceGroupAncestorJobs?(group:GitHubSourceBindingGroup|undefined):readonly string[];
  issueSdkOuterAuthority?:true;
  target?: string;
  sourceBindings?: readonly { path: string; sha256: string; reviewedSha256?: readonly string[]; ref?:'run-head' }[];
}
/** Same issuer, independently authenticated candidate image-artifact role.
 * A producer JSON selector cannot enroll a source tree in this role. */
export async function observeCandidateServiceImageGitHubOrigin(input:ArtifactAcquisitionInput,options:{token?:string}={}):Promise<GitHubOriginObservation> {
 const groups=QLEVER_SDK_EXECUTION_GROUPS.filter(group=>group.candidateServiceRelationship!==undefined);
 if(!groups.length)throw Error('Independent GitHub origin: candidate service source recipe not reviewed');
 const versions=[...new Set(groups.map(group=>group.candidateServiceRelationship!.workflowSha256))];
 const artifactNames=(value:ArtifactAcquisitionInput)=>['candidate-service-image-originals-'+value.sourceSha+'-'+value.runId+'-'+value.runAttempt];
 const result=await observeGitHubOrigin(input,options,{
  workflowPath:'.github/workflows/candidate.yml',workflowSha256:versions[0]!,reviewedWorkflowVersions:versions.map(workflowSha256=>({workflowSha256,jobName:()=> 'build_image',sourceBindingGroups:groups})),
  events:['push','workflow_dispatch'],requiredBranch:'staging',stagingPushWorkflowSha256s:versions,allowRunningRun:true,allowCandidateProducerFailure:true,workflowRef:'run-head',sourceBindingGroups:groups,target:'linux-x64',
  artifactNames,jobName:()=> 'build_image',requiredStep:'Retain candidate service image/SDK originals',requiredSteps:['Apply candidate root version','Build and push RC image','Retain candidate service image/SDK originals','Upload candidate service image originals'],
  sourceGroupJobContract(group){const contract=group?.candidateServiceRelationship;if(!contract||contract.schemaVersion!==1||contract.workflowPath!=='.github/workflows/candidate.yml'||!versions.includes(contract.workflowSha256))throw Error('Independent GitHub origin: exact candidate service contract missing');return {name:contract.serviceJob,requiredStep:'Retain candidate service image/SDK originals',requiredSteps:['Apply candidate root version','Build and push RC image','Retain candidate service image/SDK originals','Upload candidate service image originals']};},
  sourceGroupAncestorJobs(group){const contract=group?.candidateServiceRelationship;if(!contract)throw Error('Independent GitHub origin: candidate service ancestor contract missing');return [contract.sdkJob,contract.localRuntimeJob];},
 });
 nativeOrigins.add(result);candidateServiceOrigins.add(result);return result;
}
/** A separate original-byte role for the focused local-runtime producer. The
 * service image and SDK roles cannot substitute for this same-job artifact. */
export async function observeCandidateServiceNativeRuntimeGitHubOrigin(input:ArtifactAcquisitionInput,options:{token?:string}={}):Promise<GitHubOriginObservation> {
 const groups=QLEVER_SDK_EXECUTION_GROUPS.filter(group=>group.candidateServiceRelationship!==undefined);
 if(!groups.length)throw Error('Independent GitHub origin: candidate native runtime source recipe not reviewed');
 const versions=[...new Set(groups.map(group=>group.candidateServiceRelationship!.workflowSha256))];
 const steps=['Publish and resolve the immutable digest','Retain focused native runtime originals','Upload focused native runtime originals'];
 const result=await observeGitHubOrigin(input,options,{
  workflowPath:'.github/workflows/candidate.yml',workflowSha256:versions[0]!,reviewedWorkflowVersions:versions.map(workflowSha256=>({workflowSha256,jobName:()=> 'publish_qlever_local_runtime / publish',sourceBindingGroups:groups})),
  events:['push','workflow_dispatch'],requiredBranch:'staging',stagingPushWorkflowSha256s:versions,allowRunningRun:true,allowCandidateProducerFailure:true,workflowRef:'run-head',sourceBindingGroups:groups,target:'linux-x64',
  artifactNames:value=>[candidateServiceNativeRuntimeArtifactName(value)],jobName:()=> 'publish_qlever_local_runtime / publish',requiredStep:steps[1]!,requiredSteps:steps,
  sourceGroupJobContract(group){const contract=group?.candidateServiceRelationship;if(!contract||contract.schemaVersion!==1||contract.workflowPath!=='.github/workflows/candidate.yml'||!versions.includes(contract.workflowSha256))throw Error('Independent GitHub origin: exact candidate native runtime contract missing');return {name:contract.localRuntimeJob,requiredStep:steps[1]!,requiredSteps:steps};},
  sourceGroupAncestorJobs(group){const contract=group?.candidateServiceRelationship;if(!contract)throw Error('Independent GitHub origin: candidate native runtime SDK ancestor contract missing');return [contract.sdkJob];},
 });
 nativeOrigins.add(result);candidateServiceNativeRuntimeOrigins.add(result);return result;
}
export async function observeCliGitHubOrigin(input: ArtifactAcquisitionInput, options: { token?: string } = {}): Promise<GitHubOriginObservation> {
  return observeGitHubOrigin(input, options, {
    workflowPath: CLI_PRODUCT_WORKFLOW, workflowSha256:CLI_SOURCE_POLICY.workflow,
    stagingPushWorkflowSha256:CLI_SOURCE_POLICY.workflow,
    reviewedWorkflowVersions:[{workflowSha256:'c856baf24a28fe789db1e80c26e7b69b7e4e08bd0923f52ce376840ac885c1eb',jobName:name=>`normal-publication (${name.startsWith('xpod-cli-publication-preparation-macOS-')?'macos-latest':'ubuntu-latest'})`},
      {workflowSha256:'b9bc591d5248773fae30df574a95e1ee928dffc41ad5965a8fbc8bf90319d860',
      jobName:name=>`standalone-cli (${name.startsWith('xpod-cli-publication-preparation-macOS-')?'macos-latest':'ubuntu-latest'})`},
      {workflowSha256:'50576f056ba617e9153afc0d385a06a830696e3703e6ad624d1e8a8ad46af22c',
        jobName:name=>`standalone-cli (${name.startsWith('xpod-cli-publication-preparation-macOS-')?'macos-latest':'ubuntu-latest'})`}],
    events: ['workflow_dispatch', 'pull_request', 'push'],
    artifactNames: row => cliPublicationArtifactNames({ expectedSourceSha: row.sourceSha, runId: row.runId, runAttempt: row.runAttempt }),
    jobName: name => `normal-publication (${name.startsWith('xpod-cli-publication-preparation-macOS-') ? 'macos-latest' : 'ubuntu-latest'})`,
    requiredStep: 'Build normal CLI publication preparation',
  });
}

export const CSS_NATIVE_PRODUCTS_WORKFLOW='.github/workflows/css-native-products.yml';
const CSS_NATIVE_PARENT_SHA='8312031501f9f0d640e100ddec75e0fe1150d0ee93812b3f8c6785b032319c0f';
const CSS_STAGING_PARENT_SHA='601aa8fe01ee1367be4e97dc6e868d7bc3e79ed1fea5e8f9531aa759e78d7d51';
/** Complete controlled native producer/stage/pack direct implementation tuple.
 * Selected only by its exact workflow; historical runs never request new files. */
export const API_CONTROLLED_SOURCE_BINDINGS=Object.freeze([
  {
    "path": "packages/xpod-api/package.json",
    "sha256": "0176c10141dbdd675e2a9741787fd1d56b5e811a5951e0dd3d056ff949e60576"
  },
  {
    "path": "packages/xpod-api/scripts/bun-build-api.ts",
    "sha256": "260024d8fa42a81cc10ef7601bed0efc1a3657981e28fc20bf25274db1fbb4e8"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-products.ts",
    "sha256": "3a24864c1e1d542295a997d8a9de7814283de0cf6a6f233d3fab48f1c42fd516"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-runtime.ts",
    "sha256": "a542b95f7979049a6c2686f79ea80cb05d13251903c71b3d9fe54523e46093e6"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-stage.ts",
    "sha256": "e571128914a1c6d4db22fab9cb51743fc4af5d061ca7903f84c193a22bf8f505"
  },
  {
    "path": "packages/xpod-api/scripts/closure.ts",
    "sha256": "a06dce89cf832f574295794f4e830cca2d0abefc2553e5c7ec188614a91f2090"
  },
  {
    "path": "packages/xpod-api/scripts/controlled-native-material.ts",
    "sha256": "cdefab7671febeee01e102a18db67b3ec301fd9cb6f5f51ba6ce699b13432677"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json",
    "sha256": "6e152693d4ed137ad65997c596c44aa307694d1ae3b18b296400ac43b88b9045"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-materials-contract.json",
    "sha256": "9ca5ffb4e8d7d62bceb10a90a7a424b1b028d271fb0faba1f9e810b28f4f4d90"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-input-pins.json",
    "sha256": "d5d2225c7c8cf1bc1fc27f11d3bfc4f13c5dd597dae3c65701b0f4c6a200e567"
  },
  {
    "path": "packages/xpod-api/scripts/node-builtins.ts",
    "sha256": "b77b600379f808de205a7817863130f7c83ae83cb135a67109dfe3816d517468"
  },
  {
    "path": "packages/xpod-api/scripts/pack.ts",
    "sha256": "896f3ec37b743b9f9716c5672266363403c845893b370254203563197c831c40"
  },
  {
    "path": "packages/xpod-api/scripts/sourcekit-producer.ts",
    "sha256": "58a80bfa37f5b7089a410a3d61480c05f01c5188f1d27defb71a84870a48757d"
  },
  {
    "path": "packages/xpod-api/scripts/sourcekit.ts",
    "sha256": "e3f14b1f299f2095b80f3fe936b2ff919fc9bcd957764ef8eba41a56ea22b928"
  },
  {
    "path": "packages/xpod-api/scripts/stage.ts",
    "sha256": "b8d357f4a8bf062718404fd15fa5a89433e23d8cf4166289a7afc094b521270b"
  },
  {
    "path": "packages/xpod-api/scripts/static-material.ts",
    "sha256": "24a95c0368b46198f95f41c61d8d76ce029ea39165b9a31e9e1fcee80f74439c"
  },
  {
    "path": "packages/xpod-cli/src/manifest.ts",
    "sha256": "98540cea09a3cc3a37cd4132d4d42ba515c755255801d42c5827ede6bc2be167"
  },
  {
    "path": "packages/xpod-cli/src/module-catalog.ts",
    "sha256": "d52e3222f056d68b6c3eae261e25a196a23e5f7c43e9f027c918eedb9b0ce33e"
  },
  {
    "path": "packages/xpod-cli/src/source-materials.ts",
    "sha256": "66919cd2c75c229367538e9b2fea5af9243569572e9a74b5c3a8c80f609904b0"
  },
  {
    "path": "scripts/agentfs-native-ci/supervise.py",
    "sha256": "49fd9c7a7a9c9dc1612b1261f0cbc218166f48487df726239437ae9ad98ba407"
  },
  {
    "path": "scripts/api-module-producer.py",
    "sha256": "6999603e280c8df1be5fe068eff34cf4c357dc99e9052914040ab6db330ce058"
  },
  {
    "path": "scripts/lib/inngest-controlled-build.py",
    "sha256": "4f8dd31f989c311fece36fa3f3998be5aa7fa56e6e28c2a926d599973fd132fe"
  },
  {
    "path": "scripts/lib/inngest-controlled-materials.ts",
    "sha256": "3f02c1fb4d28038d62d57a9fd2cdae4b159fc5949a2b667726190558c8596272"
  },
  {
    "path": "scripts/lib/module-artifact-limits.json",
    "sha256": "c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4"
  },
  {
    "path": "scripts/lib/module-source-materials.py",
    "sha256": "c28f194ca9767f2aeddd9cff6f633dac2280ae9c4e5d716d3273706afce81850"
  },
  {
    "path": "scripts/lib/physical-module-archive.ts",
    "sha256": "04e5dd55b3c63190ba119ec2f01e30ab607d28507646e1d7419768b730e1896a"
  },
  {
    "path": "scripts/lib/physical-module-bins.ts",
    "sha256": "f75c4292b3323c76afd48db82480b69b8b6c60d15576bad004b88cba46a92d01"
  },
  {
    "path": "scripts/lib/physical-module-native-placement.ts",
    "sha256": "556fcb7c2fa475c802d21a0158c6ea33ba614434352b009ea8005944863be173"
  },
  {
    "path": "scripts/lib/physical-module-native.ts",
    "sha256": "f169df0b69333b68e8f904f677bc3b3d24611b79923042adc360ca0e3b681bac"
  },
  {
    "path": "scripts/lib/physical-module-notices.ts",
    "sha256": "d3b71ab69fc59bdbbc8d4bd3cf2e2dab92d39a3b08673337aa9ea494a4b807cc"
  },
  {
    "path": "scripts/lib/physical-module-stage.ts",
    "sha256": "41bbf5387ab913625aa29663c0f2758b3b783de28f48c201d375369a7268c750"
  },
  {
    "path": "scripts/module-product-targets.ts",
    "sha256": "5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4"
  }
]);
/** Four-target descriptor version; old Linux tuple remains independently exact. */
export const API_CONTROLLED_DESCRIPTOR_SOURCE_BINDINGS=Object.freeze([
  {
    "path": "packages/xpod-api/package.json",
    "sha256": "0176c10141dbdd675e2a9741787fd1d56b5e811a5951e0dd3d056ff949e60576"
  },
  {
    "path": "packages/xpod-api/scripts/bun-build-api.ts",
    "sha256": "260024d8fa42a81cc10ef7601bed0efc1a3657981e28fc20bf25274db1fbb4e8"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-products.ts",
    "sha256": "3a24864c1e1d542295a997d8a9de7814283de0cf6a6f233d3fab48f1c42fd516"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-runtime.ts",
    "sha256": "a542b95f7979049a6c2686f79ea80cb05d13251903c71b3d9fe54523e46093e6"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-stage.ts",
    "sha256": "e571128914a1c6d4db22fab9cb51743fc4af5d061ca7903f84c193a22bf8f505"
  },
  {
    "path": "packages/xpod-api/scripts/closure.ts",
    "sha256": "a06dce89cf832f574295794f4e830cca2d0abefc2553e5c7ec188614a91f2090"
  },
  {
    "path": "packages/xpod-api/scripts/controlled-native-material.ts",
    "sha256": "d1530cba12de2f599b6aaf2e3b38d17abd68b6c58ee7f8e0002f0262c14b0ef4"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json",
    "sha256": "03fe62750b08a55b763c028367e3eb6d25d17128088191cf4edf3c76c0d507d6"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-materials-contract.json",
    "sha256": "9ca5ffb4e8d7d62bceb10a90a7a424b1b028d271fb0faba1f9e810b28f4f4d90"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-input-pins.json",
    "sha256": "d5d2225c7c8cf1bc1fc27f11d3bfc4f13c5dd597dae3c65701b0f4c6a200e567"
  },
  {
    "path": "packages/xpod-api/scripts/node-builtins.ts",
    "sha256": "b77b600379f808de205a7817863130f7c83ae83cb135a67109dfe3816d517468"
  },
  {
    "path": "packages/xpod-api/scripts/pack.ts",
    "sha256": "896f3ec37b743b9f9716c5672266363403c845893b370254203563197c831c40"
  },
  {
    "path": "packages/xpod-api/scripts/sourcekit-producer.ts",
    "sha256": "58a80bfa37f5b7089a410a3d61480c05f01c5188f1d27defb71a84870a48757d"
  },
  {
    "path": "packages/xpod-api/scripts/sourcekit.ts",
    "sha256": "e3f14b1f299f2095b80f3fe936b2ff919fc9bcd957764ef8eba41a56ea22b928"
  },
  {
    "path": "packages/xpod-api/scripts/stage.ts",
    "sha256": "b8d357f4a8bf062718404fd15fa5a89433e23d8cf4166289a7afc094b521270b"
  },
  {
    "path": "packages/xpod-api/scripts/static-material.ts",
    "sha256": "24a95c0368b46198f95f41c61d8d76ce029ea39165b9a31e9e1fcee80f74439c"
  },
  {
    "path": "packages/xpod-cli/src/manifest.ts",
    "sha256": "98540cea09a3cc3a37cd4132d4d42ba515c755255801d42c5827ede6bc2be167"
  },
  {
    "path": "packages/xpod-cli/src/module-catalog.ts",
    "sha256": "d52e3222f056d68b6c3eae261e25a196a23e5f7c43e9f027c918eedb9b0ce33e"
  },
  {
    "path": "packages/xpod-cli/src/source-materials.ts",
    "sha256": "66919cd2c75c229367538e9b2fea5af9243569572e9a74b5c3a8c80f609904b0"
  },
  {
    "path": "scripts/agentfs-native-ci/supervise.py",
    "sha256": "49fd9c7a7a9c9dc1612b1261f0cbc218166f48487df726239437ae9ad98ba407"
  },
  {
    "path": "scripts/api-module-producer.py",
    "sha256": "8cfb86a4fa5de62e2938e51e459ae9c5c3bbe95cf0aaad88d59de9a9b900e920"
  },
  {
    "path": "scripts/lib/inngest-controlled-build.py",
    "sha256": "a8746e8bed74dec2a6726a36e5aed623173d6666dfed925b2d8848fa3358aec2"
  },
  {
    "path": "scripts/lib/inngest-controlled-materials.ts",
    "sha256": "c47ddb2bd3b1443cefbf5c4a41f6881c975bafd574bfe70079b73564da7b9ba6"
  },
  {
    "path": "scripts/lib/module-artifact-limits.json",
    "sha256": "c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4"
  },
  {
    "path": "scripts/lib/module-source-materials.py",
    "sha256": "c28f194ca9767f2aeddd9cff6f633dac2280ae9c4e5d716d3273706afce81850"
  },
  {
    "path": "scripts/lib/physical-module-archive.ts",
    "sha256": "04e5dd55b3c63190ba119ec2f01e30ab607d28507646e1d7419768b730e1896a"
  },
  {
    "path": "scripts/lib/physical-module-bins.ts",
    "sha256": "f75c4292b3323c76afd48db82480b69b8b6c60d15576bad004b88cba46a92d01"
  },
  {
    "path": "scripts/lib/physical-module-native-placement.ts",
    "sha256": "556fcb7c2fa475c802d21a0158c6ea33ba614434352b009ea8005944863be173"
  },
  {
    "path": "scripts/lib/physical-module-native.ts",
    "sha256": "f169df0b69333b68e8f904f677bc3b3d24611b79923042adc360ca0e3b681bac"
  },
  {
    "path": "scripts/lib/physical-module-notices.ts",
    "sha256": "d3b71ab69fc59bdbbc8d4bd3cf2e2dab92d39a3b08673337aa9ea494a4b807cc"
  },
  {
    "path": "scripts/lib/physical-module-stage.ts",
    "sha256": "41bbf5387ab913625aa29663c0f2758b3b783de28f48c201d375369a7268c750"
  },
  {
    "path": "scripts/module-product-targets.ts",
    "sha256": "5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4"
  }
]);
export const API_PUBLIC_SOURCE_BINDINGS=Object.freeze([
  {
    "path": "packages/xpod-api/package.json",
    "sha256": "0176c10141dbdd675e2a9741787fd1d56b5e811a5951e0dd3d056ff949e60576"
  },
  {
    "path": "packages/xpod-api/scripts/bun-build-api.ts",
    "sha256": "260024d8fa42a81cc10ef7601bed0efc1a3657981e28fc20bf25274db1fbb4e8"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-products.ts",
    "sha256": "3a24864c1e1d542295a997d8a9de7814283de0cf6a6f233d3fab48f1c42fd516"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-runtime.ts",
    "sha256": "a542b95f7979049a6c2686f79ea80cb05d13251903c71b3d9fe54523e46093e6"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-stage.ts",
    "sha256": "e571128914a1c6d4db22fab9cb51743fc4af5d061ca7903f84c193a22bf8f505"
  },
  {
    "path": "packages/xpod-api/scripts/closure.ts",
    "sha256": "a06dce89cf832f574295794f4e830cca2d0abefc2553e5c7ec188614a91f2090"
  },
  {
    "path": "packages/xpod-api/scripts/controlled-native-material.ts",
    "sha256": "d1530cba12de2f599b6aaf2e3b38d17abd68b6c58ee7f8e0002f0262c14b0ef4"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json",
    "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-materials-contract.json",
    "sha256": "9ca5ffb4e8d7d62bceb10a90a7a424b1b028d271fb0faba1f9e810b28f4f4d90"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-input-pins.json",
    "sha256": "d5d2225c7c8cf1bc1fc27f11d3bfc4f13c5dd597dae3c65701b0f4c6a200e567"
  },
  {
    "path": "packages/xpod-api/scripts/node-builtins.ts",
    "sha256": "b77b600379f808de205a7817863130f7c83ae83cb135a67109dfe3816d517468"
  },
  {
    "path": "packages/xpod-api/scripts/pack.ts",
    "sha256": "896f3ec37b743b9f9716c5672266363403c845893b370254203563197c831c40"
  },
  {
    "path": "packages/xpod-api/scripts/sourcekit-producer.ts",
    "sha256": "58a80bfa37f5b7089a410a3d61480c05f01c5188f1d27defb71a84870a48757d"
  },
  {
    "path": "packages/xpod-api/scripts/sourcekit.ts",
    "sha256": "e3f14b1f299f2095b80f3fe936b2ff919fc9bcd957764ef8eba41a56ea22b928"
  },
  {
    "path": "packages/xpod-api/scripts/stage.ts",
    "sha256": "b8d357f4a8bf062718404fd15fa5a89433e23d8cf4166289a7afc094b521270b"
  },
  {
    "path": "packages/xpod-api/scripts/static-material.ts",
    "sha256": "24a95c0368b46198f95f41c61d8d76ce029ea39165b9a31e9e1fcee80f74439c"
  },
  {
    "path": "packages/xpod-cli/src/manifest.ts",
    "sha256": "98540cea09a3cc3a37cd4132d4d42ba515c755255801d42c5827ede6bc2be167"
  },
  {
    "path": "packages/xpod-cli/src/module-catalog.ts",
    "sha256": "d52e3222f056d68b6c3eae261e25a196a23e5f7c43e9f027c918eedb9b0ce33e"
  },
  {
    "path": "packages/xpod-cli/src/source-materials.ts",
    "sha256": "66919cd2c75c229367538e9b2fea5af9243569572e9a74b5c3a8c80f609904b0"
  },
  {
    "path": "scripts/agentfs-native-ci/supervise.py",
    "sha256": "49fd9c7a7a9c9dc1612b1261f0cbc218166f48487df726239437ae9ad98ba407"
  },
  {
    "path": "scripts/api-module-producer.py",
    "sha256": "8cfb86a4fa5de62e2938e51e459ae9c5c3bbe95cf0aaad88d59de9a9b900e920"
  },
  {
    "path": "scripts/lib/inngest-controlled-build.py",
    "sha256": "6f82f617c67e70d75b2023993df3846b2caccef34c4a937cd58299cb7bcec99e"
  },
  {
    "path": "scripts/lib/inngest-controlled-materials.ts",
    "sha256": "c47ddb2bd3b1443cefbf5c4a41f6881c975bafd574bfe70079b73564da7b9ba6"
  },
  {
    "path": "scripts/lib/module-artifact-limits.json",
    "sha256": "c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4"
  },
  {
    "path": "scripts/lib/module-source-materials.py",
    "sha256": "07dbfc5531b7b3b812fe6f532141c964255b90f46ed30a05c86f6e42ef2e0ee5"
  },
  {
    "path": "scripts/lib/physical-module-archive.ts",
    "sha256": "04e5dd55b3c63190ba119ec2f01e30ab607d28507646e1d7419768b730e1896a"
  },
  {
    "path": "scripts/lib/physical-module-bins.ts",
    "sha256": "f75c4292b3323c76afd48db82480b69b8b6c60d15576bad004b88cba46a92d01"
  },
  {
    "path": "scripts/lib/physical-module-native-placement.ts",
    "sha256": "556fcb7c2fa475c802d21a0158c6ea33ba614434352b009ea8005944863be173"
  },
  {
    "path": "scripts/lib/physical-module-native.ts",
    "sha256": "f169df0b69333b68e8f904f677bc3b3d24611b79923042adc360ca0e3b681bac"
  },
  {
    "path": "scripts/lib/physical-module-notices.ts",
    "sha256": "d3b71ab69fc59bdbbc8d4bd3cf2e2dab92d39a3b08673337aa9ea494a4b807cc"
  },
  {
    "path": "scripts/lib/physical-module-stage.ts",
    "sha256": "41bbf5387ab913625aa29663c0f2758b3b783de28f48c201d375369a7268c750"
  },
  {
    "path": "scripts/module-product-targets.ts",
    "sha256": "5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4"
  }
]);
export const API_RETAINED_BUDGET_SOURCE_BINDINGS=Object.freeze([
  {
    "path": "packages/xpod-api/package.json",
    "sha256": "0176c10141dbdd675e2a9741787fd1d56b5e811a5951e0dd3d056ff949e60576"
  },
  {
    "path": "packages/xpod-api/scripts/bun-build-api.ts",
    "sha256": "260024d8fa42a81cc10ef7601bed0efc1a3657981e28fc20bf25274db1fbb4e8"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-products.ts",
    "sha256": "3a24864c1e1d542295a997d8a9de7814283de0cf6a6f233d3fab48f1c42fd516"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-runtime.ts",
    "sha256": "a542b95f7979049a6c2686f79ea80cb05d13251903c71b3d9fe54523e46093e6"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-stage.ts",
    "sha256": "e571128914a1c6d4db22fab9cb51743fc4af5d061ca7903f84c193a22bf8f505"
  },
  {
    "path": "packages/xpod-api/scripts/closure.ts",
    "sha256": "a06dce89cf832f574295794f4e830cca2d0abefc2553e5c7ec188614a91f2090"
  },
  {
    "path": "packages/xpod-api/scripts/controlled-native-material.ts",
    "sha256": "d1530cba12de2f599b6aaf2e3b38d17abd68b6c58ee7f8e0002f0262c14b0ef4"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json",
    "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-materials-contract.json",
    "sha256": "9ca5ffb4e8d7d62bceb10a90a7a424b1b028d271fb0faba1f9e810b28f4f4d90"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-input-pins.json",
    "sha256": "d5d2225c7c8cf1bc1fc27f11d3bfc4f13c5dd597dae3c65701b0f4c6a200e567"
  },
  {
    "path": "packages/xpod-api/scripts/node-builtins.ts",
    "sha256": "b77b600379f808de205a7817863130f7c83ae83cb135a67109dfe3816d517468"
  },
  {
    "path": "packages/xpod-api/scripts/pack.ts",
    "sha256": "896f3ec37b743b9f9716c5672266363403c845893b370254203563197c831c40"
  },
  {
    "path": "packages/xpod-api/scripts/sourcekit-producer.ts",
    "sha256": "58a80bfa37f5b7089a410a3d61480c05f01c5188f1d27defb71a84870a48757d"
  },
  {
    "path": "packages/xpod-api/scripts/sourcekit.ts",
    "sha256": "e3f14b1f299f2095b80f3fe936b2ff919fc9bcd957764ef8eba41a56ea22b928"
  },
  {
    "path": "packages/xpod-api/scripts/stage.ts",
    "sha256": "b8d357f4a8bf062718404fd15fa5a89433e23d8cf4166289a7afc094b521270b"
  },
  {
    "path": "packages/xpod-api/scripts/static-material.ts",
    "sha256": "24a95c0368b46198f95f41c61d8d76ce029ea39165b9a31e9e1fcee80f74439c"
  },
  {
    "path": "packages/xpod-cli/src/manifest.ts",
    "sha256": "98540cea09a3cc3a37cd4132d4d42ba515c755255801d42c5827ede6bc2be167"
  },
  {
    "path": "packages/xpod-cli/src/module-catalog.ts",
    "sha256": "d52e3222f056d68b6c3eae261e25a196a23e5f7c43e9f027c918eedb9b0ce33e"
  },
  {
    "path": "packages/xpod-cli/src/source-materials.ts",
    "sha256": "66919cd2c75c229367538e9b2fea5af9243569572e9a74b5c3a8c80f609904b0"
  },
  {
    "path": "scripts/agentfs-native-ci/supervise.py",
    "sha256": "49fd9c7a7a9c9dc1612b1261f0cbc218166f48487df726239437ae9ad98ba407"
  },
  {
    "path": "scripts/api-module-producer.py",
    "sha256": "68ecfb5c66dd0f1882ef707e86a4c74df7d0406bb9bb68eb011bb20872ef23bf"
  },
  {
    "path": "scripts/lib/inngest-controlled-build.py",
    "sha256": "44995b48418f3b0af1bdd3608c8b3c1307ad3cbc4c927d03a92fbf37b5a60404"
  },
  {
    "path": "scripts/lib/inngest-controlled-materials.ts",
    "sha256": "c47ddb2bd3b1443cefbf5c4a41f6881c975bafd574bfe70079b73564da7b9ba6"
  },
  {
    "path": "scripts/lib/module-artifact-limits.json",
    "sha256": "c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4"
  },
  {
    "path": "scripts/lib/module-source-materials.py",
    "sha256": "1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2"
  },
  {
    "path": "scripts/lib/physical-module-archive.ts",
    "sha256": "04e5dd55b3c63190ba119ec2f01e30ab607d28507646e1d7419768b730e1896a"
  },
  {
    "path": "scripts/lib/physical-module-bins.ts",
    "sha256": "f75c4292b3323c76afd48db82480b69b8b6c60d15576bad004b88cba46a92d01"
  },
  {
    "path": "scripts/lib/physical-module-native-placement.ts",
    "sha256": "556fcb7c2fa475c802d21a0158c6ea33ba614434352b009ea8005944863be173"
  },
  {
    "path": "scripts/lib/physical-module-native.ts",
    "sha256": "f169df0b69333b68e8f904f677bc3b3d24611b79923042adc360ca0e3b681bac"
  },
  {
    "path": "scripts/lib/physical-module-notices.ts",
    "sha256": "d3b71ab69fc59bdbbc8d4bd3cf2e2dab92d39a3b08673337aa9ea494a4b807cc"
  },
  {
    "path": "scripts/lib/physical-module-stage.ts",
    "sha256": "41bbf5387ab913625aa29663c0f2758b3b783de28f48c201d375369a7268c750"
  },
  {
    "path": "scripts/module-product-targets.ts",
    "sha256": "5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4"
  }
]);

const API_CATALOG_SOURCE_BINDINGS = Object.freeze([
  {
    "path": "packages/xpod-api/package.json",
    "sha256": "ce111f505757cbb813e70237d7fec59ae496eb1b7f6661d57be1203cd4709a60"
  },
  {
    "path": "packages/xpod-api/scripts/bun-build-api.ts",
    "sha256": "260024d8fa42a81cc10ef7601bed0efc1a3657981e28fc20bf25274db1fbb4e8"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-products.ts",
    "sha256": "3a24864c1e1d542295a997d8a9de7814283de0cf6a6f233d3fab48f1c42fd516"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-runtime.ts",
    "sha256": "a542b95f7979049a6c2686f79ea80cb05d13251903c71b3d9fe54523e46093e6"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-stage.ts",
    "sha256": "e571128914a1c6d4db22fab9cb51743fc4af5d061ca7903f84c193a22bf8f505"
  },
  {
    "path": "packages/xpod-api/scripts/closure.ts",
    "sha256": "a06dce89cf832f574295794f4e830cca2d0abefc2553e5c7ec188614a91f2090"
  },
  {
    "path": "packages/xpod-api/scripts/controlled-native-material.ts",
    "sha256": "d1530cba12de2f599b6aaf2e3b38d17abd68b6c58ee7f8e0002f0262c14b0ef4"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json",
    "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-materials-contract.json",
    "sha256": "9ca5ffb4e8d7d62bceb10a90a7a424b1b028d271fb0faba1f9e810b28f4f4d90"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-input-pins.json",
    "sha256": "d5d2225c7c8cf1bc1fc27f11d3bfc4f13c5dd597dae3c65701b0f4c6a200e567"
  },
  {
    "path": "packages/xpod-api/scripts/node-builtins.ts",
    "sha256": "b77b600379f808de205a7817863130f7c83ae83cb135a67109dfe3816d517468"
  },
  {
    "path": "packages/xpod-api/scripts/pack.ts",
    "sha256": "896f3ec37b743b9f9716c5672266363403c845893b370254203563197c831c40"
  },
  {
    "path": "packages/xpod-api/scripts/sourcekit-producer.ts",
    "sha256": "58a80bfa37f5b7089a410a3d61480c05f01c5188f1d27defb71a84870a48757d"
  },
  {
    "path": "packages/xpod-api/scripts/sourcekit.ts",
    "sha256": "e3f14b1f299f2095b80f3fe936b2ff919fc9bcd957764ef8eba41a56ea22b928"
  },
  {
    "path": "packages/xpod-api/scripts/stage.ts",
    "sha256": "b8d357f4a8bf062718404fd15fa5a89433e23d8cf4166289a7afc094b521270b"
  },
  {
    "path": "packages/xpod-api/scripts/static-material.ts",
    "sha256": "24a95c0368b46198f95f41c61d8d76ce029ea39165b9a31e9e1fcee80f74439c"
  },
  {
    "path": "packages/xpod-cli/src/manifest.ts",
    "sha256": "98540cea09a3cc3a37cd4132d4d42ba515c755255801d42c5827ede6bc2be167"
  },
  {
    "path": "packages/xpod-cli/src/module-catalog.ts",
    "sha256": "d52e3222f056d68b6c3eae261e25a196a23e5f7c43e9f027c918eedb9b0ce33e"
  },
  {
    "path": "packages/xpod-cli/src/source-materials.ts",
    "sha256": "66919cd2c75c229367538e9b2fea5af9243569572e9a74b5c3a8c80f609904b0"
  },
  {
    "path": "scripts/agentfs-native-ci/supervise.py",
    "sha256": "49fd9c7a7a9c9dc1612b1261f0cbc218166f48487df726239437ae9ad98ba407"
  },
  {
    "path": "scripts/api-module-producer.py",
    "sha256": "68ecfb5c66dd0f1882ef707e86a4c74df7d0406bb9bb68eb011bb20872ef23bf"
  },
  {
    "path": "scripts/lib/inngest-controlled-build.py",
    "sha256": "44995b48418f3b0af1bdd3608c8b3c1307ad3cbc4c927d03a92fbf37b5a60404"
  },
  {
    "path": "scripts/lib/inngest-controlled-materials.ts",
    "sha256": "c47ddb2bd3b1443cefbf5c4a41f6881c975bafd574bfe70079b73564da7b9ba6"
  },
  {
    "path": "scripts/lib/module-artifact-limits.json",
    "sha256": "c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4"
  },
  {
    "path": "scripts/lib/module-source-materials.py",
    "sha256": "1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2"
  },
  {
    "path": "scripts/lib/physical-module-archive.ts",
    "sha256": "04e5dd55b3c63190ba119ec2f01e30ab607d28507646e1d7419768b730e1896a"
  },
  {
    "path": "scripts/lib/physical-module-bins.ts",
    "sha256": "f75c4292b3323c76afd48db82480b69b8b6c60d15576bad004b88cba46a92d01"
  },
  {
    "path": "scripts/lib/physical-module-native-placement.ts",
    "sha256": "556fcb7c2fa475c802d21a0158c6ea33ba614434352b009ea8005944863be173"
  },
  {
    "path": "scripts/lib/physical-module-native.ts",
    "sha256": "f169df0b69333b68e8f904f677bc3b3d24611b79923042adc360ca0e3b681bac"
  },
  {
    "path": "scripts/lib/physical-module-notices.ts",
    "sha256": "d3b71ab69fc59bdbbc8d4bd3cf2e2dab92d39a3b08673337aa9ea494a4b807cc"
  },
  {
    "path": "scripts/lib/physical-module-stage.ts",
    "sha256": "d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"
  },
  {
    "path": "scripts/module-product-targets.ts",
    "sha256": "5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4"
  },
  {
    "path": "scripts/prepare-package-manifest.cjs",
    "sha256": "47c24e7547f03493161baea3abdf7686db7c21a791d4871535e66d0a3dac2a02"
  },
  {
    "path": "scripts/platform-binaries.cjs",
    "sha256": "95dc2afc4501a87418c4858faa4f77bf0b1930061c649c3d771d607d3d8ecc7f"
  },
  {
    "path": "package.json",
    "sha256": "9b6916d878ab959bc4825382df29c0ca279e2d88e7bfc19cb61552e857f6a3f2"
  },
  {
    "path": "bun.lock",
    "sha256": "8e191efdefc855b72cea0f8cbc3e3ad2f5c3f47c4466553f7d23bd04fccc3d0d"
  }
]);
export const API_WORKSPACE_SOURCE_BINDINGS=Object.freeze([
  {
    "path": "bun.lock",
    "sha256": "8e191efdefc855b72cea0f8cbc3e3ad2f5c3f47c4466553f7d23bd04fccc3d0d"
  },
  {
    "path": "desktop/package.json",
    "sha256": "b29ecdd63bd7b0c7fc9e3eff53866432831fad4acc4d637c769cb03977810e85"
  },
  {
    "path": "package.json",
    "sha256": "9b6916d878ab959bc4825382df29c0ca279e2d88e7bfc19cb61552e857f6a3f2"
  },
  {
    "path": "packages/ai-connections-runtime/package.json",
    "sha256": "f9c72637124b3510120a20c3b6b93ff33eebcf7796d314eeee3374e5cbfbfd20"
  },
  {
    "path": "packages/ai-connections/package.json",
    "sha256": "33bae7d03ba80c0d976ad1b2e66e932baeb71036de2ce15195b8267a192ad4c7"
  },
  {
    "path": "packages/extension-host-contracts/package.json",
    "sha256": "edefd8df016317d6971312d5437e721a4aea0b7c19acf03bf538ac156d6bf99e"
  },
  {
    "path": "packages/extension-sdk/package.json",
    "sha256": "bce7c23d881599d5bbd8f7e69e0f08bedb63954fe91ad7a094f47e91c95ed102"
  },
  {
    "path": "packages/pod-collections/package.json",
    "sha256": "bdf75a9a98f3614ea9e514dc871c58a1d7f6538edf6dc116efc15682643ebfae"
  },
  {
    "path": "packages/pod-settings/package.json",
    "sha256": "3a5582bd37db2a89a4716bd74b165635b3b15fef64ad9ddb2ae66c99a2a2a1f4"
  },
  {
    "path": "packages/shared-ui/package.json",
    "sha256": "dbbc70ca1b987018058e6d5946469e24f08c56f2548fb74e08ab26295618b20a"
  },
  {
    "path": "packages/solid-sdk/package.json",
    "sha256": "2af86bb2b1da2ead8b3311cdc1213c5463db49cd92bbd7c3c100cdc3ec113913"
  },
  {
    "path": "packages/solid-sdk/scripts/build-bun-entries.cjs",
    "sha256": "801e88cdb5c33ff04082cb8fa9e2bfddaedc8aa0456ed25b9229c07478306dcf"
  },
  {
    "path": "packages/tasks/package.json",
    "sha256": "3fe14574fcd12ee43a2f3e6ef95129a34405b72a2c576f8ed98b2f4ff7a49a8b"
  },
  {
    "path": "packages/xpod-afs/package.json",
    "sha256": "5cdd40f78be50b44a45bad7b0b22463b9555ed580f4dc77a365b3d7c3d24aee4"
  },
  {
    "path": "packages/xpod-api/package.json",
    "sha256": "ce111f505757cbb813e70237d7fec59ae496eb1b7f6661d57be1203cd4709a60"
  },
  {
    "path": "packages/xpod-api/scripts/build.ts",
    "sha256": "8b38e569b284448bc5e34064efc8a4bb6022283d1fd025e007dc904ac92b7a52"
  },
  {
    "path": "packages/xpod-api/scripts/bun-build-api.ts",
    "sha256": "260024d8fa42a81cc10ef7601bed0efc1a3657981e28fc20bf25274db1fbb4e8"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-products.ts",
    "sha256": "3a24864c1e1d542295a997d8a9de7814283de0cf6a6f233d3fab48f1c42fd516"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-runtime.ts",
    "sha256": "a542b95f7979049a6c2686f79ea80cb05d13251903c71b3d9fe54523e46093e6"
  },
  {
    "path": "packages/xpod-api/scripts/bundle-stage.ts",
    "sha256": "e571128914a1c6d4db22fab9cb51743fc4af5d061ca7903f84c193a22bf8f505"
  },
  {
    "path": "packages/xpod-api/scripts/closure.ts",
    "sha256": "a06dce89cf832f574295794f4e830cca2d0abefc2553e5c7ec188614a91f2090"
  },
  {
    "path": "packages/xpod-api/scripts/controlled-native-material.ts",
    "sha256": "d1530cba12de2f599b6aaf2e3b38d17abd68b6c58ee7f8e0002f0262c14b0ef4"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json",
    "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-controlled-materials-contract.json",
    "sha256": "9ca5ffb4e8d7d62bceb10a90a7a424b1b028d271fb0faba1f9e810b28f4f4d90"
  },
  {
    "path": "packages/xpod-api/scripts/inngest-input-pins.json",
    "sha256": "d5d2225c7c8cf1bc1fc27f11d3bfc4f13c5dd597dae3c65701b0f4c6a200e567"
  },
  {
    "path": "packages/xpod-api/scripts/node-builtins.ts",
    "sha256": "b77b600379f808de205a7817863130f7c83ae83cb135a67109dfe3816d517468"
  },
  {
    "path": "packages/xpod-api/scripts/pack.ts",
    "sha256": "896f3ec37b743b9f9716c5672266363403c845893b370254203563197c831c40"
  },
  {
    "path": "packages/xpod-api/scripts/sourcekit-producer.ts",
    "sha256": "58a80bfa37f5b7089a410a3d61480c05f01c5188f1d27defb71a84870a48757d"
  },
  {
    "path": "packages/xpod-api/scripts/sourcekit.ts",
    "sha256": "e3f14b1f299f2095b80f3fe936b2ff919fc9bcd957764ef8eba41a56ea22b928"
  },
  {
    "path": "packages/xpod-api/scripts/stage.ts",
    "sha256": "b8d357f4a8bf062718404fd15fa5a89433e23d8cf4166289a7afc094b521270b"
  },
  {
    "path": "packages/xpod-api/scripts/static-material.ts",
    "sha256": "24a95c0368b46198f95f41c61d8d76ce029ea39165b9a31e9e1fcee80f74439c"
  },
  {
    "path": "packages/xpod-cli/package.json",
    "sha256": "e2db5b5feb6eb3e4ab30508fd8657b68b3fd72ae2e1e618a2f12eb3fa2309c85"
  },
  {
    "path": "packages/xpod-cli/scripts/build-package.ts",
    "sha256": "298519827f405b3991059d75044a72ab7f76153e0a90d1a25826eb7f0c9ffae0"
  },
  {
    "path": "packages/xpod-cli/scripts/build-tools-package.ts",
    "sha256": "d41d3988923761f85eb14b7c59a43fd4447fd679ebd7f16e3636611b631e1d30"
  },
  {
    "path": "packages/xpod-cli/src/manifest.ts",
    "sha256": "98540cea09a3cc3a37cd4132d4d42ba515c755255801d42c5827ede6bc2be167"
  },
  {
    "path": "packages/xpod-cli/src/module-catalog.ts",
    "sha256": "d52e3222f056d68b6c3eae261e25a196a23e5f7c43e9f027c918eedb9b0ce33e"
  },
  {
    "path": "packages/xpod-cli/src/source-materials.ts",
    "sha256": "66919cd2c75c229367538e9b2fea5af9243569572e9a74b5c3a8c80f609904b0"
  },
  {
    "path": "packages/xpod-client/package.json",
    "sha256": "b6e86fb6f4d72f8b991b3738c03dbbb45fe72518a3930907b3feba80d3dddc32"
  },
  {
    "path": "packages/xpod-client/scripts/build.ts",
    "sha256": "491521ac3d42a4b4cab0b5becbc48cb755431b6a3b3667688f0f21dab9ed2659"
  },
  {
    "path": "packages/xpod-css/package.json",
    "sha256": "cd7745c176af4b4c2fcab55aa768459c8f44b2f890fe0abc6ad728d292c45028"
  },
  {
    "path": "patches/@solid%2Fcommunity-server@8.0.0-alpha.1.patch",
    "sha256": "36b8796d16459344b6ee7b83f3cfd98d2325ef4cc144bb33e6a3710b6e234283"
  },
  {
    "path": "patches/@undefineds.co%2Fdrizzle-solid@0.3.25.patch",
    "sha256": "15917daa88260327bb30d5da25d9db7efb0fd3386c7f0494102fa780ac870789"
  },
  {
    "path": "patches/oidc-provider@9.5.1.patch",
    "sha256": "ab20339bffd5ddb7041a79f83624da24baabedeabde95ee9f055cf091015b037"
  },
  {
    "path": "scripts/agentfs-native-ci/supervise.py",
    "sha256": "49fd9c7a7a9c9dc1612b1261f0cbc218166f48487df726239437ae9ad98ba407"
  },
  {
    "path": "scripts/api-module-producer.py",
    "sha256": "0169bfbf726dce149e5a0fa995fd06bbe618236f1829d0575ccb0bafeea8b450"
  },
  {
    "path": "scripts/api-producer-dependencies.cjs",
    "sha256": "f6e9deb9a758523e57afa8fa5c7253ecec679d1c6d2c929ae7c22ea9c649685e"
  },
  {
    "path": "scripts/build-afs-from-producer.ts",
    "sha256": "95c556979f97400210a0e1826c505f06c1e258951aacf7f519b6482fb50bd85f"
  },
  {
    "path": "scripts/check-api-producer-dependency-state.ts",
    "sha256": "1c91afdb24cc995195a996032d6c032f52e281fb6437af47e255925c85a6238a"
  },
  {
    "path": "scripts/check-dependency-state.ts",
    "sha256": "1cabdc527ed712e0f3521bc773fec06ff698eb2eb61ac98a6853454041433509"
  },
  {
    "path": "scripts/fix-dist-js-imports.mjs",
    "sha256": "fad80671a261bfad30bfc7db21abc3f140f6208027e7d97769fca9220400148a"
  },
  {
    "path": "scripts/lib/api-install-selection.cjs",
    "sha256": "a5f13ad0d9e3b017ee78012e3bb0a121870462f24ccdbbf54f40700b34a1ff48"
  },
  {
    "path": "scripts/lib/api-producer-graph.ts",
    "sha256": "8edda5b02b81fac1ba492caed1b0761d9af7d5df8c975d9639188cd270819192"
  },
  {
    "path": "scripts/lib/api-scoped-dependency-state.ts",
    "sha256": "97ad91dbd3e01c1e3c0b5d8f503ed0203b00c750090c9e4c743347713dc502a6"
  },
  {
    "path": "scripts/lib/inngest-controlled-build.py",
    "sha256": "44995b48418f3b0af1bdd3608c8b3c1307ad3cbc4c927d03a92fbf37b5a60404"
  },
  {
    "path": "scripts/lib/inngest-controlled-materials.ts",
    "sha256": "c47ddb2bd3b1443cefbf5c4a41f6881c975bafd574bfe70079b73564da7b9ba6"
  },
  {
    "path": "scripts/lib/module-artifact-limits.json",
    "sha256": "c1c529aba719356c682affbe630c215e28cc07163192f8f3b601aab7b0126bd4"
  },
  {
    "path": "scripts/lib/module-source-materials.py",
    "sha256": "1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2"
  },
  {
    "path": "scripts/lib/physical-module-archive.ts",
    "sha256": "04e5dd55b3c63190ba119ec2f01e30ab607d28507646e1d7419768b730e1896a"
  },
  {
    "path": "scripts/lib/physical-module-bins.ts",
    "sha256": "f75c4292b3323c76afd48db82480b69b8b6c60d15576bad004b88cba46a92d01"
  },
  {
    "path": "scripts/lib/physical-module-native-placement.ts",
    "sha256": "556fcb7c2fa475c802d21a0158c6ea33ba614434352b009ea8005944863be173"
  },
  {
    "path": "scripts/lib/physical-module-native.ts",
    "sha256": "f169df0b69333b68e8f904f677bc3b3d24611b79923042adc360ca0e3b681bac"
  },
  {
    "path": "scripts/lib/physical-module-notices.ts",
    "sha256": "d3b71ab69fc59bdbbc8d4bd3cf2e2dab92d39a3b08673337aa9ea494a4b807cc"
  },
  {
    "path": "scripts/lib/physical-module-stage.ts",
    "sha256": "d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"
  },
  {
    "path": "scripts/module-product-targets.ts",
    "sha256": "5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4"
  },
  {
    "path": "scripts/patch-inrupt-authn-operation-cleanup.js",
    "sha256": "2ecdb915eb500f0c61646155ce3a8e19be7fcb40ea6897d7093349871da99487"
  },
  {
    "path": "scripts/patch-inrupt-authn-refresh.js",
    "sha256": "08a2ad5753a3e0d8862f28c26ebed5e809c71cdb809e0d3e6f644f0ce30a8b1b"
  },
  {
    "path": "scripts/patch-inrupt-authn-transport.js",
    "sha256": "45ada339a237dcafc714f1c77fce313a97ae1f74d0e8986d7aa38dd10a955f04"
  },
  {
    "path": "scripts/patch-jose.js",
    "sha256": "7a2956ec29c71f00f5769718c6452d61a810c74c2ec5fab1a6a80c597c2dbd18"
  },
  {
    "path": "scripts/plan-api-install-selection.cjs",
    "sha256": "164d5930864cefb2efdcaccc34fcf046aa61bc248542d1e70f11975d6159c324"
  },
  {
    "path": "scripts/platform-binaries.cjs",
    "sha256": "95dc2afc4501a87418c4858faa4f77bf0b1930061c649c3d771d607d3d8ecc7f"
  },
  {
    "path": "scripts/prepare-package-manifest.cjs",
    "sha256": "47c24e7547f03493161baea3abdf7686db7c21a791d4871535e66d0a3dac2a02"
  },
  {
    "path": "scripts/workspace-runtime-materials.cjs",
    "sha256": "1d1e5e6c454e77acf1dbbf5e225f11fc98d99c3ab928bdc96d914f076ac6e3e6"
  },
  {
    "path": "ui/package.json",
    "sha256": "e1d4d6935fb87798f5cb9964b468b9a75adac722ecb014af2011fc347ae3a611"
  }
]);
export const API_PHYSICAL_LOOKUP_SOURCE_BINDINGS=Object.freeze(API_WORKSPACE_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:row.path==='scripts/lib/api-scoped-dependency-state.ts'?'cc456784be5c5df9c5a244647694125a8c1300271a13d0dd887ddeb7ff95b389':row.sha256})));
export const API_IDENTITY_DIAGNOSTIC_SOURCE_BINDINGS=Object.freeze([...API_PHYSICAL_LOOKUP_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:row.path==='scripts/lib/api-scoped-dependency-state.ts'?'0de4c1e9484de9b558eb8cf39c8790d6f824d718d97d29e1800cd8adb91bd64f':row.sha256})),{"path": "scripts/independent-release-plan.ts", "sha256": "170d6fead7a472b6faf6f65e34835033d5ab6e0828c92bdb2e33d19356de55ee"},{"path": "scripts/workspace-package-payload.cjs", "sha256": "228454b5953de73d1045f8d4a9cb57c66f7639125363ee90344fc643472dffef"}]);
export const API_PEER_PROVIDER_SOURCE_BINDINGS=Object.freeze(API_IDENTITY_DIAGNOSTIC_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:row.path==='scripts/lib/api-scoped-dependency-state.ts'?'2ff62ebe42a0bdbb936b6f3f1eaebc413893d20cbd84fc2fb70bce57d4d2a459':row.path==='scripts/check-api-producer-dependency-state.ts'?'292f53eeec444d110bea009957754bf6f332a83f4cb0f209de30362908afa0ad':row.sha256})));
export const API_PEER_RANGE_DIAGNOSTIC_SOURCE_BINDINGS=Object.freeze(API_PEER_PROVIDER_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:row.path==='scripts/lib/api-scoped-dependency-state.ts'?'041d21ec80f1fdcbf229f906c26bf30447092bcc2424bf5dda98eeb9a5080c10':row.sha256})));
export const API_PEER_EXACT_CONTRACT_SOURCE_BINDINGS=Object.freeze(API_PEER_RANGE_DIAGNOSTIC_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:row.path==='scripts/lib/api-scoped-dependency-state.ts'?'e6214b853fd54eaff5e0ed157ed89f66dbdf273c9f226eaa16576764f41cc42e':row.sha256})));
export const API_PEER_PAYLOAD_COPY_SOURCE_BINDINGS=Object.freeze(API_PEER_EXACT_CONTRACT_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:row.path==='scripts/lib/api-scoped-dependency-state.ts'?'f9edbb6e2e50e3c568268f9d7c33175a380d248d2ad4541879eac5ddd25064a1':row.sha256})));
export const API_COMPRESSED_INPUT_SOURCE_BINDINGS=Object.freeze(API_PEER_PAYLOAD_COPY_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:row.path==='scripts/lib/module-source-materials.py'?'b582490cdbbd2b857fa6ce20d0b5d85a73605c90b96063a3c17bf7b38be93601':row.path==='scripts/lib/inngest-controlled-build.py'?'d81fdd239578edd17635f26bad8d5dda2e6de7fed701057ef1f65ce52c0097fc':row.sha256})));
export const API_COMPRESSED_RETENTION_SOURCE_BINDINGS=Object.freeze(API_COMPRESSED_INPUT_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:row.path==='scripts/api-module-producer.py'?'bd668dc98e481496f8b2cf6a1ba97541caafc70f39acf8d8757226e4cedca588':row.sha256})));
export const API_NODE_PUBLIC_TOOL_SOURCE_BINDINGS=Object.freeze(API_COMPRESSED_RETENTION_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:row.path==="packages/xpod-api/scripts/inngest-controlled-build-policy.json"?"2a199144729930c2a2927319cc52c55413785a6c85720d952caffbe36e2b555a":row.path==="scripts/lib/inngest-controlled-build.py"?"a983997f77ced56b382122730a0be869cbccd6c412b60c660960d963c0fac85b":row.path==="scripts/lib/module-source-materials.py"?"99eb684db2712cee74ae40f7ac17a55c1dcd74682162b75947203cf2628c6e16":row.sha256})));
export const API_WEBSITE_SOURCE_BINDINGS=Object.freeze(API_NODE_PUBLIC_TOOL_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:row.path==="packages/xpod-api/scripts/inngest-controlled-build-policy.json"?"bd8f3d1df1ff282dba66e7a9b4bfa68836212501253f7e60647f569d0bf855d0":row.path==="scripts/lib/inngest-controlled-build.py"?"9ab22ab214b191ef8e1c05f7200595026ef82f103960a0e15af01c6505e33200":row.sha256})));
export const API_WEBSITE_STAGE_SOURCE_BINDINGS=Object.freeze(API_WEBSITE_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:row.path==="scripts/lib/inngest-controlled-materials.ts"?"46f9f01ef6817718afff3690447dff59ad3e4093605e7f68ba146643fc52f15d":row.path==="packages/xpod-api/scripts/controlled-native-material.ts"?"19d6d57591bedb8ff5c0b62231f4cf2a1d7966683b76b1e4d8699d914b974bbe":row.sha256})));
function withWebsiteStageSelector(group:GitHubSourceBindingGroup):GitHubSourceBindingGroup{
 if(!group.selectors.some(row=>row.path==='scripts/api-module-producer.py'&&row.sha256==='bd668dc98e481496f8b2cf6a1ba97541caafc70f39acf8d8757226e4cedca588'))return group;
 const binding=group.sourceBindings.find(row=>row.path==='scripts/lib/inngest-controlled-materials.ts');if(!binding)throw Error('Website stage selector must be an existing original');
 return Object.freeze({...group,secondarySelectors:Object.freeze([...(group.secondarySelectors??[]),binding])});
}
export const API_NOTICE_SOURCE_BINDINGS=Object.freeze([...API_WEBSITE_STAGE_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:({"scripts/api-module-producer.py":"988a1aaae9c786fefa4e0901f3a2de207401ea08f23c9154d941a640a6c70870","scripts/lib/physical-module-notices.ts":"b2acc236bce0635174eb345703ea1c93c4366eff85fd802ed0183d36265bee88","scripts/workspace-package-payload.cjs":"022f6e1f3aa68af10dce711b067876f100d0b51a7d005222d564f4e4b8149df7"} as Readonly<Record<string,string>>)[row.path]??row.sha256})),...[{"path":"packages/xpod-api/scripts/notice-material.ts","sha256":"a09f42ba1c00bdfe958181fb2170fd19aeda9fc4b9be0477e13cdf99acf0dcb1"},{"path":"scripts/lib/independent-admission/legal-registry-originals.ts","sha256":"e2fb72ed1fff93ed2d476cb1a14eded47fbee5bfd57869a3c32deffe125d8c47"},{"path":"scripts/lib/registry-legal-original-limits.json","sha256":"b94085a1266b8f902940f00f903f6ec965b0c311cb97035593d9d025db920a07"}].map(row=>Object.freeze(row))]);
/** Next complete tool-acquisition recipe; registration follows separately. */
export const API_ATTESTED_NOTICE_SOURCE_BINDINGS=Object.freeze([...API_NOTICE_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:({"scripts/api-module-producer.py": "f6abdd37eee47c33a1df9f76b7e0fb99ce8efee88c5b40ddcaa1d7a0f66091e6", "scripts/lib/physical-module-notices.ts": "5a9b003bfb965bc6210987ae0b9d639c35110a6a557be9f9cb2cfe8df8aee869", "packages/xpod-api/scripts/notice-material.ts": "0215614b01fc3c3f665d9d9c6db09bdca5bdc0ff182be0530d25001e64912ac1"} as Readonly<Record<string,string>>)[row.path]??row.sha256})),...[{"path": "scripts/lib/notice-source-attestation.ts", "sha256": "a195c03c83c80a6ef0b4d0c851919d229de61469d368f7b371f64e6e40ec6c9a"}, {"path": "scripts/lib/acquire-notice-verifier.ts", "sha256": "39c7603d214654cd891ba1f3294e556ab7c3ace60fac247e2ebae78e4721b694"}].map(row=>Object.freeze(row))]);

export const API_PACK_SUPERVISION_SOURCE_BINDINGS=Object.freeze(API_ATTESTED_NOTICE_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:row.path==='scripts/agentfs-native-ci/supervise.py'?'139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77':row.sha256})));
const RECORDED_GITLINK_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({"packages/xpod-api/scripts/inngest-controlled-build-policy.json":"6c54f5fe5e04f0dd10dfc6b13088b74c97538f8b32fa6470ce7a60692ac92b58","scripts/lib/inngest-controlled-build.py":"77f5924c146b12af167d7601be882c890afb5dbc5c43393f2c309c3bfa028b25","scripts/lib/inngest-controlled-materials.ts":"4917b5a512fd851bfd0a181f0f1ea012c759c73a18f8cbfbccd503b77260bb16"});
export const API_RECORDED_GITLINK_SOURCE_BINDINGS=Object.freeze([...API_PACK_SUPERVISION_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:RECORDED_GITLINK_SOURCE_HASHES[row.path]??row.sha256})),Object.freeze({"path":"packages/xpod-api/scripts/inngest-website-gitlink.original.json","sha256":"99a5f5b1739ce3d02ed3f15d51e297f060c60bbd5b82d1850f7ad1abcbf5c74d"})]);
const PRE_COMPRESSED_API_SOURCE_GROUPS=Object.freeze([
 {name:"historical-descriptor",selectors:[{"path": "scripts/api-module-producer.py", "sha256": "8cfb86a4fa5de62e2938e51e459ae9c5c3bbe95cf0aaad88d59de9a9b900e920"}],secondarySelectors:[{"path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json", "sha256": "03fe62750b08a55b763c028367e3eb6d25d17128088191cf4edf3c76c0d507d6"}, {"path": "scripts/lib/inngest-controlled-build.py", "sha256": "a8746e8bed74dec2a6726a36e5aed623173d6666dfed925b2d8848fa3358aec2"}, {"path": "scripts/lib/module-source-materials.py", "sha256": "c28f194ca9767f2aeddd9cff6f633dac2280ae9c4e5d716d3273706afce81850"}],sourceBindings:API_CONTROLLED_DESCRIPTOR_SOURCE_BINDINGS},
 {name:"public-source-inputs",selectors:[{"path": "scripts/api-module-producer.py", "sha256": "8cfb86a4fa5de62e2938e51e459ae9c5c3bbe95cf0aaad88d59de9a9b900e920"}],secondarySelectors:[{"path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json", "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"}, {"path": "scripts/lib/inngest-controlled-build.py", "sha256": "6f82f617c67e70d75b2023993df3846b2caccef34c4a937cd58299cb7bcec99e"}, {"path": "scripts/lib/module-source-materials.py", "sha256": "07dbfc5531b7b3b812fe6f532141c964255b90f46ed30a05c86f6e42ef2e0ee5"}],sourceBindings:API_PUBLIC_SOURCE_BINDINGS},
 {selectors:[{"path": "scripts/api-module-producer.py", "sha256": "68ecfb5c66dd0f1882ef707e86a4c74df7d0406bb9bb68eb011bb20872ef23bf"}],secondarySelectors:[{"path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json", "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"}, {"path": "scripts/lib/inngest-controlled-build.py", "sha256": "44995b48418f3b0af1bdd3608c8b3c1307ad3cbc4c927d03a92fbf37b5a60404"}, {"path": "scripts/lib/module-source-materials.py", "sha256": "1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2"},{"path": "scripts/lib/physical-module-stage.ts", "sha256": "41bbf5387ab913625aa29663c0f2758b3b783de28f48c201d375369a7268c750"}],sourceBindings:API_RETAINED_BUDGET_SOURCE_BINDINGS},
 {selectors:[{"path": "scripts/api-module-producer.py", "sha256": "68ecfb5c66dd0f1882ef707e86a4c74df7d0406bb9bb68eb011bb20872ef23bf"}],secondarySelectors:[{"path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json", "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"}, {"path": "scripts/lib/inngest-controlled-build.py", "sha256": "44995b48418f3b0af1bdd3608c8b3c1307ad3cbc4c927d03a92fbf37b5a60404"}, {"path": "scripts/lib/module-source-materials.py", "sha256": "1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2"},{"path": "scripts/lib/physical-module-stage.ts", "sha256": "d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"}],sourceBindings:API_CATALOG_SOURCE_BINDINGS},
 {name:"root-minimal-normal-lifecycle",selectors:[{path:"scripts/api-module-producer.py",sha256:"0169bfbf726dce149e5a0fa995fd06bbe618236f1829d0575ccb0bafeea8b450"}],secondarySelectors:[{"path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json", "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"}, {"path": "scripts/lib/inngest-controlled-build.py", "sha256": "44995b48418f3b0af1bdd3608c8b3c1307ad3cbc4c927d03a92fbf37b5a60404"}, {"path": "scripts/lib/module-source-materials.py", "sha256": "1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2"}, {"path": "scripts/lib/physical-module-stage.ts", "sha256": "d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"}, {path:"scripts/lib/api-scoped-dependency-state.ts",sha256:"97ad91dbd3e01c1e3c0b5d8f503ed0203b00c750090c9e4c743347713dc502a6"}],sourceBindings:API_WORKSPACE_SOURCE_BINDINGS},
 {name:"root-minimal-physical-package-lookup",selectors:[{path:"scripts/api-module-producer.py",sha256:"0169bfbf726dce149e5a0fa995fd06bbe618236f1829d0575ccb0bafeea8b450"}],secondarySelectors:[{"path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json", "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"}, {"path": "scripts/lib/inngest-controlled-build.py", "sha256": "44995b48418f3b0af1bdd3608c8b3c1307ad3cbc4c927d03a92fbf37b5a60404"}, {"path": "scripts/lib/module-source-materials.py", "sha256": "1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2"}, {"path": "scripts/lib/physical-module-stage.ts", "sha256": "d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"}, {path:"scripts/lib/api-scoped-dependency-state.ts",sha256:"cc456784be5c5df9c5a244647694125a8c1300271a13d0dd887ddeb7ff95b389"}],sourceBindings:API_PHYSICAL_LOOKUP_SOURCE_BINDINGS},
 {name:"root-minimal-bounded-identity-diagnostic",selectors:[{path:"scripts/api-module-producer.py",sha256:"0169bfbf726dce149e5a0fa995fd06bbe618236f1829d0575ccb0bafeea8b450"}],secondarySelectors:[{"path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json", "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"}, {"path": "scripts/lib/inngest-controlled-build.py", "sha256": "44995b48418f3b0af1bdd3608c8b3c1307ad3cbc4c927d03a92fbf37b5a60404"}, {"path": "scripts/lib/module-source-materials.py", "sha256": "1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2"}, {"path": "scripts/lib/physical-module-stage.ts", "sha256": "d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"}, {path:"scripts/lib/api-scoped-dependency-state.ts",sha256:"0de4c1e9484de9b558eb8cf39c8790d6f824d718d97d29e1800cd8adb91bd64f"}],sourceBindings:API_IDENTITY_DIAGNOSTIC_SOURCE_BINDINGS},
 {name:"root-minimal-physical-peer-provider",selectors:[{path:"scripts/api-module-producer.py",sha256:"0169bfbf726dce149e5a0fa995fd06bbe618236f1829d0575ccb0bafeea8b450"}],secondarySelectors:[{"path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json", "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"}, {"path": "scripts/lib/inngest-controlled-build.py", "sha256": "44995b48418f3b0af1bdd3608c8b3c1307ad3cbc4c927d03a92fbf37b5a60404"}, {"path": "scripts/lib/module-source-materials.py", "sha256": "1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2"}, {"path": "scripts/lib/physical-module-stage.ts", "sha256": "d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"}, {path:"scripts/lib/api-scoped-dependency-state.ts",sha256:"2ff62ebe42a0bdbb936b6f3f1eaebc413893d20cbd84fc2fb70bce57d4d2a459"}],sourceBindings:API_PEER_PROVIDER_SOURCE_BINDINGS},
 {name:"root-minimal-bounded-peer-range",selectors:[{path:"scripts/api-module-producer.py",sha256:"0169bfbf726dce149e5a0fa995fd06bbe618236f1829d0575ccb0bafeea8b450"}],secondarySelectors:[{"path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json", "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"}, {"path": "scripts/lib/inngest-controlled-build.py", "sha256": "44995b48418f3b0af1bdd3608c8b3c1307ad3cbc4c927d03a92fbf37b5a60404"}, {"path": "scripts/lib/module-source-materials.py", "sha256": "1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2"}, {"path": "scripts/lib/physical-module-stage.ts", "sha256": "d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"}, {path:"scripts/lib/api-scoped-dependency-state.ts",sha256:"041d21ec80f1fdcbf229f906c26bf30447092bcc2424bf5dda98eeb9a5080c10"}],sourceBindings:API_PEER_RANGE_DIAGNOSTIC_SOURCE_BINDINGS},
 {name:"root-minimal-exact-peer-contract",selectors:[{path:"scripts/api-module-producer.py",sha256:"0169bfbf726dce149e5a0fa995fd06bbe618236f1829d0575ccb0bafeea8b450"}],secondarySelectors:[{"path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json", "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"}, {"path": "scripts/lib/inngest-controlled-build.py", "sha256": "44995b48418f3b0af1bdd3608c8b3c1307ad3cbc4c927d03a92fbf37b5a60404"}, {"path": "scripts/lib/module-source-materials.py", "sha256": "1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2"}, {"path": "scripts/lib/physical-module-stage.ts", "sha256": "d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"}, {path:"scripts/lib/api-scoped-dependency-state.ts",sha256:"e6214b853fd54eaff5e0ed157ed89f66dbdf273c9f226eaa16576764f41cc42e"}],sourceBindings:API_PEER_EXACT_CONTRACT_SOURCE_BINDINGS},
 {name:"root-minimal-equivalent-peer-payload-copy",selectors:[{path:"scripts/api-module-producer.py",sha256:"0169bfbf726dce149e5a0fa995fd06bbe618236f1829d0575ccb0bafeea8b450"}],secondarySelectors:[{"path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json", "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"}, {"path": "scripts/lib/inngest-controlled-build.py", "sha256": "44995b48418f3b0af1bdd3608c8b3c1307ad3cbc4c927d03a92fbf37b5a60404"}, {"path": "scripts/lib/module-source-materials.py", "sha256": "1871c59b9f0bfb4c0ce824123ce9cdc5f472aba11245b5e0eb45c62c4fca42e2"}, {"path": "scripts/lib/physical-module-stage.ts", "sha256": "d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"}, {path:"scripts/lib/api-scoped-dependency-state.ts",sha256:"f9edbb6e2e50e3c568268f9d7c33175a380d248d2ad4541879eac5ddd25064a1"}],sourceBindings:API_PEER_PAYLOAD_COPY_SOURCE_BINDINGS},
 {name:"root-minimal-controlled-compressed-inputs",selectors:[{path:"scripts/api-module-producer.py",sha256:"0169bfbf726dce149e5a0fa995fd06bbe618236f1829d0575ccb0bafeea8b450"}],secondarySelectors:[{"path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json", "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"}, {"path": "scripts/lib/inngest-controlled-build.py", "sha256": "d81fdd239578edd17635f26bad8d5dda2e6de7fed701057ef1f65ce52c0097fc"}, {"path": "scripts/lib/module-source-materials.py", "sha256": "b582490cdbbd2b857fa6ce20d0b5d85a73605c90b96063a3c17bf7b38be93601"}, {"path": "scripts/lib/physical-module-stage.ts", "sha256": "d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"}, {path:"scripts/lib/api-scoped-dependency-state.ts",sha256:"f9edbb6e2e50e3c568268f9d7c33175a380d248d2ad4541879eac5ddd25064a1"}],sourceBindings:API_COMPRESSED_INPUT_SOURCE_BINDINGS},
 {name:"root-minimal-compressed-original-retention",selectors:[{path:"scripts/api-module-producer.py",sha256:"bd668dc98e481496f8b2cf6a1ba97541caafc70f39acf8d8757226e4cedca588"}],secondarySelectors:[{"path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json", "sha256": "fab9a0628c0e6424f7a99bf2ca249c53b9ed2a1498d94d8d90ce226e01a7e284"}, {"path": "scripts/lib/inngest-controlled-build.py", "sha256": "d81fdd239578edd17635f26bad8d5dda2e6de7fed701057ef1f65ce52c0097fc"}, {"path": "scripts/lib/module-source-materials.py", "sha256": "b582490cdbbd2b857fa6ce20d0b5d85a73605c90b96063a3c17bf7b38be93601"}, {"path": "scripts/lib/physical-module-stage.ts", "sha256": "d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"}, {path:"scripts/lib/api-scoped-dependency-state.ts",sha256:"f9edbb6e2e50e3c568268f9d7c33175a380d248d2ad4541879eac5ddd25064a1"}],sourceBindings:API_COMPRESSED_RETENTION_SOURCE_BINDINGS},
 {name:"root-minimal-node-public-tool-input",selectors:[{path:"scripts/api-module-producer.py",sha256:"bd668dc98e481496f8b2cf6a1ba97541caafc70f39acf8d8757226e4cedca588"}],secondarySelectors:[{"path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json", "sha256": "2a199144729930c2a2927319cc52c55413785a6c85720d952caffbe36e2b555a"}, {"path": "scripts/lib/inngest-controlled-build.py", "sha256": "a983997f77ced56b382122730a0be869cbccd6c412b60c660960d963c0fac85b"}, {"path": "scripts/lib/module-source-materials.py", "sha256": "99eb684db2712cee74ae40f7ac17a55c1dcd74682162b75947203cf2628c6e16"}, {"path": "scripts/lib/physical-module-stage.ts", "sha256": "d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"}, {path:"scripts/lib/api-scoped-dependency-state.ts",sha256:"f9edbb6e2e50e3c568268f9d7c33175a380d248d2ad4541879eac5ddd25064a1"}],sourceBindings:API_NODE_PUBLIC_TOOL_SOURCE_BINDINGS},
 {name:"root-minimal-website-source-projection",selectors:[{path:"scripts/api-module-producer.py",sha256:"bd668dc98e481496f8b2cf6a1ba97541caafc70f39acf8d8757226e4cedca588"}],secondarySelectors:[{"path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json", "sha256": "bd8f3d1df1ff282dba66e7a9b4bfa68836212501253f7e60647f569d0bf855d0"}, {"path": "scripts/lib/inngest-controlled-build.py", "sha256": "9ab22ab214b191ef8e1c05f7200595026ef82f103960a0e15af01c6505e33200"}, {"path": "scripts/lib/module-source-materials.py", "sha256": "99eb684db2712cee74ae40f7ac17a55c1dcd74682162b75947203cf2628c6e16"}, {"path": "scripts/lib/physical-module-stage.ts", "sha256": "d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"}, {path:"scripts/lib/api-scoped-dependency-state.ts",sha256:"f9edbb6e2e50e3c568268f9d7c33175a380d248d2ad4541879eac5ddd25064a1"}],sourceBindings:API_WEBSITE_SOURCE_BINDINGS},
 {name:"root-minimal-website-stage-closed-originals",selectors:[{path:"scripts/api-module-producer.py",sha256:"bd668dc98e481496f8b2cf6a1ba97541caafc70f39acf8d8757226e4cedca588"}],secondarySelectors:[{"path": "packages/xpod-api/scripts/inngest-controlled-build-policy.json", "sha256": "bd8f3d1df1ff282dba66e7a9b4bfa68836212501253f7e60647f569d0bf855d0"}, {"path": "scripts/lib/inngest-controlled-build.py", "sha256": "9ab22ab214b191ef8e1c05f7200595026ef82f103960a0e15af01c6505e33200"}, {"path": "scripts/lib/module-source-materials.py", "sha256": "99eb684db2712cee74ae40f7ac17a55c1dcd74682162b75947203cf2628c6e16"}, {"path": "scripts/lib/physical-module-stage.ts", "sha256": "d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"}, {path:"scripts/lib/api-scoped-dependency-state.ts",sha256:"f9edbb6e2e50e3c568268f9d7c33175a380d248d2ad4541879eac5ddd25064a1"}],sourceBindings:API_WEBSITE_STAGE_SOURCE_BINDINGS}
,
 {name:"tracked-notice-original-closed-inputs",selectors:[{path:"scripts/api-module-producer.py",sha256:"988a1aaae9c786fefa4e0901f3a2de207401ea08f23c9154d941a640a6c70870"}],secondarySelectors:[{"path":"packages/xpod-api/scripts/inngest-controlled-build-policy.json","sha256":"bd8f3d1df1ff282dba66e7a9b4bfa68836212501253f7e60647f569d0bf855d0"},{"path":"scripts/lib/inngest-controlled-build.py","sha256":"9ab22ab214b191ef8e1c05f7200595026ef82f103960a0e15af01c6505e33200"},{"path":"scripts/lib/module-source-materials.py","sha256":"99eb684db2712cee74ae40f7ac17a55c1dcd74682162b75947203cf2628c6e16"},{"path":"scripts/lib/physical-module-stage.ts","sha256":"d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"},{"path":"scripts/lib/api-scoped-dependency-state.ts","sha256":"f9edbb6e2e50e3c568268f9d7c33175a380d248d2ad4541879eac5ddd25064a1"}],sourceBindings:API_NOTICE_SOURCE_BINDINGS},
 {name:"tracked-attested-notice-verifier-originals",selectors:[{path:"scripts/api-module-producer.py",sha256:"f6abdd37eee47c33a1df9f76b7e0fb99ce8efee88c5b40ddcaa1d7a0f66091e6"}],secondarySelectors:API_NOTICE_SOURCE_BINDINGS.filter(row=>["packages/xpod-api/scripts/inngest-controlled-build-policy.json","scripts/lib/inngest-controlled-build.py","scripts/lib/module-source-materials.py","scripts/lib/physical-module-stage.ts","scripts/lib/api-scoped-dependency-state.ts"].includes(row.path)),sourceBindings:API_ATTESTED_NOTICE_SOURCE_BINDINGS}
,
 {name:"pack-supervised-normal-module",selectors:[{"path":"scripts/api-module-producer.py","sha256":"f6abdd37eee47c33a1df9f76b7e0fb99ce8efee88c5b40ddcaa1d7a0f66091e6"}],secondarySelectors:[{"path":"packages/xpod-api/scripts/inngest-controlled-build-policy.json","sha256":"bd8f3d1df1ff282dba66e7a9b4bfa68836212501253f7e60647f569d0bf855d0"},{"path":"scripts/lib/api-scoped-dependency-state.ts","sha256":"f9edbb6e2e50e3c568268f9d7c33175a380d248d2ad4541879eac5ddd25064a1"},{"path":"scripts/lib/inngest-controlled-build.py","sha256":"9ab22ab214b191ef8e1c05f7200595026ef82f103960a0e15af01c6505e33200"},{"path":"scripts/lib/module-source-materials.py","sha256":"99eb684db2712cee74ae40f7ac17a55c1dcd74682162b75947203cf2628c6e16"},{"path":"scripts/lib/physical-module-stage.ts","sha256":"d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"},{"path":"scripts/agentfs-native-ci/supervise.py","sha256":"139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77"}],sourceBindings:API_PACK_SUPERVISION_SOURCE_BINDINGS},
 {name:"recorded-parent-gitlink-normal-module",selectors:[{"path":"scripts/api-module-producer.py","sha256":"f6abdd37eee47c33a1df9f76b7e0fb99ce8efee88c5b40ddcaa1d7a0f66091e6"}],secondarySelectors:[{"path":"packages/xpod-api/scripts/inngest-controlled-build-policy.json","sha256":"6c54f5fe5e04f0dd10dfc6b13088b74c97538f8b32fa6470ce7a60692ac92b58"},{"path":"scripts/lib/api-scoped-dependency-state.ts","sha256":"f9edbb6e2e50e3c568268f9d7c33175a380d248d2ad4541879eac5ddd25064a1"},{"path":"scripts/lib/inngest-controlled-build.py","sha256":"77f5924c146b12af167d7601be882c890afb5dbc5c43393f2c309c3bfa028b25"},{"path":"scripts/lib/module-source-materials.py","sha256":"99eb684db2712cee74ae40f7ac17a55c1dcd74682162b75947203cf2628c6e16"},{"path":"scripts/lib/physical-module-stage.ts","sha256":"d9dc03f66ca040637a6d1d2d3a405252cdd6ba71d69aad95361a53f7d94c200f"},{"path":"scripts/agentfs-native-ci/supervise.py","sha256":"139185a450f07812edc1300e24b68787012d1f334e6f27c2bb9e6b8a84d2af77"}],sourceBindings:API_RECORDED_GITLINK_SOURCE_BINDINGS},
].map(withWebsiteStageSelector));
const compressedApiSourceHashes:Readonly<Record<string,string>>=Object.freeze({"packages/xpod-api/scripts/sourcekit-producer.ts":"393f3a9b1eccd47b8b7d20954e02a267e69afd79135afab6bf2305f53644119a","scripts/lib/physical-module-archive.ts":"042ae8317b1d43d83c8bbc25038b063874f1e5e11bb0e8b25adeb954ab741635"});
export const API_COMPRESSED_ARCHIVE_SOURCE_BINDINGS=Object.freeze(API_RECORDED_GITLINK_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:compressedApiSourceHashes[row.path]??row.sha256})));
const preCompressedApiGroup=PRE_COMPRESSED_API_SOURCE_GROUPS[PRE_COMPRESSED_API_SOURCE_GROUPS.length-1]!;
const PRE_SERVICE_PACK_API_SOURCE_GROUPS:readonly (GitHubSourceBindingGroup&{readonly name?:string})[]=Object.freeze([...PRE_COMPRESSED_API_SOURCE_GROUPS,Object.freeze({...preCompressedApiGroup,name:"compressed-api-archives-normal-module",secondarySelectors:Object.freeze([...(preCompressedApiGroup.secondarySelectors??[]),...API_COMPRESSED_ARCHIVE_SOURCE_BINDINGS.filter(row=>row.path==="packages/xpod-api/scripts/sourcekit-producer.ts")]),sourceBindings:API_COMPRESSED_ARCHIVE_SOURCE_BINDINGS})]);

const servicePackApiHashes:Readonly<Record<string,string>>=Object.freeze({"scripts/prepare-package-manifest.cjs":"c85d5f092821c53d7b7893417512a26be3c6165f835a8f03507fe0d09228ebf2","scripts/workspace-package-payload.cjs":"edfdb44999a87551b744533019f5921e6098c65de7ccf63250e12858b9bcf48f"});
export const API_SERVICE_PACK_SOURCE_BINDINGS=Object.freeze(API_COMPRESSED_ARCHIVE_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:servicePackApiHashes[row.path]??row.sha256})));
const preServicePackApiGroup=PRE_SERVICE_PACK_API_SOURCE_GROUPS[PRE_SERVICE_PACK_API_SOURCE_GROUPS.length-1]!;
const PRE_INDEXED_ARCHIVE_API_SOURCE_GROUPS:readonly (GitHubSourceBindingGroup&{readonly name?:string})[]=Object.freeze([...PRE_SERVICE_PACK_API_SOURCE_GROUPS,Object.freeze({...preServicePackApiGroup,name:"service-pack-projection-normal-module",secondarySelectors:Object.freeze([...(preServicePackApiGroup.secondarySelectors??[]),...API_SERVICE_PACK_SOURCE_BINDINGS.filter(row=>row.path==="scripts/workspace-package-payload.cjs")]),sourceBindings:API_SERVICE_PACK_SOURCE_BINDINGS})]);


const indexedArchiveHashes:Readonly<Record<string,string>>=Object.freeze({"scripts/lib/physical-module-archive.ts":"76ab9f1e461c1d61f18b625cc624e7c1774e27807127a7b6295a2114f7bbb1cc"});
export const API_INDEXED_ARCHIVE_SOURCE_BINDINGS=Object.freeze(API_SERVICE_PACK_SOURCE_BINDINGS.map(row=>Object.freeze({...row,sha256:indexedArchiveHashes[row.path]??row.sha256})));
const indexedArchiveParent=PRE_INDEXED_ARCHIVE_API_SOURCE_GROUPS[PRE_INDEXED_ARCHIVE_API_SOURCE_GROUPS.length-1]!;
const PRE_SERVICE_ENTITY_API_SOURCE_GROUPS:readonly (GitHubSourceBindingGroup&{readonly name?:string})[]=Object.freeze([...PRE_INDEXED_ARCHIVE_API_SOURCE_GROUPS,Object.freeze({...indexedArchiveParent,name:"indexed-physical-archive-readback",secondarySelectors:Object.freeze([...(indexedArchiveParent.secondarySelectors??[]),...API_INDEXED_ARCHIVE_SOURCE_BINDINGS.filter(row=>row.path==="scripts/lib/physical-module-archive.ts")]),sourceBindings:API_INDEXED_ARCHIVE_SOURCE_BINDINGS})]);
const serviceEntityApiHashes:Readonly<Record<string,string>>=Object.freeze({"scripts/workspace-package-payload.cjs":"89a63085908a414251a34d0fae5143a6a20c28e4b8dfb05d3ea8b9113b8fdc49","scripts/lib/independent-admission/legal-registry-originals.ts":"44c3e6527fea0325a6e861fc94596c6882d15d51f544dbfaeafd34fdd34316f5"});
const serviceEntityApiParent=PRE_SERVICE_ENTITY_API_SOURCE_GROUPS[PRE_SERVICE_ENTITY_API_SOURCE_GROUPS.length-1]!;
export const API_SERVICE_ENTITY_SOURCE_BINDINGS=Object.freeze(serviceEntityApiParent.sourceBindings.map(row=>Object.freeze({...row,sha256:serviceEntityApiHashes[row.path]??row.sha256})));
const PRE_BUILD_API_GROUPS:readonly (GitHubSourceBindingGroup&{readonly name?:string})[]=Object.freeze([...PRE_SERVICE_ENTITY_API_SOURCE_GROUPS,Object.freeze({...serviceEntityApiParent,name:"service-registry-originals-and-exact-member-modes",secondarySelectors:Object.freeze([...(serviceEntityApiParent.secondarySelectors??[]).map(row=>Object.freeze({...row,sha256:serviceEntityApiHashes[row.path]??row.sha256})),...API_SERVICE_ENTITY_SOURCE_BINDINGS.filter(row=>Object.prototype.hasOwnProperty.call(serviceEntityApiHashes,row.path)&&!(serviceEntityApiParent.secondarySelectors??[]).some(role=>role.path===row.path))]),sourceBindings:API_SERVICE_ENTITY_SOURCE_BINDINGS})]);
const buildApiHashes:Readonly<Record<string,string>>=Object.freeze({"packages/xpod-api/scripts/pack.ts":"b44ade87dff77d4cae687f9c19f14ed9511c20e5e54acafacbac975186dbfa32","scripts/lib/module-source-materials.py":"d0bcdbdec78a1bdb2cebb90910b4dd7c678c5027fc9856fc5475961b3da10dd1","scripts/lib/independent-admission/legal-registry-originals.ts":"3070327262f7c8bdeef21ea0fe1b3e633e4710b05d6994f80bee974da779f74a"});
const buildApiParent=PRE_BUILD_API_GROUPS[PRE_BUILD_API_GROUPS.length-1]!;
const apiServiceBuildSourceBindings25=Object.freeze(buildApiParent.sourceBindings.map(row=>Object.freeze({...row,sha256:buildApiHashes[row.path]??row.sha256})));
function rebindApiCaptureInputRows<T extends {readonly path:string;readonly sha256:string}>(rows:readonly T[]|undefined):readonly T[]{
  return Object.freeze((rows??[]).map(row=>Object.freeze((row.path==='scripts/lib/inngest-controlled-build.py'?{...row,sha256:'b71657667db6587a4cab1390170a274b0b54fdaf2db50c1ec89587b12231752d'}:row) as T)));
}
const apiControlledDescriptorSourceGroup25=Object.freeze({...buildApiParent,name:"service-build-source-and-protocol-causality",secondarySelectors:Object.freeze([...(buildApiParent.secondarySelectors??[]).map(row=>Object.freeze({...row,sha256:buildApiHashes[row.path]??row.sha256})),...apiServiceBuildSourceBindings25.filter(row=>Object.prototype.hasOwnProperty.call(buildApiHashes,row.path)&&!(buildApiParent.secondarySelectors??[]).some(role=>role.path===row.path))]),sourceBindings:apiServiceBuildSourceBindings25});
const apiCaptureInputsTimingGroup=Object.freeze({...apiControlledDescriptorSourceGroup25,name:"api-capture-inputs-timing",selectors:rebindApiCaptureInputRows(apiControlledDescriptorSourceGroup25.selectors),secondarySelectors:rebindApiCaptureInputRows(apiControlledDescriptorSourceGroup25.secondarySelectors),sourceBindings:rebindApiCaptureInputRows(apiControlledDescriptorSourceGroup25.sourceBindings)});
const apiPerformanceHashes:Readonly<Record<string,string>>={"scripts/lib/inngest-controlled-build.py":"5f0dc7f2d58dc57ea268d5cd2733a4a95fa77ac77a672078d4134bbca2fe41de","scripts/lib/physical-module-archive.ts":"01a27c05e2541449ec843e9a62bfc6b76f3c95f916b624f522415c006b99bd34"};
const rebindApiPerformanceRows=(rows:GitHubSourceBindingGroup['sourceBindings']|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:apiPerformanceHashes[row.path]??row.sha256})));
const apiCapturePerformanceGroup=Object.freeze({...apiCaptureInputsTimingGroup,name:'api-capture-performance',selectors:rebindApiPerformanceRows(apiCaptureInputsTimingGroup.selectors),secondarySelectors:rebindApiPerformanceRows(apiCaptureInputsTimingGroup.secondarySelectors),sourceBindings:rebindApiPerformanceRows(apiCaptureInputsTimingGroup.sourceBindings)});
/** Final combined slice: the newest published API recipe re-bound to the ACTUAL
* final tree bytes. Only roles whose real bytes changed are re-hashed; the four
* published groups above stay byte-identical. */
const finalJointApiHashes:Readonly<Record<string,string>>=Object.freeze({
 "scripts/workspace-package-payload.cjs":"f88176458eba63d238cf99412bbc834143fe6b1e74089b27c290c0be040d2d33",
 "scripts/workspace-runtime-materials.cjs":"dbecd348e945a664b182c1a09ce2185d336085651f05582d254e3fcc0ab8feee",
 "scripts/lib/independent-admission/legal-registry-originals.ts":"a764214bed261f37a1c22117b0c6c4577fbf676cc834e99f870af3eba827517a",
 "packages/xpod-cli/scripts/build-package.ts":"569cc8e59141ce02d16df6ef9745d9fb8e3d77dd4c1440e6073aac8c8da2bb46",
 "packages/xpod-client/scripts/build.ts":"4970c1586831229eb532b63f109787b7f2126d12aa87c5266a178bca17140c65"});
const rebindFinalApiRows=(rows:GitHubSourceBindingGroup['sourceBindings']|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:finalJointApiHashes[row.path]??row.sha256})));
const apiFinalJointGroup=Object.freeze({...apiCapturePerformanceGroup,name:'api-final-joint-source',selectors:rebindFinalApiRows(apiCapturePerformanceGroup.selectors),secondarySelectors:rebindFinalApiRows(apiCapturePerformanceGroup.secondarySelectors),sourceBindings:rebindFinalApiRows(apiCapturePerformanceGroup.sourceBindings)});
/** ORM 0.3.26 moved exactly these three API source facts: the two manifest
 * facts and the joined legal-registry helper. Only they are re-hashed; the
 * published f803 `api-final-joint-source` group above stays byte-identical. */
const ORM326_API_SOURCE_HASHES:Readonly<Record<string,string>>=Object.freeze({
 "bun.lock":"ff70b48d929511d94b9350abbb91ee4980aa9e86532190574fe2f3e42b221042",
 "package.json":"f07277658e7d111655eb52ba560d6c2f2b3b3652a38ad0f137b2cb0812c206f6",
 "scripts/lib/independent-admission/legal-registry-originals.ts":"97ddc06639a4ec3a264ea42310e5db0dee8c17e7f31aaed627fca0f508cfe578"
});
const rebindOrm326ApiRows=(rows:readonly {readonly path:string;readonly sha256:string}[]|undefined)=>Object.freeze((rows??[]).map(row=>Object.freeze({...row,sha256:ORM326_API_SOURCE_HASHES[row.path]??row.sha256})));
/** Strict old/new discriminator: the 0.3.26 patch exists only in the current
 * tree, so declaring it PRIMARY separates this tail from every earlier tuple by
 * actual bytes (absent => old tail, present => this tail) with no fallback. */
const ORM326_PATCH_26='patches/@undefineds.co%2Fdrizzle-solid@0.3.26.patch';
const ORM326_PATCH_26_SHA='15917daa88260327bb30d5da25d9db7efb0fd3386c7f0494102fa780ac870789';
const apiOrm326JointGroup=Object.freeze({...apiFinalJointGroup,name:'api-orm-0.3.26-joint-source',
 selectors:Object.freeze([...apiFinalJointGroup.selectors,Object.freeze({path:ORM326_PATCH_26,sha256:ORM326_PATCH_26_SHA})]),
 secondarySelectors:rebindOrm326ApiRows(apiFinalJointGroup.secondarySelectors),
 sourceBindings:Object.freeze([...rebindOrm326ApiRows(apiFinalJointGroup.sourceBindings),Object.freeze({path:ORM326_PATCH_26,sha256:ORM326_PATCH_26_SHA})])});
/** CURRENT API tuple. The published f803 group and its exact row value above
 * remain selectable and unchanged. */
export const API_SERVICE_BUILD_SOURCE_BINDINGS=apiOrm326JointGroup.sourceBindings;
export const API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS:readonly (GitHubSourceBindingGroup&{readonly name?:string})[]=Object.freeze([...PRE_BUILD_API_GROUPS,apiControlledDescriptorSourceGroup25,apiCaptureInputsTimingGroup,apiCapturePerformanceGroup,apiFinalJointGroup,apiOrm326JointGroup]);

export const API_WORKSPACE_SOURCE_GROUPS=Object.freeze(API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS.filter(group=>group.sourceBindings.some(row=>row.path==='scripts/lib/api-scoped-dependency-state.ts')));




function cssStagingParentPolicy(jobName: string): Pick<OriginPolicy,'reviewedWorkflowVersions'|'stagingPushWorkflowSha256'> {
 return {reviewedWorkflowVersions:[{workflowSha256:CSS_STAGING_PARENT_SHA,jobName:()=>jobName}],stagingPushWorkflowSha256:CSS_STAGING_PARENT_SHA};
}
/** The mac native producer's cached-verification step now forwards the resolved
 * `macos-<arch>` ABI to `verify-qlever-local` instead of letting it default to
 * arm64. That is the ONLY change from the previously reviewed 39609410 bytes:
 * reverting the argument and its preceding line continuation restores the
 * 39609410 bytes exactly. It is
 * registered as one more compatible reviewed version; every prior digest stays
 * admitted and each run still has to match one exact whole file. */
const CSS_MACOS_RESOLVED_TARGET_SHA='fc16e99666714ca9fc79605f1382bf99dfb74add7a681d85ad76b8830c2f057b';
const CSS_NATIVE_SOURCE_BINDINGS=[
 {path:'.github/workflows/css-native-product-target.yml',sha256:'49ee4c223de857cb9d500a7dceb4a54f36ae8759d1d8b3cc9a7b847db3bbf877'},
 {path:'.github/workflows/css-native-source.yml',sha256:'df05d53b957d7b793dd998d46ccbc9a7dea788ac7f341f5e5472e325897a0371'},
 {path:'scripts/module-product-targets.ts',sha256:'5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4'},
 {path:'.github/workflows/build-qlever-macos-runtime.yml',sha256:'76238a58da3384d10d1d1537211540f289531a3c74b43c854c2eb37ec2cb768c',reviewedSha256:['39609410c84a0913e685bd1fb1e5c9ef4e104fd2f04332c179dd3b4f08d3c830',CSS_MACOS_RESOLVED_TARGET_SHA]},
 {path:'.github/workflows/publish-qlever-runtime-sdk.yml',sha256:'cbedd3e2478de5e22108b6689c595a658ca891c9bd47552caec830e86f47fea8'},
] as const;

const CSS_MAC_SOURCE_GROUPS:readonly GitHubSourceBindingGroup[]=Object.freeze([
 ...[CSS_NATIVE_SOURCE_BINDINGS.find(row=>row.path==='.github/workflows/css-native-source.yml')!.sha256,'24b994047fac340931a7f43e1e44d7d0d5876a8023acb8e54495f754d0f44b53'].map(cssSha=>Object.freeze({
  selectors:Object.freeze([{path:'.github/workflows/css-native-source.yml',sha256:cssSha}]),
  sourceBindings:Object.freeze([...CSS_NATIVE_SOURCE_BINDINGS.filter(row=>!['.github/workflows/css-native-source.yml','.github/workflows/publish-qlever-runtime-sdk.yml'].includes(row.path)),{path:'.github/workflows/css-native-source.yml',sha256:cssSha},{path:QLEVER_OBSERVER_PATH,sha256:QLEVER_OBSERVER_V20,reviewedSha256:[QLEVER_OBSERVER_V22,QLEVER_OBSERVER_V23]}]),
 })),
]);
function cssLinuxAncestors(group:GitHubSourceBindingGroup|undefined,target:string,product:boolean):readonly string[]{
 const prefix=`targets (${target}) / native / linux / `;
 return [prefix+(group?.outerExecutor?'readonly_publish / published_sdk / sdk':'publish'),prefix+'module_runtime_materials / runtime / publish',...(product?[prefix+'module_runtime_materials / archive']:[])];
}

/** The normal (NORMAL-path) CSS product workflow advanced to 16f3781a when the
 * diagnostic-payload retention step was added. That is the ONLY change from the
 * previously reviewed 9f14303a bytes: restore the artifact `path:` block to its
 * prior form and the 9f bytes come back exactly. It is registered as one more
 * compatible reviewed version — every prior digest stays admitted, and each run
 * must still match one exact whole file. This is the NORMAL product workflow;
 * the CONTROLLED `css-native-products` workflow (601aa8fe) is untouched and must
 * NOT be added to CSS_SOURCE_PARENT_VERSIONS. */
const CSS_NORMAL_WORKFLOW_SHA='16f3781aa25d8a89167538babfcd6bd1eaa8556a54831a1ee78450d158ef2286';

/** Product origin uses the canonical target/native-source declaration. A
 * declared target is still unverified until its exact successful run is seen. */
export async function observeModuleProductGitHubOrigin(input: ArtifactAcquisitionInput, module: 'api' | 'css',
  target: string, options: { token?: string } = {}): Promise<GitHubOriginObservation> {
  const row = productTarget(module, target);
  if (!row.nativeSourceAvailable&&module!=='css') return fail('module target has no declared native source');
  const policies = {
    api: { workflowSha256: 'e9326b1254fbcf933cbbe09c41f5dcf492bfa70ff265d2ea1cd0589c11d4da98',
      previousShortWorkflowSha256: '2c1c1414496c82f54162a4933933f83f1743f4a4dc5122c969424b7ca38e4f56',
      legacyWorkflowSha256: '01b77f7efb14942ec3c50f58d871fecd0059f230f7648b830c8820a1e8c56373',
      requiredStep: 'Produce the actual API preview once' },
    css: { workflowSha256: '9f14303a0736391b250598c21211dc5312565adf5bf30256a4f9c61f13cc8257',
      previousShortWorkflowSha256: '454baf86f674c2c3b5058ad012c09d968c26e4f7d282d702df745a16978542b3',
      legacyWorkflowSha256: 'ba79405debc84174b23efc2dbf5fd41b54b1f0fd02f1349e4a7e9efe8c0eaddf',
      requiredStep: 'Produce the normal CSS preview' },
  } as const;
  const legacy:OriginPolicy={
    ...policies[module], workflowPath: `.github/workflows/${module}-module-product.yml`,
    ...(module==='api'?{stagingPushWorkflowSha256s:['db6ca21afa33d572f24a92e96c88f425d1bf46a86d966a55be4c10de4d812263','c4aa6b7ea6e384adab1e517a903e50d574c8afb2eb92d8c54dc919320652c5b0','b7a91e8c0b61f8a80a3de2c6c93e78f1d2f9637a741bff7ac2592882ba0c831e','04f75d2913e3b6b504cf547d8ba17d1c0011a0a563f42ff708f4ba3f10978153']}:{}),
    events: module==='api'?['workflow_dispatch','pull_request','push']:['workflow_dispatch','pull_request'], target,
    sourceBindings: [{ path: 'scripts/module-product-targets.ts', sha256: 'd04fb106ca349179e4b99869c68cbb85b8d9a9f30e8d60b927a5eceab9e2f25f',reviewedSha256:['5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4'] }],
    artifactNames: coordinates => [`${module}-module-products-${target}-${coordinates.sourceSha}-${coordinates.runId}-${coordinates.runAttempt}`],
    jobName: () => `products (${target})`,
    // The old reviewed workflow used GitHub's implicit matrix display name.
    reviewedWorkflowVersions: [...(module==='api'?[{workflowSha256:'db6ca21afa33d572f24a92e96c88f425d1bf46a86d966a55be4c10de4d812263',jobName:()=>`products (${target})`,sourceBindingGroups:API_WORKSPACE_SOURCE_GROUPS},{workflowSha256:'04f75d2913e3b6b504cf547d8ba17d1c0011a0a563f42ff708f4ba3f10978153',jobName:()=>`products (${target})`,sourceBindingGroups:API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS},{workflowSha256:'b7a91e8c0b61f8a80a3de2c6c93e78f1d2f9637a741bff7ac2592882ba0c831e',jobName:()=>`products (${target})`,sourceBindings:API_CONTROLLED_SOURCE_BINDINGS},{workflowSha256:'c4aa6b7ea6e384adab1e517a903e50d574c8afb2eb92d8c54dc919320652c5b0',jobName:()=>`products (${target})`}]:[]), { workflowSha256: policies[module].previousShortWorkflowSha256, jobName: () => `products (${target})`,
      sourceBindings: [{ path: 'scripts/module-product-targets.ts', sha256: '35b8752237d620981b1848d6d8876dfac3c1da14509e77358e7f961ca256cf96' }] },
      { workflowSha256: policies[module].legacyWorkflowSha256, jobName: () => `products (${Object.values(row).join(', ')})`,
        sourceBindings: [{ path: 'scripts/module-product-targets.ts', sha256: '35b8752237d620981b1848d6d8876dfac3c1da14509e77358e7f961ca256cf96' }] },
      // CURRENT normal CSS workflow version (append-only). The previously reviewed
      // 9f14303a above stays admitted, and the same reviewed module-product-targets
      // closure is required, so this adds a version rather than replacing a proof.
      ...(module==='css'?[{ workflowSha256: CSS_NORMAL_WORKFLOW_SHA,
        jobName: () => `products (${target})` }]:[])],
  };
  const current:OriginPolicy={workflowPath:CSS_NATIVE_PRODUCTS_WORKFLOW,workflowSha256:CSS_NATIVE_PARENT_SHA,
    ...cssStagingParentPolicy(`targets (${target}) / products`),events:['workflow_dispatch','push'],target,artifactNames:coordinates=>[`css-module-products-${target}-${coordinates.sourceSha}-${coordinates.runId}-${coordinates.runAttempt}`],
    jobName:()=>`targets (${target}) / products`,requiredStep:'Produce the normal CSS preview',requiredSteps:['Upload original preview and evidence'],
    // Only the actually executed target branch participates. Linux SDK changes
    // do not silently authorize Linux, or block a separately reviewed Mac run.
    ...(target.startsWith('linux-')?{sourceBindingGroups:QLEVER_LINUX_EXECUTION_GROUPS}:{sourceBindingGroups:CSS_MAC_SOURCE_GROUPS}),
    ...(target.startsWith('linux-')?{sourceGroupAncestorJobs:(group:GitHubSourceBindingGroup|undefined)=>cssLinuxAncestors(group,target,true)}:{requiredAncestorJobs:[`targets (${target}) / native / macos / build`]})};
  const observation=await observeGitHubOrigin(input,options,module==='css'?(row.nativeSourceAvailable?[legacy,current]:current):legacy);
  normalModuleOrigins.add(observation);return observation;
}

/** The mounted-module workflow had to move its darwin-arm64 matrix entry from
 * the capacity-starved `macos-14` hosted image to the repository's already
 * exercised `macos-15` Darwin ARM64 image (same `darwin-arm64` target, same six
 * mounted cases, same NFS driver). The ONLY byte difference from the previously
 * reviewed 854cc2a4 bytes is that one `runs-on` value: restoring it reproduces
 * 854cc2a4 exactly. Every older reviewed version stays admitted, so historical
 * runs keep verifying; every run still has to match one exact whole file. */
export const AFS_MODULE_MOUNTED_WORKFLOW_SHA256S=Object.freeze([
  'ccf5f21a6681425ffac52c8efc9547a22b7962310822c84479a39602f466a343',
  '854cc2a40d0e9bd3d41deb339fbc239693a9f7811cf035be1768a9b496cbb043',
  'c6420bc5699a84a8adf98a19841cb09e3df155370622d1b7e982cd08064ca4bf',
] as const);
/** Normal AFS products come from the mounted-module workflow, independently
 * of the upstream native acceptance workflow and its distinct source revision. */
export async function observeAfsModuleProductGitHubOrigin(input: ArtifactAcquisitionInput, target: string,
  options: { token?: string } = {}): Promise<GitHubOriginObservation> {
  if (!MODULE_TARGETS.some(row => `${row.platform}-${row.arch}` === target)) return fail('unsupported normal AFS target');
  return observeGitHubOrigin(input, options, {
    workflowPath: '.github/workflows/agentfs-module-mounted-acceptance.yml',
    workflowSha256: AFS_MODULE_MOUNTED_WORKFLOW_SHA256S[0],
    reviewedWorkflowVersions:AFS_MODULE_MOUNTED_WORKFLOW_SHA256S.slice(1).map(workflowSha256=>({
      workflowSha256,jobName:()=>`mounted-module (${target})`,
    })),
    events: ['push', 'workflow_dispatch', 'pull_request'], target,
    artifactNames: row => [`afs-module-production-${target}-${row.sourceSha}-${row.runId}-${row.runAttempt}`],
    requiredStep: 'Produce controlled normal AFS source and product originals',
    requiredSteps: ['Upload controlled normal AFS product originals'],
    jobName: () => `mounted-module (${target})`,
  });
}

/** Observes the existing four-target native producer using the same issuer.
 * This hash reviews the workflow transport boundary only. It does not admit
 * native build inputs, binaries, ABI or a containing module's source revision. */
export async function observeAgentFsNativeGitHubOrigin(input: ArtifactAcquisitionInput, target: string,
  options: { token?: string } = {}): Promise<GitHubOriginObservation> {
  if (!MODULE_TARGETS.some(row => `${row.platform}-${row.arch}` === target)) return fail('unsupported native target');
  const linux = target.startsWith('linux-');
  const observation = await observeGitHubOrigin(input, options, {
    workflowPath: '.github/workflows/agentfs-native-acceptance.yml',
    workflowSha256: '16b9b9e1fce46671f50080765c3c590daef0606a5cdf767c22fe4719ac72d310',
    events: ['push', 'workflow_dispatch', 'pull_request'], target,
    artifactNames: row => [`agentfs-native-${target}-${row.sourceSha}`],
    jobName: () => `native (${target}${linux ? ', bookworm' : ''})`,
    requiredStep: linux ? 'Build, test, package and Node/noBun admit inside Bookworm'
      : 'Official export, offline rebuild, package and extracted install gate',
  });
  nativeOrigins.add(observation); return observation;
}

/** QLever native artifacts have their own producer identity. A reusable job
 * belongs to its caller's run; it is never a normal CSS product observation. */
export async function observeQleverNativeGitHubOrigin(input:ArtifactAcquisitionInput,target:string,
  invocation:'standalone'|'css-module'|'css-native-products',options:{token?:string}={}):Promise<GitHubOriginObservation>{
  if(invocation==='css-native-products'){
    if(['linux-x64','linux-arm64'].includes(target)){
      const observation=await observeGitHubOrigin(input,options,{
        workflowPath:CSS_NATIVE_PRODUCTS_WORKFLOW,workflowSha256:CSS_NATIVE_PARENT_SHA,...cssStagingParentPolicy(`targets (${target}) / native / linux / module_runtime_materials / archive`),events:['workflow_dispatch','push'],target,
        artifactNames:row=>[`qlever-local-runtime-${target}-${row.sourceSha}-${row.runId}-${row.runAttempt}`],
        jobName:()=>`targets (${target}) / native / linux / module_runtime_materials / archive`,
        requiredStep:'Bind fresh native material output identity',
        requiredSteps:['Produce native source and ABI original materials','Upload exact native build and test materials'],
        sourceGroupAncestorJobs:group=>cssLinuxAncestors(group,target,false),
        sourceBindingGroups:QLEVER_LINUX_EXECUTION_GROUPS,
      });nativeOrigins.add(observation);return observation;
    }
    if(!['darwin-arm64','darwin-x64'].includes(target))return fail('unsupported CSS native original target');
    const observation=await observeGitHubOrigin(input,options,{
      workflowPath:CSS_NATIVE_PRODUCTS_WORKFLOW,workflowSha256:CSS_NATIVE_PARENT_SHA,...cssStagingParentPolicy(`targets (${target}) / native / macos / build`),events:['workflow_dispatch','push'],target,
      artifactNames:row=>[`qlever-local-runtime-${target}-${row.sourceSha}`],
      jobName:()=>`targets (${target}) / native / macos / build`,requiredStep:'Bind the qlever-local acceptance evidence',
      requiredSteps:['Verify the actual native producer host','Resolve immutable artifact identity','Upload the exact native runtime'],
      sourceBindingGroups:CSS_MAC_SOURCE_GROUPS,
    });nativeOrigins.add(observation);return observation;
  }
  if(!['darwin-arm64','darwin-x64'].includes(target) || !['standalone','css-module'].includes(invocation)) return fail('unsupported QLever native invocation');
  // The reviewed CSS caller supplies no target and therefore invokes the
  // reusable workflow's darwin-arm64 default. x64 must use its standalone run.
  if(invocation==='css-module' && target!=='darwin-arm64') return fail('reviewed CSS native caller only produces darwin-arm64');
  const nativeWorkflow='.github/workflows/build-qlever-macos-runtime.yml';
  const nativeHash=CSS_MACOS_RESOLVED_TARGET_SHA;
  const previousNativeHash='39609410c84a0913e685bd1fb1e5c9ef4e104fd2f04332c179dd3b4f08d3c830';
  const oldestNativeHash='76238a58da3384d10d1d1537211540f289531a3c74b43c854c2eb37ec2cb768c';
  const observation=await observeGitHubOrigin(input,options,{
    workflowPath:invocation==='standalone'?nativeWorkflow:'.github/workflows/css-module-product.yml',
    workflowSha256:invocation==='standalone'?nativeHash:CSS_NORMAL_WORKFLOW_SHA,
    ...(invocation==='css-module'?{reviewedWorkflowVersions:[{
      workflowSha256:'454baf86f674c2c3b5058ad012c09d968c26e4f7d282d702df745a16978542b3',jobName:()=> 'native / build',
    },{
      // Prior reviewed normal CSS product workflow stays admitted alongside the
      // current 16f above; each run must still match one exact whole file.
      workflowSha256:'9f14303a0736391b250598c21211dc5312565adf5bf30256a4f9c61f13cc8257',jobName:()=> 'native / build',
    }]}:{reviewedWorkflowVersions:[
      {workflowSha256:previousNativeHash,jobName:()=> 'build'},
      {workflowSha256:oldestNativeHash,jobName:()=> 'build'},
    ]}),
    events:invocation==='standalone'?['push','workflow_dispatch']:['push','workflow_dispatch','pull_request'],target,
    artifactNames:row=>[`qlever-local-runtime-${target}-${row.sourceSha}`],
    jobName:()=>invocation==='standalone'?'build':'native / build',
    requiredStep:'Bind the qlever-local acceptance evidence',
    requiredSteps:['Verify the actual native producer host','Resolve immutable artifact identity','Upload the exact native runtime'],
    sourceBindings:[...(invocation==='css-module'?[{path:nativeWorkflow,sha256:nativeHash,reviewedSha256:[previousNativeHash,oldestNativeHash]}]:[]),
      {path:'qlever/scripts/observe-macos-native-materials.py',sha256:'79e34893b946458a904544ddb1cce9110a19fe5052503570c865341e7d0ff6d6',
        reviewedSha256:['a92b227ec186a0f53f85c93a732a0542ee3b712fdb571308395ecf17c07b2d86',QLEVER_OBSERVER_V20,QLEVER_OBSERVER_V22,QLEVER_OBSERVER_V23]}],
  });
  nativeOrigins.add(observation); return observation;
}

/** SDK byte custody is independently observed, never inferred from a runtime
 * image reference or a normal CSS product observation. */
export async function observeQleverSdkGitHubOrigin(input:ArtifactAcquisitionInput,target:string,invocation:'standalone'|'css-native-products'|'candidate-service',options:{token?:string}={}):Promise<GitHubOriginObservation>{
 if(invocation==='candidate-service'){
  if(target!=='linux-x64')return fail('candidate service SDK target differs');
  const groups=QLEVER_SDK_EXECUTION_GROUPS.filter(group=>group.candidateServiceRelationship!==undefined);
  if(!groups.length)return fail('candidate service SDK whole source not reviewed');
  const versions=[...new Set(groups.map(group=>group.candidateServiceRelationship!.workflowSha256))];
  const observation=await observeGitHubOrigin(input,options,{workflowPath:'.github/workflows/candidate.yml',workflowSha256:versions[0]!,reviewedWorkflowVersions:versions.map(workflowSha256=>({workflowSha256,jobName:()=> 'publish_qlever_runtime_sdk / readonly_publish / published_sdk / sdk',sourceBindingGroups:groups})),events:['push','workflow_dispatch'],requiredBranch:'staging',stagingPushWorkflowSha256s:versions,workflowRef:'run-head',allowRunningRun:true,allowCandidateProducerFailure:true,target,artifactNames:row=>[`qlever-sdk-originals-service-trixie-${target}-${row.sourceSha}-${row.runId}-${row.runAttempt}`],jobName:()=> 'publish_qlever_runtime_sdk / readonly_publish / published_sdk / sdk',requiredStep:'Bind actual readonly SDK image and build originals',requiredSteps:['Verify controller closure','Capture immutable source context','Build readonly SDK and linked image','Publish the actual linked readonly SDK','Seal controller originals for upload','Upload exact SDK original materials'],sourceBindingGroups:groups,issueSdkOuterAuthority:true});
  nativeOrigins.add(observation);sdkOrigins.add(observation);return observation;
 }
 if(!['linux-x64','linux-arm64'].includes(target)||!['standalone','css-native-products'].includes(invocation))return fail('fixed SDK target and invocation required');
 const nested=invocation==='css-native-products';
 const readonlyName=nested?`targets (${target}) / native / linux / readonly_publish / published_sdk / sdk`:'readonly_publish / published_sdk / sdk';
 const legacyName=nested?`targets (${target}) / native / linux / publish`:'publish';
 const legacySteps=['Verify the actual native producer host','Build actual cold module SDK with owned raw streams','Push exact tested module SDK from the same builder cache','Upload exact SDK original materials'];
 const readonlySteps=['Verify controller closure','Capture immutable source context','Build readonly SDK and linked image','Publish the actual linked readonly SDK','Seal controller originals for upload','Upload exact SDK original materials'];
 const observation=await observeGitHubOrigin(input,options,{
  workflowPath:nested?CSS_NATIVE_PRODUCTS_WORKFLOW:QLEVER_SDK_WORKFLOW,workflowSha256:nested?CSS_NATIVE_PARENT_SHA:QLEVER_SDK_WORKFLOW_SHA,
  ...(nested?cssStagingParentPolicy(legacyName):{reviewedWorkflowVersions:[{workflowSha256:QLEVER_READONLY_SDK_WORKFLOW_SHA,jobName:()=>readonlyName},{workflowSha256:QLEVER_SERVICE_SDK_WORKFLOW_SHA,jobName:()=>readonlyName},{workflowSha256:QLEVER_CURRENT_SDK_WORKFLOW_SHA,jobName:()=>readonlyName}]}),
  events:nested?['workflow_dispatch','push']:['workflow_dispatch'],target,
  artifactNames:row=>[`qlever-sdk-originals-${target}-${row.sourceSha}-${row.runId}-${row.runAttempt}`],
  jobName:()=>legacyName,requiredStep:'Bind actual SDK image and build originals',requiredSteps:legacySteps,
  sourceGroupJobContract:group=>group?.outerExecutor?{name:readonlyName,requiredStep:'Bind actual readonly SDK image and build originals',requiredSteps:readonlySteps}:{name:legacyName,requiredStep:'Bind actual SDK image and build originals',requiredSteps:legacySteps},
  sourceBindingGroups:QLEVER_SDK_EXECUTION_GROUPS,issueSdkOuterAuthority:true,
 });
 nativeOrigins.add(observation);sdkOrigins.add(observation);return observation;
}

/** Consumer-only policy allows a live reviewed controller run to re-observe
 * its already closed matching-host job. Other producer policies stay closed. */
export async function observeProductConsumerGitHubOrigin(input:ArtifactAcquisitionInput,
  product:{module:'client'|'cli'|'api'|'css'|'afs';target?:string;stage:'prepublish'|'postpublish'},options:{token?:string}={}):Promise<GitHubOriginObservation>{
  const coordinates={...product,sourceSha:input.sourceSha,runId:input.runId,runAttempt:input.runAttempt};
  const expected=product.stage==='prepublish'?archiveConsumerArtifactName(coordinates):registryConsumerArtifactName(coordinates);
  if(!['prepublish','postpublish'].includes(product.stage))return fail('fixed consumer stage required');
  const suffix=product.module+'-'+(product.target??'portable'),pre=product.stage==='prepublish';
  const names=pre?[`pre-${suffix} / archive-consumer-${suffix}`]:Array.from({length:14},(_,i)=>`wave-${String(i+1).padStart(2,'0')} / registry-${suffix} / registry-consumer-${suffix}`);
  const manual:OriginPolicy={
    workflowPath:'.github/workflows/independent-publication.yml',workflowSha256:'63a34359c5afa9cf318e1505f22d5353d832d8b5220ce774675132b5fc75d103',
    reviewedWorkflowVersions:[CALLABLE_PUBLICATION_WORKFLOW_SHA,STAGING_CHECKED_PUBLICATION_WORKFLOW_SHA].map(workflowSha256=>({workflowSha256,jobName:()=>names[0]!})),
    workflowRef:'run-head',sourceMayDiffer:true,allowRunningRun:true,maximumJobPages:8,
    events:['workflow_dispatch'],...(product.target?{target:product.target}:{}),
    artifactNames:()=>[expected],jobName:()=>names[0]!,jobNames:()=>names,
    requiredStep:pre?'Run fixed archive-installed product consumer':'Run fixed registry-installed product consumer',
    requiredSteps:[pre?'Upload archive consumer originals':'Upload registry consumer originals'],
    sourceBindingGroups:CONSUMER_SOURCE_GROUPS,
  };
  const callerNames=names.map(name=>'independent-publication / '+name);
  const registered:OriginPolicy={...manual,
    workflowPath:'.github/workflows/ci.yml',workflowSha256:CI_PUBLICATION_WORKFLOW_SHA,
    reviewedWorkflowVersions:[{workflowSha256:'d587e9fc889409a30814098fdfda9f00b322423fe47af52f70f9a6e2d7dc48bf',
      jobName:()=>callerNames[0]!,
      sourceBindingGroups:CI_CONSUMER_SOURCE_GROUPS},
      // APPEND-ONLY: the `test` job now checks out full Git history so the real
      // 9d02/2406/19fe commit readers resolve, and it runs the dedicated SDK70
      // executable-memory remap gate. Same jobs and sources; the published
      // d587e9fc version above stays byte-identical and remains selectable.
      // The earlier fetch-depth-only variant 09208b75 was never published, so this
      // genuine current file replaces it rather than remaining as fake history.
      {workflowSha256:'7b5a920f0dc7920e47565315fe2da2ac94ad92fda43cd6426f7387a12a9359d4',
      jobName:()=>callerNames[0]!,
      sourceBindingGroups:CI_CONSUMER_SOURCE_GROUPS},
      // APPEND-ONLY (both versions above stay byte-identical and selectable): the
      // SDK70 gate now runs as root because the real child authority drop uses
      // PR_CAPBSET_DROP and needs CAP_SETPCAP on an unprivileged CI host. Same
      // gate source, same declared compiler, same 18 canonical E2E cases.
      {workflowSha256:'3ff5f524e82c30d732a1cefadbf87b6372da61e3e9f5b025507d305642e6990c',
      jobName:()=>callerNames[0]!,
      sourceBindingGroups:CI_CONSUMER_SOURCE_GROUPS},
      // The scoped-PCH/compiler gates and complete Python regression discovery
      // retain the same exact registered publication jobs and source contracts.
      // Preserve every earlier reviewed caller version above.
      {workflowSha256:'5a6d6a0c3b693db00faf3c30d52c3af59e90674d6db14a70574311f7203d106d',
      jobName:()=>callerNames[0]!,
      sourceBindingGroups:CI_CONSUMER_SOURCE_GROUPS},
      // APPEND-ONLY: the `test` job gained the REQUIRED privileged owned-metadata
      // observer gate (explicit runner: exact case set/count, zero skips). Same
      // jobs, same required step name, unchanged source groups. Every earlier
      // reviewed caller version above stays byte-identical and selectable.
      {workflowSha256:'2d3c9e6b32ba47bfef47be1c79e5c16f3c1fdf4e1233b86c7e2f611b245635a4',
      jobName:()=>callerNames[0]!,
      sourceBindingGroups:CI_CONSUMER_SOURCE_GROUPS},
      // The same required native gate now builds its canonical C backend and
      // requires all 66 reviewed cases (external held operands and read bodies).
      // Earlier reviewed workflows and their source groups stay selectable.
      {workflowSha256:'4076f89cd1c853e6ff6035d984024eff024c4b35b102d5c5856e03f01bb76686',
      jobName:()=>callerNames[0]!,
      sourceBindingGroups:CI_CONSUMER_SOURCE_GROUPS},
      // The same required native gate preserves the runner group before exec and
      // requires all 76 reviewed cases, including the whole alias read body.
      // Earlier reviewed workflows and their source groups stay selectable.
      {workflowSha256:'7d66965df7c26e254841a667bdf98ddcdfc7c388a6f15e2c7ed29b3045d11efa',
      jobName:()=>callerNames[0]!,
      sourceBindingGroups:CI_CONSUMER_SOURCE_GROUPS},
      // Explicit root identity retains CAP_SETPCAP while the runner primary
      // group permits capability-stripped children to traverse private paths.
      // All seven earlier reviewed workflows remain byte-identical. The gate
      // requires all 88 cases, including exact record-callback closing audits.
      {workflowSha256:'69ffa4551353b1f519c879f6187923ccfe01f7b496b759e8b31f0e9c3f660b87',
      jobName:()=>callerNames[0]!,
      sourceBindingGroups:CI_CONSUMER_SOURCE_GROUPS},
      // Request the default root group allowed by sudo, then restore the runner
      // primary group before Python exec. All eight earlier versions remain
      // selectable; the exact 103-case gate still requires zero skips.
      {workflowSha256:'f15c65e59d6cbbf5e4b5c529a09f1d1bf30e9d094a6f3c1fbf36df43e12c9c86',
      jobName:()=>callerNames[0]!,
      sourceBindingGroups:CI_CONSUMER_SOURCE_GROUPS}],requiredBranch:'staging',
    jobName:()=>callerNames[0]!,jobNames:()=>callerNames,
    sourceBindingGroups:CI_CONSUMER_SOURCE_GROUPS,
  };
  return observeGitHubOrigin(input,options,[manual,registered]);
}

export type ObservedGitHubRunStateScope='closed-producer'|'live-consumer'|'candidate-producer';
const observedGitHubRunStateScopes:readonly ObservedGitHubRunStateScope[]=Object.freeze(['closed-producer','live-consumer','candidate-producer']);
/** Metadata checks alone grant no observation capability. The candidate scope
 * accepts a completed-failure OVERALL run only provisionally; issuance still
 * requires the later exact same-attempt producer job/step/artifact/source
 * closure. Cancelled, timed-out, neutral and every other conclusion stay out.
 * Unknown scopes (including future/forged values and non-strings) always fail. */
export function observedGitHubRunStateAccepted(status:unknown,conclusion:unknown,scope:unknown):boolean {
  if(typeof scope!=='string'||!observedGitHubRunStateScopes.includes(scope as ObservedGitHubRunStateScope))return false;
  if(status==='completed')return conclusion==='success'||(scope==='candidate-producer'&&conclusion==='failure');
  return (scope==='live-consumer'||scope==='candidate-producer')&&status==='in_progress'&&conclusion===null;
}
export function observedGitHubJobWindowAccepted(job:any,artifact:any,input:ArtifactAcquisitionInput):boolean {
  const created=Date.parse(artifact?.created_at),start=Date.parse(job?.started_at),end=Date.parse(job?.completed_at);
  return positive(job?.id)&&job.run_id===input.runId&&job.run_attempt===input.runAttempt&&job.head_sha===input.runHeadSha
    &&job.status==='completed'&&job.conclusion==='success'&&[created,start,end].every(Number.isFinite)&&start<=end&&created>=start&&created<=end;
}

/** A native archive can retain facts from only its completed same-attempt
 * prerequisite jobs. Re-reading a cached image never supplies their originals. */
export function observedGitHubAncestorJobAccepted(ancestor:any,producer:any,input:ArtifactAcquisitionInput):boolean{
 const start=Date.parse(ancestor?.started_at),end=Date.parse(ancestor?.completed_at),producerStart=Date.parse(producer?.started_at);
 return positive(ancestor?.id)&&ancestor.run_id===input.runId&&ancestor.run_attempt===input.runAttempt&&ancestor.head_sha===input.runHeadSha
  &&ancestor.status==='completed'&&ancestor.conclusion==='success'&&[start,end,producerStart].every(Number.isFinite)&&start<=end&&end<=producerStart;
}

async function observeGitHubOrigin(input: ArtifactAcquisitionInput, options: { token?: string }, policies: OriginPolicy|readonly OriginPolicy[]): Promise<GitHubOriginObservation> {
  if (!input || input.schemaVersion !== 1 || !/^[a-f0-9]{40}$/u.test(input.sourceSha)
    || !/^[a-f0-9]{40}$/u.test(input.runHeadSha) || !/^[a-f0-9]{64}$/u.test(input.artifactSha256)
    || ![input.runId, input.runAttempt, input.artifactId].every(positive)) fail('exact coordinates required');
  if (Object.keys(input).some(key => !['schemaVersion', 'sourceSha', 'runHeadSha', 'runId', 'runAttempt', 'artifactId', 'artifactSha256'].includes(key))) fail('unknown origin coordinate');
  if (Object.keys(options).some(key => key !== 'token') || (options.token !== undefined
    && (typeof options.token !== 'string' || !options.token || /[\s\u0000-\u001f\u007f]/u.test(options.token)))) fail('invalid transport options');
  const originals: Original[] = [];
  const signal = AbortSignal.timeout(30_000);
  async function read(name: string, relative: string): Promise<any> {
    const endpoint = api + relative;
    const cached=cachedGitContentsOriginal(endpoint);
    if(cached){originals.push({name,endpoint,data:cached});return JSON.parse(cached.toString('utf8'));}
    const maximumBytes=immutableGitContentsEndpoint(endpoint)?2*1024**2:1024**2;
    const response = await fetch(endpoint, { method: 'GET', redirect: 'error', signal,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(options.token ? { Authorization: 'Bearer ' + options.token } : {}) } });
    if (response.status !== 200 || response.redirected || !response.body) fail('metadata request failed');
    const body = response.body!;
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximumBytes)) {
      await body.cancel(); return fail('metadata exceeds byte bound');
    }
    const reader = body.getReader(); const chunks: Buffer[] = []; let bytes = 0;
    try {
      while (true) {
        const row = await reader.read(); if (row.done) break;
        bytes += row.value.byteLength;
        if (bytes > maximumBytes) fail('metadata exceeds byte bound');
        chunks.push(Buffer.from(row.value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const data = Buffer.concat(chunks, bytes); originals.push({ name, endpoint, data });
    const parsed=JSON.parse(data.toString('utf8'));retainGitContentsOriginal(endpoint,data);return parsed;
  }
  const run = await read('run.original.json', `actions/runs/${input.runId}/attempts/${input.runAttempt}`);
  const choices=(Array.isArray(policies)?policies:[policies]) as readonly OriginPolicy[];
  const policy=choices.find(row=>run.path?.split('@')[0]===row.workflowPath);
  if(!policy) return fail('unreviewed producer workflow path');
  const runScope:ObservedGitHubRunStateScope=policy.allowCandidateProducerFailure===true?'candidate-producer':policy.allowRunningRun===true?'live-consumer':'closed-producer';
  if(runScope==='candidate-producer'&&(policy.workflowPath!=='.github/workflows/candidate.yml'||policy.allowRunningRun!==true))return fail('candidate producer scope requires the exact live-observable candidate workflow');
  if (run.id !== input.runId || run.run_attempt !== input.runAttempt || run.head_sha !== input.runHeadSha
    || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
    || !observedGitHubRunStateAccepted(run.status,run.conclusion,runScope) || !positive(run.workflow_id)
    || !policy.events.includes(run.event)
    || (policy.requiredBranch!==undefined && run.head_branch!==policy.requiredBranch)
    || (run.event !== 'pull_request' && input.sourceSha !== input.runHeadSha && policy.sourceMayDiffer!==true)
    || run.path?.split('@')[0] !== policy.workflowPath) fail('untrusted run coordinate');
  const workflow = await read('workflow.original.json', `actions/workflows/${run.workflow_id}`);
  if (workflow.id !== run.workflow_id || workflow.path !== policy.workflowPath) fail('unexpected workflow');
  const content = await read('workflow-source.original.json', `contents/${policy.workflowPath}?ref=${policy.workflowRef==='run-head'?input.runHeadSha:input.sourceSha}`);
  if (content.type !== 'file' || content.path !== policy.workflowPath || content.encoding !== 'base64'
    || typeof content.content !== 'string') fail('workflow source missing');
  const workflowBytes = Buffer.from(content.content.replace(/\s/gu, ''), 'base64');
  const workflowSha256 = sha(workflowBytes);
  const reviewedVersion = policy.reviewedWorkflowVersions?.find(row => row.workflowSha256 === workflowSha256);
  if (workflowSha256 !== policy.workflowSha256 && !reviewedVersion) fail('immutable workflow policy not reviewed');
  if((policy.stagingPushWorkflowSha256||policy.stagingPushWorkflowSha256s) && run.event==='push' && (!(policy.stagingPushWorkflowSha256s??[policy.stagingPushWorkflowSha256!]).includes(workflowSha256) || run.head_branch!=='staging' || input.sourceSha!==input.runHeadSha))fail('CSS push requires reviewed staging parent and exact source');
  const expectedJobName = reviewedVersion?.jobName ?? policy.jobName;
  let sourceBindings=[...(reviewedVersion?.sourceBindings ?? policy.sourceBindings ?? [])];
  const sourceBindingGroups=reviewedVersion?.sourceBindingGroups??policy.sourceBindingGroups;
  let selectedSourceGroup:GitHubSourceBindingGroup|undefined;
  if(sourceBindingGroups){
    const selectors=new Map(sourceBindingGroups.flatMap(group=>group.selectors.map(binding=>[sourceBindingKey(binding),binding] as const)));
    const observed=new Map<string,string>();
    await Promise.all([...selectors].map(async ([key,binding])=>{
      const original=await read('policy-'+binding.path.replace(/[^a-z0-9]/giu,'-')+'.original.json',`contents/${binding.path}?ref=${binding.ref==='run-head'?input.runHeadSha:input.sourceSha}`);
      if(original.type!=='file'||original.path!==binding.path||original.encoding!=='base64'||typeof original.content!=='string')fail('immutable group selector missing');
      observed.set(key,sha(Buffer.from(original.content.replace(/\s/gu,''),'base64')));
    }));
    // New observer versions refine only an already matched historical tuple.
    // A missing/modified helper remains fatal; no old-tree 404 is swallowed.
    // Staged, BOUNDED acquisition. Each round asks the one planner for the roles
    // still outstanding at the earliest unresolved declared stage, so a role an
    // older recipe never owned is never requested. Every key is fetched at most
    // once, all rounds share the SAME absolute deadline (the AbortSignal created
    // above), and the round count is bounded by the number of declared roles.
    selectedSourceGroup=await acquireOwnedSecondaryBindings(sourceBindingGroups,observed,async binding=>{
      const original=await read('policy-secondary-'+binding.path.replace(/[^a-z0-9]/giu,'-')+'.original.json',`contents/${binding.path}?ref=${binding.ref==='run-head'?input.runHeadSha:input.sourceSha}`);
      if(original.type!=='file'||original.path!==binding.path||original.encoding!=='base64'||typeof original.content!=='string')fail('immutable secondary group selector missing');
      return sha(Buffer.from(original.content.replace(/\s/gu,''),'base64'));
    },()=>{if(signal.aborted)fail('immutable secondary group selector missing');});
    sourceBindings=[...selectedSourceGroup.sourceBindings];
  }
  for (let offset=0;offset<sourceBindings.length;) {
   const batch=sourceBindings.slice(offset,offset+8);offset+=batch.length;
   await Promise.all(batch.map(async binding=>{
    const original = await read('policy-' + binding.path.replace(/[^a-z0-9]/giu, '-') + '.original.json', `contents/${binding.path}?ref=${binding.ref==='run-head'?input.runHeadSha:input.sourceSha}`);
    if (original.type !== 'file' || original.path !== binding.path || original.encoding !== 'base64'
      || typeof original.content !== 'string')fail('immutable target declaration source missing');
    const actualSha=sha(Buffer.from(original.content.replace(/\s/gu,''),'base64'));
    if(![binding.sha256,...(binding.reviewedSha256 ?? [])].includes(actualSha))fail('immutable target declaration policy not reviewed');
    // Companion helpers are versioned with the actual reviewed observer bytes.
    // Old runs do not gain the v20 companion-originals scope or new executable TCB.
    if(binding.path===QLEVER_OBSERVER_PATH)sourceBindings.push(...qleverObserverCompanionBindings(actualSha));
   }));
  }
  const artifact = await read('artifact.original.json', `actions/artifacts/${input.artifactId}`);
  if (artifact.id !== input.artifactId || artifact.expired !== false || artifact.workflow_run?.id !== input.runId
    || artifact.workflow_run?.head_sha !== input.runHeadSha || artifact.digest !== 'sha256:' + input.artifactSha256
    || !positive(artifact.size_in_bytes) || !policy.artifactNames(input).includes(artifact.name)) fail('artifact binding mismatch');
  const jobs = await read('jobs.original.json', `actions/runs/${input.runId}/attempts/${input.runAttempt}/jobs?per_page=100`);
  if(!Array.isArray(jobs.jobs)||!Number.isSafeInteger(jobs.total_count)||jobs.total_count<jobs.jobs.length||jobs.jobs.length>100
    ||jobs.total_count>100*(policy.maximumJobPages??1))fail('incomplete bounded job observation');
  for(let page=2;page<=Math.ceil(jobs.total_count/100);page++){
    const next=await read('jobs-page-'+page+'.original.json',`actions/runs/${input.runId}/attempts/${input.runAttempt}/jobs?per_page=100&page=${page}`);
    if(next.total_count!==jobs.total_count||!Array.isArray(next.jobs)||next.jobs.length>100)fail('job pagination changed');
    jobs.jobs.push(...next.jobs);
  }
  if(jobs.jobs.length!==jobs.total_count||new Set(jobs.jobs.map((row:any)=>row.id)).size!==jobs.jobs.length)fail('incomplete or duplicate job observation');
  const selectedJobContract=policy.sourceGroupJobContract?.(selectedSourceGroup);
  const expectedNames=selectedJobContract?[selectedJobContract.name]:policy.jobNames?.(artifact.name) ?? [expectedJobName(artifact.name)];
  const matching = jobs.jobs.filter((job:any)=>expectedNames.some(name=>reviewedVersion?matchesObservedJobName(job.name,name):job.name===name));
  if (matching.length !== 1) fail('unique producer job required');
  const job = matching[0];
  const created = Date.parse(artifact.created_at), start = Date.parse(job.started_at), end = Date.parse(job.completed_at);
  if (!observedGitHubJobWindowAccepted(job,artifact,input)
    || !job.steps?.some((step: any) => step.name === (selectedJobContract?.requiredStep??policy.requiredStep)
      && step.status === 'completed' && step.conclusion === 'success')
    || !(selectedJobContract?.requiredSteps??policy.requiredSteps ?? []).every(name => job.steps?.some((step: any) => step.name === name && step.status === 'completed' && step.conclusion === 'success'))) fail('producer job/attempt window mismatch');
  for(const name of policy.sourceGroupAncestorJobs?.(selectedSourceGroup)??policy.requiredAncestorJobs??[]){
    const ancestors=jobs.jobs.filter((candidate:any)=>candidate.name===name);
    if(ancestors.length!==1||!observedGitHubAncestorJobAccepted(ancestors[0],job,input))fail('exact native ancestor job/attempt closure mismatch');
  }
  const sdkOuterExecutorAuthority=policy.issueSdkOuterAuthority?inspectReviewedSdkOuterExecutorOrigin({group:selectedSourceGroup,workflowPath:policy.workflowPath,workflowSha256,job,artifactCreatedAt:artifact.created_at,identity:{...input,...(policy.target?{target:policy.target}:{})}}):undefined;
  const facts: GitHubOriginFacts = Object.freeze({...(sdkOuterExecutorAuthority?{sdkOuterExecutorAuthority}:{}), repository, workflowPath: policy.workflowPath,
    workflowSourceSha256: sha(workflowBytes), sourceSha: input.sourceSha, runHeadSha: input.runHeadSha,
    runId: input.runId, runAttempt: input.runAttempt, artifactId: input.artifactId,
    artifactSha256: input.artifactSha256, producerJobId: job.id,
    ...(policy.target ? { target: policy.target } : {}),
    scope: 'github-api-run-workflow-artifact-observation-only',
    originals: Object.freeze(originals.map(row => Object.freeze({ name: row.name, endpoint: row.endpoint,
      sha256: sha(row.data), bytes: row.data.length }))) });
  const observation = Object.freeze({}) as GitHubOriginObservation;
  issued.set(observation, { facts, originals }); return observation;
}
