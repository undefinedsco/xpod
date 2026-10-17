import { CLI_SOURCE_POLICY } from './source-rules';
import { registryConsumerArtifactName } from './registry-consumer-originals';
import { archiveConsumerArtifactName } from './archive-consumer-originals';
import { CONSUMER_SOURCE_BINDINGS } from './consumer-observer-policy';
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
  workflowPath: string;
  workflowSha256: string;
  reviewedWorkflowVersions?: readonly { workflowSha256: string; jobName(artifactName: string): string; sourceBindings?: readonly { path: string; sha256: string; reviewedSha256?: readonly string[]; ref?:'run-head' }[] }[];
  events: readonly string[];
  artifactNames(input: ArtifactAcquisitionInput): readonly string[];
  jobName(artifactName: string): string;
  jobNames?(artifactName:string):readonly string[];
  maximumJobPages?:number;
  allowRunningRun?:true;
  sourceMayDiffer?:true;
  workflowRef?:'run-head';
  requiredStep: string;
  requiredSteps?: readonly string[];
  target?: string;
  sourceBindings?: readonly { path: string; sha256: string; reviewedSha256?: readonly string[]; ref?:'run-head' }[];
}
export async function observeCliGitHubOrigin(input: ArtifactAcquisitionInput, options: { token?: string } = {}): Promise<GitHubOriginObservation> {
  return observeGitHubOrigin(input, options, {
    workflowPath: CLI_PRODUCT_WORKFLOW, workflowSha256:CLI_SOURCE_POLICY.workflow,
    reviewedWorkflowVersions:[{workflowSha256:'b9bc591d5248773fae30df574a95e1ee928dffc41ad5965a8fbc8bf90319d860',
      jobName:name=>`standalone-cli (${name.startsWith('xpod-cli-publication-preparation-macOS-')?'macos-latest':'ubuntu-latest'})`},
      {workflowSha256:'50576f056ba617e9153afc0d385a06a830696e3703e6ad624d1e8a8ad46af22c',
        jobName:name=>`standalone-cli (${name.startsWith('xpod-cli-publication-preparation-macOS-')?'macos-latest':'ubuntu-latest'})`}],
    events: ['workflow_dispatch', 'pull_request'],
    artifactNames: row => cliPublicationArtifactNames({ expectedSourceSha: row.sourceSha, runId: row.runId, runAttempt: row.runAttempt }),
    jobName: name => `normal-publication (${name.startsWith('xpod-cli-publication-preparation-macOS-') ? 'macos-latest' : 'ubuntu-latest'})`,
    requiredStep: 'Build normal CLI publication preparation',
  });
}

/** Product origin uses the canonical target/native-source declaration. A
 * declared target is still unverified until its exact successful run is seen. */
export async function observeModuleProductGitHubOrigin(input: ArtifactAcquisitionInput, module: 'api' | 'css',
  target: string, options: { token?: string } = {}): Promise<GitHubOriginObservation> {
  const row = productTarget(module, target);
  if (!row.nativeSourceAvailable) return fail('module target has no declared native source');
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
  return observeGitHubOrigin(input, options, {
    ...policies[module], workflowPath: `.github/workflows/${module}-module-product.yml`,
    events: ['workflow_dispatch', 'pull_request'], target,
    sourceBindings: [{ path: 'scripts/module-product-targets.ts', sha256: 'd04fb106ca349179e4b99869c68cbb85b8d9a9f30e8d60b927a5eceab9e2f25f' }],
    artifactNames: coordinates => [`${module}-module-products-${target}-${coordinates.sourceSha}-${coordinates.runId}-${coordinates.runAttempt}`],
    jobName: () => `products (${target})`,
    // The old reviewed workflow used GitHub's implicit matrix display name.
    reviewedWorkflowVersions: [{ workflowSha256: policies[module].previousShortWorkflowSha256, jobName: () => `products (${target})`,
      sourceBindings: [{ path: 'scripts/module-product-targets.ts', sha256: '35b8752237d620981b1848d6d8876dfac3c1da14509e77358e7f961ca256cf96' }] },
      { workflowSha256: policies[module].legacyWorkflowSha256, jobName: () => `products (${Object.values(row).join(', ')})`,
        sourceBindings: [{ path: 'scripts/module-product-targets.ts', sha256: '35b8752237d620981b1848d6d8876dfac3c1da14509e77358e7f961ca256cf96' }] }],
  });
}

/** Normal AFS products come from the mounted-module workflow, independently
 * of the upstream native acceptance workflow and its distinct source revision. */
export async function observeAfsModuleProductGitHubOrigin(input: ArtifactAcquisitionInput, target: string,
  options: { token?: string } = {}): Promise<GitHubOriginObservation> {
  if (!MODULE_TARGETS.some(row => `${row.platform}-${row.arch}` === target)) return fail('unsupported normal AFS target');
  return observeGitHubOrigin(input, options, {
    workflowPath: '.github/workflows/agentfs-module-mounted-acceptance.yml',
    workflowSha256: 'c6420bc5699a84a8adf98a19841cb09e3df155370622d1b7e982cd08064ca4bf',
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
  invocation:'standalone'|'css-module',options:{token?:string}={}):Promise<GitHubOriginObservation>{
  if(!['darwin-arm64','darwin-x64'].includes(target) || !['standalone','css-module'].includes(invocation)) return fail('unsupported QLever native invocation');
  // The reviewed CSS caller supplies no target and therefore invokes the
  // reusable workflow's darwin-arm64 default. x64 must use its standalone run.
  if(invocation==='css-module' && target!=='darwin-arm64') return fail('reviewed CSS native caller only produces darwin-arm64');
  const nativeWorkflow='.github/workflows/build-qlever-macos-runtime.yml';
  const nativeHash='76238a58da3384d10d1d1537211540f289531a3c74b43c854c2eb37ec2cb768c';
  const observation=await observeGitHubOrigin(input,options,{
    workflowPath:invocation==='standalone'?nativeWorkflow:'.github/workflows/css-module-product.yml',
    workflowSha256:invocation==='standalone'?nativeHash:'9f14303a0736391b250598c21211dc5312565adf5bf30256a4f9c61f13cc8257',
    ...(invocation==='css-module'?{reviewedWorkflowVersions:[{
      workflowSha256:'454baf86f674c2c3b5058ad012c09d968c26e4f7d282d702df745a16978542b3',jobName:()=> 'native / build',
    }]}:{}),
    events:invocation==='standalone'?['push','workflow_dispatch']:['push','workflow_dispatch','pull_request'],target,
    artifactNames:row=>[`qlever-local-runtime-${target}-${row.sourceSha}`],
    jobName:()=>invocation==='standalone'?'build':'native / build',
    requiredStep:'Bind the qlever-local acceptance evidence',
    requiredSteps:['Verify the actual native producer host','Resolve immutable artifact identity','Upload the exact native runtime'],
    sourceBindings:[...(invocation==='css-module'?[{path:nativeWorkflow,sha256:nativeHash}]:[]),
      {path:'qlever/scripts/observe-macos-native-materials.py',sha256:'79e34893b946458a904544ddb1cce9110a19fe5052503570c865341e7d0ff6d6',
        reviewedSha256:['a92b227ec186a0f53f85c93a732a0542ee3b712fdb571308395ecf17c07b2d86']}],
  });
  nativeOrigins.add(observation); return observation;
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
  return observeGitHubOrigin(input,options,{
    workflowPath:'.github/workflows/independent-publication.yml',workflowSha256:'63a34359c5afa9cf318e1505f22d5353d832d8b5220ce774675132b5fc75d103',
    workflowRef:'run-head',sourceMayDiffer:true,allowRunningRun:true,maximumJobPages:8,
    events:['workflow_dispatch'],...(product.target?{target:product.target}:{}),
    artifactNames:()=>[expected],jobName:()=>names[0]!,jobNames:()=>names,
    requiredStep:pre?'Run fixed archive-installed product consumer':'Run fixed registry-installed product consumer',
    requiredSteps:[pre?'Upload archive consumer originals':'Upload registry consumer originals'],
    sourceBindings:[
      {path:'.github/workflows/independent-publication-wave.yml',sha256:'d0663ca80b76dd9c9f3dcdba7a0ed472965a23cd87f0080a5a944e76123eff4b',ref:'run-head'},
      {path:'.github/workflows/independent-archive-consumer.yml',sha256:'abb2f08b7785f3e31434d3bc6f7d0e179fba9f7d7e87e863473abe4960925c2d',ref:'run-head'},
      {path:'.github/workflows/independent-registry-consumer.yml',sha256:'b0f9b7e6619f76c973152afcf741e0184ebb09a4a3a339c9938705cd09475dbd',ref:'run-head'},
      ...CONSUMER_SOURCE_BINDINGS,
    ],
  });
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

async function observeGitHubOrigin(input: ArtifactAcquisitionInput, options: { token?: string }, policy: OriginPolicy): Promise<GitHubOriginObservation> {
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
    const response = await fetch(endpoint, { method: 'GET', redirect: 'error', signal,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(options.token ? { Authorization: 'Bearer ' + options.token } : {}) } });
    if (response.status !== 200 || response.redirected || !response.body) fail('metadata request failed');
    const body = response.body!;
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > 1024 ** 2)) {
      await body.cancel(); return fail('metadata exceeds byte bound');
    }
    const reader = body.getReader(); const chunks: Buffer[] = []; let bytes = 0;
    try {
      while (true) {
        const row = await reader.read(); if (row.done) break;
        bytes += row.value.byteLength;
        if (bytes > 1024 ** 2) fail('metadata exceeds byte bound');
        chunks.push(Buffer.from(row.value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const data = Buffer.concat(chunks, bytes); originals.push({ name, endpoint, data });
    return JSON.parse(data.toString('utf8'));
  }
  const run = await read('run.original.json', `actions/runs/${input.runId}/attempts/${input.runAttempt}`);
  if (run.id !== input.runId || run.run_attempt !== input.runAttempt || run.head_sha !== input.runHeadSha
    || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
    || !observedGitHubRunStateAccepted(run.status,run.conclusion,policy.allowRunningRun===true?'live-consumer':'closed-producer') || !positive(run.workflow_id)
    || !policy.events.includes(run.event)
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
  const expectedJobName = reviewedVersion?.jobName ?? policy.jobName;
  for (const binding of reviewedVersion?.sourceBindings ?? policy.sourceBindings ?? []) {
    const original = await read('policy-' + binding.path.replace(/[^a-z0-9]/giu, '-') + '.original.json', `contents/${binding.path}?ref=${binding.ref==='run-head'?input.runHeadSha:input.sourceSha}`);
    if (original.type !== 'file' || original.path !== binding.path || original.encoding !== 'base64'
      || typeof original.content !== 'string' || ![binding.sha256,...(binding.reviewedSha256 ?? [])].includes(sha(Buffer.from(original.content.replace(/\s/gu, ''), 'base64')))) fail('immutable target declaration policy not reviewed');
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
