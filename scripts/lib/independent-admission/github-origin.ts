import {QLEVER_SDK_WORKFLOW,QLEVER_SDK_WORKFLOW_SHA,QLEVER_SDK_EXECUTION_GROUPS,QLEVER_LINUX_EXECUTION_GROUPS} from './qlever-sdk-origin-policy';
import {selectGitHubSourceBindingGroup,secondaryGitHubSourceBindingSelectors,sourceBindingKey,type GitHubSourceBindingGroup} from './github-source-binding-groups';
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

declare const originBrand: unique symbol;
/** Only the controlled observers below can issue this in-process capability. */
export interface GitHubOriginObservation { readonly [originBrand]: true }
export interface GitHubOriginFacts {
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
  reviewedWorkflowVersions?: readonly { workflowSha256: string; jobName(artifactName: string): string; sourceBindings?: readonly { path: string; sha256: string; reviewedSha256?: readonly string[]; ref?:'run-head' }[] }[];
  events: readonly string[];
  stagingPushWorkflowSha256?: string;
  stagingPushWorkflowSha256s?: readonly string[];
  artifactNames(input: ArtifactAcquisitionInput): readonly string[];
  jobName(artifactName: string): string;
  jobNames?(artifactName:string):readonly string[];
  maximumJobPages?:number;
  allowRunningRun?:true;
  requiredBranch?: string;
  sourceMayDiffer?:true;
  workflowRef?:'run-head';
  requiredStep: string;
  requiredSteps?: readonly string[];
  requiredAncestorJobs?: readonly string[];
  target?: string;
  sourceBindings?: readonly { path: string; sha256: string; reviewedSha256?: readonly string[]; ref?:'run-head' }[];
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

function cssStagingParentPolicy(jobName: string): Pick<OriginPolicy,'reviewedWorkflowVersions'|'stagingPushWorkflowSha256'> {
 return {reviewedWorkflowVersions:[{workflowSha256:CSS_STAGING_PARENT_SHA,jobName:()=>jobName}],stagingPushWorkflowSha256:CSS_STAGING_PARENT_SHA};
}
const CSS_NATIVE_SOURCE_BINDINGS=[
 {path:'.github/workflows/css-native-product-target.yml',sha256:'49ee4c223de857cb9d500a7dceb4a54f36ae8759d1d8b3cc9a7b847db3bbf877'},
 {path:'.github/workflows/css-native-source.yml',sha256:'df05d53b957d7b793dd998d46ccbc9a7dea788ac7f341f5e5472e325897a0371'},
 {path:'scripts/module-product-targets.ts',sha256:'5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4'},
 {path:'.github/workflows/build-qlever-macos-runtime.yml',sha256:'76238a58da3384d10d1d1537211540f289531a3c74b43c854c2eb37ec2cb768c',reviewedSha256:['39609410c84a0913e685bd1fb1e5c9ef4e104fd2f04332c179dd3b4f08d3c830']},
 {path:'.github/workflows/publish-qlever-runtime-sdk.yml',sha256:'cbedd3e2478de5e22108b6689c595a658ca891c9bd47552caec830e86f47fea8'},
] as const;

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
    ...(module==='api'?{stagingPushWorkflowSha256s:['c4aa6b7ea6e384adab1e517a903e50d574c8afb2eb92d8c54dc919320652c5b0','b7a91e8c0b61f8a80a3de2c6c93e78f1d2f9637a741bff7ac2592882ba0c831e']}:{}),
    events: module==='api'?['workflow_dispatch','pull_request','push']:['workflow_dispatch','pull_request'], target,
    sourceBindings: [{ path: 'scripts/module-product-targets.ts', sha256: 'd04fb106ca349179e4b99869c68cbb85b8d9a9f30e8d60b927a5eceab9e2f25f',reviewedSha256:['5ef511f448c90a6fc9e767fd8224ef890b5fc04d2b6514f85697a0a529fb3eb4'] }],
    artifactNames: coordinates => [`${module}-module-products-${target}-${coordinates.sourceSha}-${coordinates.runId}-${coordinates.runAttempt}`],
    jobName: () => `products (${target})`,
    // The old reviewed workflow used GitHub's implicit matrix display name.
    reviewedWorkflowVersions: [...(module==='api'?[{workflowSha256:'b7a91e8c0b61f8a80a3de2c6c93e78f1d2f9637a741bff7ac2592882ba0c831e',jobName:()=>`products (${target})`,sourceBindings:API_CONTROLLED_SOURCE_BINDINGS},{workflowSha256:'c4aa6b7ea6e384adab1e517a903e50d574c8afb2eb92d8c54dc919320652c5b0',jobName:()=>`products (${target})`}]:[]), { workflowSha256: policies[module].previousShortWorkflowSha256, jobName: () => `products (${target})`,
      sourceBindings: [{ path: 'scripts/module-product-targets.ts', sha256: '35b8752237d620981b1848d6d8876dfac3c1da14509e77358e7f961ca256cf96' }] },
      { workflowSha256: policies[module].legacyWorkflowSha256, jobName: () => `products (${Object.values(row).join(', ')})`,
        sourceBindings: [{ path: 'scripts/module-product-targets.ts', sha256: '35b8752237d620981b1848d6d8876dfac3c1da14509e77358e7f961ca256cf96' }] }],
  };
  const current:OriginPolicy={workflowPath:CSS_NATIVE_PRODUCTS_WORKFLOW,workflowSha256:CSS_NATIVE_PARENT_SHA,
    ...cssStagingParentPolicy(`targets (${target}) / products`),events:['workflow_dispatch','push'],target,artifactNames:coordinates=>[`css-module-products-${target}-${coordinates.sourceSha}-${coordinates.runId}-${coordinates.runAttempt}`],
    jobName:()=>`targets (${target}) / products`,requiredStep:'Produce the normal CSS preview',requiredSteps:['Upload original preview and evidence'],
    // Only the actually executed target branch participates. Linux SDK changes
    // do not silently authorize Linux, or block a separately reviewed Mac run.
    ...(target.startsWith('linux-')?{sourceBindingGroups:QLEVER_LINUX_EXECUTION_GROUPS}:{sourceBindings:[...CSS_NATIVE_SOURCE_BINDINGS.filter(binding=>binding.path!=='.github/workflows/publish-qlever-runtime-sdk.yml'),{path:QLEVER_OBSERVER_PATH,sha256:QLEVER_OBSERVER_V20,reviewedSha256:[QLEVER_OBSERVER_V22,QLEVER_OBSERVER_V23]}]}),
    requiredAncestorJobs:target.startsWith('linux-')?[`targets (${target}) / native / linux / publish`,`targets (${target}) / native / linux / module_runtime_materials / runtime / publish`,`targets (${target}) / native / linux / module_runtime_materials / archive`]:[`targets (${target}) / native / macos / build`]};
  const observation=await observeGitHubOrigin(input,options,module==='css'?(row.nativeSourceAvailable?[legacy,current]:current):legacy);
  normalModuleOrigins.add(observation);return observation;
}

/** Normal AFS products come from the mounted-module workflow, independently
 * of the upstream native acceptance workflow and its distinct source revision. */
export async function observeAfsModuleProductGitHubOrigin(input: ArtifactAcquisitionInput, target: string,
  options: { token?: string } = {}): Promise<GitHubOriginObservation> {
  if (!MODULE_TARGETS.some(row => `${row.platform}-${row.arch}` === target)) return fail('unsupported normal AFS target');
  return observeGitHubOrigin(input, options, {
    workflowPath: '.github/workflows/agentfs-module-mounted-acceptance.yml',
    workflowSha256: '854cc2a40d0e9bd3d41deb339fbc239693a9f7811cf035be1768a9b496cbb043',
    reviewedWorkflowVersions:[{workflowSha256:'c6420bc5699a84a8adf98a19841cb09e3df155370622d1b7e982cd08064ca4bf',jobName:()=>`mounted-module (${target})`}],
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
        requiredAncestorJobs:[`targets (${target}) / native / linux / publish`,`targets (${target}) / native / linux / module_runtime_materials / runtime / publish`],
        sourceBindingGroups:QLEVER_LINUX_EXECUTION_GROUPS,
      });nativeOrigins.add(observation);return observation;
    }
    if(!['darwin-arm64','darwin-x64'].includes(target))return fail('unsupported CSS native original target');
    const observation=await observeGitHubOrigin(input,options,{
      workflowPath:CSS_NATIVE_PRODUCTS_WORKFLOW,workflowSha256:CSS_NATIVE_PARENT_SHA,...cssStagingParentPolicy(`targets (${target}) / native / macos / build`),events:['workflow_dispatch','push'],target,
      artifactNames:row=>[`qlever-local-runtime-${target}-${row.sourceSha}`],
      jobName:()=>`targets (${target}) / native / macos / build`,requiredStep:'Bind the qlever-local acceptance evidence',
      requiredSteps:['Verify the actual native producer host','Resolve immutable artifact identity','Upload the exact native runtime'],
      sourceBindings:[...CSS_NATIVE_SOURCE_BINDINGS.filter(binding=>binding.path!=='.github/workflows/publish-qlever-runtime-sdk.yml'),{path:QLEVER_OBSERVER_PATH,sha256:QLEVER_OBSERVER_V20,reviewedSha256:[QLEVER_OBSERVER_V22,QLEVER_OBSERVER_V23]}],
    });nativeOrigins.add(observation);return observation;
  }
  if(!['darwin-arm64','darwin-x64'].includes(target) || !['standalone','css-module'].includes(invocation)) return fail('unsupported QLever native invocation');
  // The reviewed CSS caller supplies no target and therefore invokes the
  // reusable workflow's darwin-arm64 default. x64 must use its standalone run.
  if(invocation==='css-module' && target!=='darwin-arm64') return fail('reviewed CSS native caller only produces darwin-arm64');
  const nativeWorkflow='.github/workflows/build-qlever-macos-runtime.yml';
  const nativeHash='39609410c84a0913e685bd1fb1e5c9ef4e104fd2f04332c179dd3b4f08d3c830';
  const previousNativeHash='76238a58da3384d10d1d1537211540f289531a3c74b43c854c2eb37ec2cb768c';
  const observation=await observeGitHubOrigin(input,options,{
    workflowPath:invocation==='standalone'?nativeWorkflow:'.github/workflows/css-module-product.yml',
    workflowSha256:invocation==='standalone'?nativeHash:'9f14303a0736391b250598c21211dc5312565adf5bf30256a4f9c61f13cc8257',
    ...(invocation==='css-module'?{reviewedWorkflowVersions:[{
      workflowSha256:'454baf86f674c2c3b5058ad012c09d968c26e4f7d282d702df745a16978542b3',jobName:()=> 'native / build',
    }]}:{reviewedWorkflowVersions:[{workflowSha256:previousNativeHash,jobName:()=> 'build'}]}),
    events:invocation==='standalone'?['push','workflow_dispatch']:['push','workflow_dispatch','pull_request'],target,
    artifactNames:row=>[`qlever-local-runtime-${target}-${row.sourceSha}`],
    jobName:()=>invocation==='standalone'?'build':'native / build',
    requiredStep:'Bind the qlever-local acceptance evidence',
    requiredSteps:['Verify the actual native producer host','Resolve immutable artifact identity','Upload the exact native runtime'],
    sourceBindings:[...(invocation==='css-module'?[{path:nativeWorkflow,sha256:nativeHash,reviewedSha256:[previousNativeHash]}]:[]),
      {path:'qlever/scripts/observe-macos-native-materials.py',sha256:'79e34893b946458a904544ddb1cce9110a19fe5052503570c865341e7d0ff6d6',
        reviewedSha256:['a92b227ec186a0f53f85c93a732a0542ee3b712fdb571308395ecf17c07b2d86',QLEVER_OBSERVER_V20,QLEVER_OBSERVER_V22,QLEVER_OBSERVER_V23]}],
  });
  nativeOrigins.add(observation); return observation;
}

/** SDK byte custody is independently observed, never inferred from a runtime
 * image reference or a normal CSS product observation. */
export async function observeQleverSdkGitHubOrigin(input:ArtifactAcquisitionInput,target:string,invocation:'standalone'|'css-native-products',options:{token?:string}={}):Promise<GitHubOriginObservation>{
 if(!['linux-x64','linux-arm64'].includes(target)||!['standalone','css-native-products'].includes(invocation))return fail('fixed SDK target and invocation required');
 const nested=invocation==='css-native-products';
 const observation=await observeGitHubOrigin(input,options,{
  workflowPath:nested?CSS_NATIVE_PRODUCTS_WORKFLOW:QLEVER_SDK_WORKFLOW,workflowSha256:nested?CSS_NATIVE_PARENT_SHA:QLEVER_SDK_WORKFLOW_SHA,
  ...(nested?cssStagingParentPolicy(`targets (${target}) / native / linux / publish`):{}),
  events:nested?['workflow_dispatch','push']:['workflow_dispatch'],target,
  artifactNames:row=>[`qlever-sdk-originals-${target}-${row.sourceSha}-${row.runId}-${row.runAttempt}`],
  jobName:()=>nested?`targets (${target}) / native / linux / publish`:'publish',
  requiredStep:'Bind actual SDK image and build originals',
  requiredSteps:['Verify the actual native producer host','Build actual cold module SDK with owned raw streams','Push exact tested module SDK from the same builder cache','Upload exact SDK original materials'],
  sourceBindingGroups:QLEVER_SDK_EXECUTION_GROUPS,
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
    reviewedWorkflowVersions:[],requiredBranch:'staging',
    jobName:()=>callerNames[0]!,jobNames:()=>callerNames,
    sourceBindingGroups:CI_CONSUMER_SOURCE_GROUPS,
  };
  return observeGitHubOrigin(input,options,[manual,registered]);
}

/** Metadata checks alone grant no observation capability. */
export function observedGitHubRunStateAccepted(status:unknown,conclusion:unknown,scope:'closed-producer'|'live-consumer'):boolean {
  return status==='completed'?conclusion==='success':scope==='live-consumer'&&status==='in_progress'&&conclusion===null;
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
  if (run.id !== input.runId || run.run_attempt !== input.runAttempt || run.head_sha !== input.runHeadSha
    || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
    || !observedGitHubRunStateAccepted(run.status,run.conclusion,policy.allowRunningRun===true?'live-consumer':'closed-producer') || !positive(run.workflow_id)
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
  if(policy.sourceBindingGroups){
    const selectors=new Map(policy.sourceBindingGroups.flatMap(group=>group.selectors.map(binding=>[sourceBindingKey(binding),binding] as const)));
    const observed=new Map<string,string>();
    await Promise.all([...selectors].map(async ([key,binding])=>{
      const original=await read('policy-'+binding.path.replace(/[^a-z0-9]/giu,'-')+'.original.json',`contents/${binding.path}?ref=${binding.ref==='run-head'?input.runHeadSha:input.sourceSha}`);
      if(original.type!=='file'||original.path!==binding.path||original.encoding!=='base64'||typeof original.content!=='string')fail('immutable group selector missing');
      observed.set(key,sha(Buffer.from(original.content.replace(/\s/gu,''),'base64')));
    }));
    // New observer versions refine only an already matched historical tuple.
    // A missing/modified helper remains fatal; no old-tree 404 is swallowed.
    const secondary=secondaryGitHubSourceBindingSelectors(policy.sourceBindingGroups,observed);
    await Promise.all(secondary.map(async binding=>{
      const original=await read('policy-secondary-'+binding.path.replace(/[^a-z0-9]/giu,'-')+'.original.json',`contents/${binding.path}?ref=${binding.ref==='run-head'?input.runHeadSha:input.sourceSha}`);
      if(original.type!=='file'||original.path!==binding.path||original.encoding!=='base64'||typeof original.content!=='string')fail('immutable secondary group selector missing');
      observed.set(sourceBindingKey(binding),sha(Buffer.from(original.content.replace(/\s/gu,''),'base64')));
    }));
    sourceBindings=[...selectGitHubSourceBindingGroup(policy.sourceBindingGroups,observed).sourceBindings];
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
  const expectedNames=policy.jobNames?.(artifact.name) ?? [expectedJobName(artifact.name)];
  const matching = jobs.jobs.filter((job:any)=>expectedNames.some(name=>reviewedVersion?matchesObservedJobName(job.name,name):job.name===name));
  if (matching.length !== 1) fail('unique producer job required');
  const job = matching[0];
  const created = Date.parse(artifact.created_at), start = Date.parse(job.started_at), end = Date.parse(job.completed_at);
  if (!observedGitHubJobWindowAccepted(job,artifact,input)
    || !job.steps?.some((step: any) => step.name === policy.requiredStep
      && step.status === 'completed' && step.conclusion === 'success')
    || !(policy.requiredSteps ?? []).every(name => job.steps?.some((step: any) => step.name === name && step.status === 'completed' && step.conclusion === 'success'))) fail('producer job/attempt window mismatch');
  for(const name of policy.requiredAncestorJobs??[]){
    const ancestors=jobs.jobs.filter((candidate:any)=>candidate.name===name);
    if(ancestors.length!==1||!observedGitHubAncestorJobAccepted(ancestors[0],job,input))fail('exact native ancestor job/attempt closure mismatch');
  }
  const facts: GitHubOriginFacts = Object.freeze({ repository, workflowPath: policy.workflowPath,
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
