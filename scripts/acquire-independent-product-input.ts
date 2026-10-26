import {productConsumerOriginalLimits} from './lib/independent-admission/product-consumer-limits';
import { PUBLICATION_DISK_LIMITS } from './lib/independent-admission/publication-disk-budget';
import { archiveConsumerArtifactName } from './lib/independent-admission/archive-consumer-originals';
import { registryConsumerArtifactName } from './lib/independent-admission/registry-consumer-originals';
import {candidateServiceNativeRuntimeArtifactName} from './lib/independent-admission/candidate-service-native-runtime-contract';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statfsSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { MODULE_TARGETS } from '../packages/xpod-cli/src/module-catalog';
import { productTargets } from './module-product-targets';
const { withOwnedTempRoot, assertOwnedTempParent } = createRequire(import.meta.url)('./lib/owned-temp-root.cjs');

// Trust is program policy, not a caller-supplied workflow allowlist. Neither the
// API native-input workflow nor contract fixtures are product producers.
const REPOSITORY = 'undefinedsco/xpod';
export const CLI_PRODUCT_WORKFLOW = '.github/workflows/cli-package.yml';
export const CLI_PUBLICATION_MATERIAL_ROLE = 'cli-publication-preparation-materials';
export function cliPublicationArtifactNames(input: { expectedSourceSha: string; runId: number; runAttempt: number }): string[] {
  return ['Linux', 'macOS'].map(os => `xpod-cli-publication-preparation-${os}-${input.expectedSourceSha}-${input.runId}-${input.runAttempt}`);
}
export const API_PRODUCT_WORKFLOW = '.github/workflows/api-module-product.yml';
export const CSS_PRODUCT_WORKFLOW = '.github/workflows/css-module-product.yml';
const CSS_ROUTED_PRODUCT_WORKFLOW='.github/workflows/css-native-products.yml';
const PRODUCERS = new Set([CSS_ROUTED_PRODUCT_WORKFLOW,CLI_PRODUCT_WORKFLOW, '.github/workflows/agentfs-module-mounted-acceptance.yml', API_PRODUCT_WORKFLOW, CSS_PRODUCT_WORKFLOW]);
import moduleArtifactLimits from './lib/module-artifact-limits.json';
const LIMITS = { packedBytes: PUBLICATION_DISK_LIMITS.outerPackedBytes, expandedBytes: PUBLICATION_DISK_LIMITS.outerExpandedBytes, members: moduleArtifactLimits.members };
const METADATA_NAMES = ['run', 'workflow', 'artifact'] as const;
type FileBinding = { path: string; bytes: number; sha256: string };
interface MetadataBinding { originals: Record<string, FileBinding & { endpoint: string }>; projection: FileBinding }
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Rechecks saved originals and their derived projection; not GitHub or release admission. */
export function verifyAcquiredMetadata(root: string, binding: MetadataBinding): void {
  if (lstatSync(root).isSymbolicLink() || lstatSync(path.join(root, 'metadata')).isSymbolicLink()
    || !isDeepStrictEqual(Object.keys(binding.originals).sort(), [...METADATA_NAMES].sort())) fail('metadata binding layout mismatch');
  function read(reference: FileBinding, expected: string): Buffer {
    if (reference.path !== expected || !Number.isSafeInteger(reference.bytes) || reference.bytes < 0 || reference.bytes > 1024 * 1024 * 3
      || !/^[a-f0-9]{64}$/u.test(reference.sha256)) fail('metadata reference invalid');
    const file = path.join(root, reference.path), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('metadata original must be regular');
    if (stat.size !== reference.bytes) fail('metadata original hash mismatch (size)');
    const bytes = readFileSync(file);
    if (bytes.length !== reference.bytes || sha256(bytes) !== reference.sha256) fail('metadata original hash mismatch');
    return bytes;
  }
  const originals = Object.fromEntries(METADATA_NAMES.map(name => [name,
    JSON.parse(read(binding.originals[name], `metadata/${name}.original.json`).toString('utf8'))]));
  const projected = JSON.parse(read(binding.projection, 'metadata.json').toString('utf8'));
  if (!isDeepStrictEqual(originals, projected)) fail('metadata projection differs from originals');
}
export interface ArtifactAcquisitionInput {
  schemaVersion: 1;
  sourceSha: string;
  runHeadSha: string;
  runId: number;
  runAttempt: number;
  artifactId: number;
  artifactSha256: string;
}
interface Dependencies {
  fetch?: typeof fetch;
  token?: string;
  diagnostics?: string;
  // Tests and constrained callers may lower transport limits, never raise them.
  limits?: Partial<typeof LIMITS>;
}
function fail(message: string): never { throw new Error('Artifact acquisition: ' + message); }
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0; }
export function assertNewAcquisitionOutput(output: string): string {
  return checkedAcquisitionOutput(output).output;
}
function checkedAcquisitionOutput(output: string) {
  output = path.resolve(output);
  let parent = path.parse(output).root;
  let parentStat = lstatSync(parent);
  for (const part of path.dirname(output).slice(parent.length).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, part);
    const stat = lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('output parent must be an existing directory without links');
    parentStat = stat;
  }
  try { lstatSync(output); fail('output already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { output, temporaryParent: { parent: path.dirname(output), identity: { dev: parentStat.dev, ino: parentStat.ino } } };
}
function limit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!positive(value) || value > maximum) fail('invalid lower resource bound');
  return value;
}
async function withinSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function stream(response: Response, destination: string, bound: number, signal?: AbortSignal) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > bound)) {
    try {
      const cancelled = response.body?.cancel();
      if (cancelled) {
        if (signal) await withinSignal(cancelled, signal);
        else await cancelled;
      }
    } catch { /* Cancellation cannot replace the size-bound rejection. */ }
    fail('download declared size exceeds bound');
  }
  if (!response.body) fail('download body missing');
  const fd = openSync(destination, 'wx', 0o600), hash = createHash('sha256');
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await (signal ? withinSignal(reader.read(), signal) : reader.read());
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > bound) fail('download actual size exceeds bound');
      const free=statfsSync(path.dirname(destination),{bigint:true});
      if(free.bavail*free.bsize<BigInt(moduleArtifactLimits.freeFloorBytes+moduleArtifactLimits.queueReserveBytes+chunk.value.length))fail('download fixed free-space floor insufficient');
      hash.update(chunk.value);
      let offset = 0;
      while (offset < chunk.value.length) offset += writeSync(fd, chunk.value, offset);
    }
    if (length !== null && Number(length) !== bytes) fail('download content length mismatch');
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    try {
      const cancelled = reader.cancel();
      if (signal) {
        if (signal.aborted) void cancelled.catch(() => {});
        else await withinSignal(cancelled, signal).catch(() => {});
      } else await cancelled.catch(() => {});
    } catch { /* Cancellation cannot prevent descriptor closure. */ }
    finally { closeSync(fd); }
  }
}
/** Acquires a ZIP and inventory, never extracts members or confers product admission. */
export async function acquireIndependentProductInput(input: ArtifactAcquisitionInput, output: string, dependencies: Dependencies = {}) {
  return acquireProductInput(input, output, dependencies, false);
}
/** Fixed GET-only registry-consumer original transport. It grants no origin
 * or consumer authority; the reviewed GitHub observer independently binds it. */
export async function acquireRegistryConsumerOriginals(input: ArtifactAcquisitionInput, output: string, options: { token?: string;module?:'afs' } = {}) {
  if (Object.keys(options).some(key => !['token','module'].includes(key))||options.module!==undefined&&options.module!=='afs') fail('unknown registry original transport option');
  return acquireProductInput(input, output, { token: options.token,
    limits:productConsumerOriginalLimits(options.module??'cli') }, false, true,false,false,options.module);
}

/** Exact prepublish originals remain a separate artifact family and role. */
export async function acquireArchiveConsumerOriginals(input:ArtifactAcquisitionInput,output:string,options:{token?:string;module?:'afs'}={}){
  if(Object.keys(options).some(key=>!['token','module'].includes(key))||options.module!==undefined&&options.module!=='afs')fail('unknown archive original transport option');
  return acquireProductInput(input,output,{token:options.token,limits:productConsumerOriginalLimits(options.module??'cli')},false,true,false,true,options.module);
}
/** Native original transport only. Independent origin observation is required
 * again by the central native collector; this does not issue admission. */
export async function acquireNativeAdmissionOriginals(input: ArtifactAcquisitionInput, output: string, options: { token?: string } = {}) {
  if (Object.keys(options).some(key => key !== 'token')) fail('unknown native original transport option');
  return acquireProductInput(input, output, { token: options.token }, false, false, true);
}
/** The existing native transport may observe a live candidate run only after
 * the existing private issuer closed the exact service or SDK producer job. The
 * same issued provenance is also the ONLY way a completed-failure OVERALL run is
 * accepted here: a downstream consumer failure can leave the producing job and
 * its retained artifact closed-success at the original attempt. It grants no
 * source admission, RC qualification or generic failed-run acceptance. */
export async function acquireCandidateServiceOriginals(input:ArtifactAcquisitionInput,output:string,origin:unknown,options:{token?:string}={}) {
 if(Object.keys(options).some(key=>key!=='token'))fail('unknown candidate original transport option');
 const issuer=await import('./lib/independent-admission/github-origin');
 const facts=issuer.githubOriginFacts(origin);
 const role=issuer.isCandidateServiceImageGitHubOrigin(origin)?'service':issuer.isQleverSdkGitHubOrigin(origin)?'sdk':issuer.isCandidateServiceNativeRuntimeGitHubOrigin(origin)?'native-runtime':undefined;
 if(!facts||!role||facts.workflowPath!=='.github/workflows/candidate.yml'||facts.sourceSha!==input.sourceSha||facts.runHeadSha!==input.runHeadSha||facts.runId!==input.runId||facts.runAttempt!==input.runAttempt||facts.artifactId!==input.artifactId||facts.artifactSha256!==input.artifactSha256)fail('issued exact candidate original role required');
 return acquireProductInput(input,output,{token:options.token},false,false,true,false,undefined,role);
}
/** Same-run legacy transport; never admits a still-running independent producer run. */
export async function acquireLegacyRootSupply(input: ArtifactAcquisitionInput, output: string, dependencies: Dependencies = {}) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== REPOSITORY
    || String(input.runId) !== process.env.GITHUB_RUN_ID || String(input.runAttempt) !== process.env.GITHUB_RUN_ATTEMPT) fail('same-run runtime binding required');
  return acquireProductInput(input, output, { ...dependencies, limits: { packedBytes: 16 * 1024 ** 2, expandedBytes: 40 * 1024 ** 2, members: 4096 } }, true);
}
async function acquireProductInput(input: ArtifactAcquisitionInput, output: string, dependencies: Dependencies, legacy: boolean, registryConsumer = false, nativeOriginals = false, archiveConsumer = false,consumerModule?:'afs',candidateRole?:'service'|'sdk'|'native-runtime') {
  if (input?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/u.test(input.sourceSha) || !/^[a-f0-9]{40}$/u.test(input.runHeadSha)
    || !/^[a-f0-9]{64}$/u.test(input.artifactSha256) || ![input.runId, input.runAttempt, input.artifactId].every(positive)) fail('exact source/run/attempt/artifact binding required');
  if (Object.keys(input).some(key => !['schemaVersion', 'sourceSha', 'runHeadSha', 'runId', 'runAttempt', 'artifactId', 'artifactSha256'].includes(key))) fail('unknown acquisition selector');
  const checked = checkedAcquisitionOutput(output);
  output = checked.output;
  const limits = { packedBytes: limit(dependencies.limits?.packedBytes, LIMITS.packedBytes),
    expandedBytes: limit(dependencies.limits?.expandedBytes, LIMITS.expandedBytes), members: limit(dependencies.limits?.members, LIMITS.members) };
  const transport = dependencies.fetch ?? fetch;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
    ...(dependencies.token ? { Authorization: `Bearer ${dependencies.token}` } : {}) };
  const endpoint = (relative: string) => `https://api.github.com/repos/${REPOSITORY}/${relative}`;
  return await withOwnedTempRoot('xpod-artifact-acquisition-', async (temporary: string) => {
    const metadata: Record<string, unknown> = {};
    const originals: MetadataBinding['originals'] = {};
    async function json(name: string, relative: string, signal = AbortSignal.timeout(30_000), bound = 1024 * 1024): Promise<any> {
      signal.throwIfAborted();
      // Job dependencies may have closed while a cached API response still says queued.
      // Revalidate metadata; terminal success and exact custody checks remain mandatory.
      const response = await withinSignal(transport(endpoint(relative), { headers: { ...headers, 'Cache-Control': 'no-cache', Pragma: 'no-cache' }, redirect: 'error', signal }), signal);
      if (response.status !== 200) fail('GitHub metadata request failed');
      const destination = path.join(temporary, name + '.json');
      const downloaded = await stream(response, destination, bound, signal);
      const raw = readFileSync(destination);
      if (raw.length !== downloaded.bytes || sha256(raw) !== downloaded.sha256) fail('metadata changed before parsing');
      const value = JSON.parse(raw.toString('utf8'));
      metadata[name] = value;
      originals[name] = { path: `metadata/${name}.original.json`, ...downloaded, endpoint: endpoint(relative) };
      return value;
    }
    const run = await json('run', `actions/runs/${input.runId}/attempts/${input.runAttempt}`);
    // candidateRole is set ONLY by the private-issued candidate wrapper above.
    // Its completed-failure case remains exact: same run/attempt/head/workflow,
    // and the issuer already closed the same-attempt producer job/steps and
    // artifact/source/ancestor custody before the capability was issued.
    const candidateCompletedFailure = candidateRole !== undefined && run?.status === 'completed' && run?.conclusion === 'failure';
    if (run.id !== input.runId || run.run_attempt !== input.runAttempt || (!legacy && !candidateCompletedFailure && !(run.status==='completed'?run.conclusion==='success':(registryConsumer||candidateRole!==undefined)&&run.status==='in_progress'&&run.conclusion===null)) || (legacy && !['queued', 'in_progress', 'completed'].includes(run.status))
      || run.repository?.full_name !== REPOSITORY || run.head_repository?.full_name !== REPOSITORY || run.head_sha !== input.runHeadSha
      || !['push', 'pull_request', 'workflow_dispatch'].includes(run.event) || !positive(run.workflow_id)) fail('untrusted producer run');
    if (!registryConsumer && run.event !== 'pull_request' && input.sourceSha !== input.runHeadSha) fail('non-PR build source differs from run head');
    const workflow = await json('workflow', `actions/workflows/${run.workflow_id}`);
    if (workflow.id !== run.workflow_id || !(legacy ? ['.github/workflows/legacy-root-compat.yml', '.github/workflows/candidate.yml'].includes(workflow.path) : nativeOriginals ? [...(candidateRole?['.github/workflows/candidate.yml']:[]),'.github/workflows/agentfs-native-acceptance.yml','.github/workflows/build-qlever-macos-runtime.yml','.github/workflows/publish-qlever-runtime-sdk.yml',CSS_PRODUCT_WORKFLOW,CSS_ROUTED_PRODUCT_WORKFLOW].includes(workflow.path) : registryConsumer ? workflow.path === '.github/workflows/independent-publication.yml' : PRODUCERS.has(workflow.path)) || run.path?.split('@')[0] !== workflow.path) fail('untrusted producer workflow');
    let producerJob: any, legacyJobs: any;
    if (legacy) {
      // One metadata budget, including every response body; retries cannot reset it.
      const signal = AbortSignal.timeout(30_000);
      const context = createRequire(import.meta.url)('./lib/legacy-root-artifact-context.cjs');
      const jobName = context.producerJobName(input, run, workflow);
      const relative = `actions/runs/${input.runId}/attempts/${input.runAttempt}/jobs?per_page=100`;
      let remaining = 1024 * 1024;
      let pendingJobId: number | undefined;
      for (let attempt = 0; attempt < 6; attempt++) {
        if (remaining <= 0) fail('producer metadata cumulative byte bound exceeded');
        const name = `jobs-attempt-${attempt}`;
        const jobs = await json(name, relative, signal, remaining);
        remaining -= originals[name].bytes;
        // Identity is checked before deciding whether waiting is permitted.
        if (!Number.isSafeInteger(jobs.total_count) || !Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length) fail('producer jobs inventory mismatch');
        const selected = jobs.jobs.filter((job: any) => job.name === jobName);
        if (selected.length !== 1) fail('producer job is not unique');
        const job = selected[0];
        if ((pendingJobId !== undefined && job.id !== pendingJobId) || job.run_id !== input.runId || job.run_attempt !== input.runAttempt || job.head_sha !== input.runHeadSha) fail('producer job identity mismatch');
        if (job.status === 'completed') {
          producerJob = context.verifyProducerJob(input, run, workflow, jobs);
          legacyJobs = jobs;
          renameSync(path.join(temporary, name + '.json'), path.join(temporary, 'jobs.json'));
          originals.jobs = { ...originals[name], path: 'metadata/jobs.original.json' };
          delete metadata[name]; delete originals[name];
          break;
        }
        if (!['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(job.status) || job.conclusion !== null) fail('invalid nonterminal producer state');
        if (!positive(job.id)) fail('nonterminal producer id missing');
        pendingJobId = job.id;
        delete metadata[name]; delete originals[name];
        if (attempt === 5) fail('producer metadata attempt bound exceeded');
        await withinSignal(new Promise<void>(resolve => setTimeout(resolve, 500)), signal);
      }
      if (!producerJob) fail('terminal successful producer required');
      // Retained separately: the original three-member custody projection stays unchanged.
      delete metadata.jobs;
    }
    const artifact = await json('artifact', `actions/artifacts/${input.artifactId}`);
    const cliPublicationNames = cliPublicationArtifactNames({ expectedSourceSha: input.sourceSha, runId: input.runId, runAttempt: input.runAttempt });
    const consumerName=archiveConsumer?archiveConsumerArtifactName:registryConsumerArtifactName;
    const consumerNames = (['client', 'cli'] as const).map(module => consumerName({ module, sourceSha: input.sourceSha, runId: input.runId, runAttempt: input.runAttempt }))
      .concat((['api', 'css', 'afs'] as const).flatMap(module => MODULE_TARGETS.map(target => consumerName({ module, target: `${target.platform}-${target.arch}`, sourceSha: input.sourceSha, runId: input.runId, runAttempt: input.runAttempt }))));
    const allowedNames = candidateRole ? [candidateRole==='native-runtime'?candidateServiceNativeRuntimeArtifactName(input):candidateRole==='service'?`candidate-service-image-originals-${input.sourceSha}-${input.runId}-${input.runAttempt}`:`qlever-sdk-originals-service-trixie-linux-x64-${input.sourceSha}-${input.runId}-${input.runAttempt}`] : nativeOriginals && workflow.path === '.github/workflows/publish-qlever-runtime-sdk.yml' ? ['linux-x64','linux-arm64'].map(target=>`qlever-sdk-originals-${target}-${input.sourceSha}-${input.runId}-${input.runAttempt}`) : nativeOriginals ? workflow.path === '.github/workflows/agentfs-native-acceptance.yml' ? MODULE_TARGETS.map(target => `agentfs-native-${target.platform}-${target.arch}-${input.sourceSha}`) : (workflow.path === CSS_PRODUCT_WORKFLOW ? ['darwin-arm64'] : ['darwin-arm64','darwin-x64']).map(target => `qlever-local-runtime-${target}-${input.sourceSha}`).concat(workflow.path===CSS_ROUTED_PRODUCT_WORKFLOW?['linux-x64','linux-arm64'].map(target=>`qlever-local-runtime-${target}-${input.sourceSha}-${input.runId}-${input.runAttempt}`):[]).concat(workflow.path===CSS_ROUTED_PRODUCT_WORKFLOW?['linux-x64','linux-arm64'].map(target=>`qlever-sdk-originals-${target}-${input.sourceSha}-${input.runId}-${input.runAttempt}`):[]) : registryConsumer ? consumerNames.filter(name=>consumerModule!=='afs'||name.startsWith(archiveConsumer?'xpod-archive-consumer-afs-':'xpod-registry-consumer-afs-')) : legacy ? [`legacy-root-normal-afs-${input.sourceSha}-${input.runId}-${input.runAttempt}`] : workflow.path === CLI_PRODUCT_WORKFLOW
      ? [...['Linux', 'macOS'].map(os => `xpod-cli-${os}-${input.sourceSha}`), ...cliPublicationNames]
      : [API_PRODUCT_WORKFLOW, CSS_PRODUCT_WORKFLOW,CSS_ROUTED_PRODUCT_WORKFLOW].includes(workflow.path)
        ? productTargets(workflow.path !== API_PRODUCT_WORKFLOW ? 'css' : 'api').filter(row => row.nativeSourceAvailable||workflow.path===CSS_ROUTED_PRODUCT_WORKFLOW)
          .map(row => `${workflow.path !== API_PRODUCT_WORKFLOW ? 'css' : 'api'}-module-products-${row.target}-${input.sourceSha}-${input.runId}-${input.runAttempt}`)
      : MODULE_TARGETS.flatMap(target => [`afs-module-products-${target.platform}-${target.arch}-${input.sourceSha}-${input.runId}-${input.runAttempt}`, `afs-module-production-${target.platform}-${target.arch}-${input.sourceSha}-${input.runId}-${input.runAttempt}`]);
    const created = Date.parse(artifact.created_at), started = Date.parse(run.run_started_at), completed = (registryConsumer||candidateRole!==undefined) && run.status==='in_progress' ? Date.now() : Date.parse(legacy ? producerJob.completed_at : run.updated_at);
    if (artifact.id !== input.artifactId || !allowedNames.includes(artifact.name) || artifact.expired !== false || artifact.workflow_run?.id !== run.id
      || artifact.workflow_run?.head_sha !== input.runHeadSha || artifact.digest !== 'sha256:' + input.artifactSha256
      || !positive(artifact.size_in_bytes) || artifact.size_in_bytes > limits.packedBytes
      || ![created, started, completed].every(Number.isFinite) || created < started || created > completed || (legacy && (created < Date.parse(producerJob.started_at) || created > Date.parse(producerJob.completed_at)))) fail('artifact identity/digest/attempt window mismatch');
    if (legacy) createRequire(import.meta.url)('./lib/legacy-root-artifact-context.cjs').verifyContext(input, metadata, legacyJobs);
    let url = endpoint(`actions/artifacts/${input.artifactId}/zip`);
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await transport(url, { ...(new URL(url).hostname === 'api.github.com' ? { headers } : {}), redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 3) fail('artifact redirect invalid');
      const next = new URL(location, url);
      if (next.protocol !== 'https:' || next.username || next.password || (next.port && next.port !== '443')) fail('artifact redirect invalid');
      url = next.href;
    }
    if (response?.status !== 200) fail('artifact download failed');
    const archive = path.join(temporary, 'artifact.zip');
    const downloaded = await stream(response, archive, limits.packedBytes);
    if (downloaded.sha256 !== input.artifactSha256 || downloaded.bytes !== artifact.size_in_bytes) fail('downloaded artifact digest/size mismatch');
    const inspected = createRequire(import.meta.url)('./lib/product-artifact-command.cjs').inspectArtifact([path.join(import.meta.dir, 'lib/inspect-product-artifact.py'), archive, input.artifactSha256,
      String(limits.packedBytes), String(limits.expandedBytes), String(limits.members)], { evidence: dependencies.diagnostics, label: 'zip-inspection', timeout: moduleArtifactLimits.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    if (inspected.status !== 0 || inspected.error) fail('artifact ZIP inspection failed');
    const inventory = JSON.parse(inspected.stdout);
    const projection = Buffer.from(JSON.stringify(metadata, null, 2) + '\n');
    const jobsOriginal = legacy ? originals.jobs : undefined;
    if (legacy) delete originals.jobs;
    const metadataBinding: MetadataBinding = { originals,
      projection: { path: 'metadata.json', bytes: projection.length, sha256: sha256(projection) } };
    const cliPublication = workflow.path === CLI_PRODUCT_WORKFLOW && cliPublicationNames.includes(artifact.name);
    const cliTestMaterial = workflow.path === CLI_PRODUCT_WORKFLOW && !cliPublication;
    const receipt = { schemaVersion: 1, kind: legacy ? 'legacy-root-same-run-acquisition' : 'independent-product-artifact-acquisition', status: 'blocked',
      ...(legacy ? { producerJob: { ...jobsOriginal, path: 'metadata/jobs.original.json' } } : {}),
      materialRole: nativeOriginals ? 'native-admission-originals' : registryConsumer ? archiveConsumer?'archive-consumer-originals':'registry-consumer-originals' : legacy ? 'legacy-root-normal-js-originals' : cliPublication ? CLI_PUBLICATION_MATERIAL_ROLE : cliTestMaterial ? 'test-materials' : ([API_PRODUCT_WORKFLOW, CSS_PRODUCT_WORKFLOW,CSS_ROUTED_PRODUCT_WORKFLOW].includes(workflow.path) || (workflow.path === '.github/workflows/agentfs-module-mounted-acceptance.yml' && artifact.name.startsWith('afs-module-production-'))) ? 'controlled-preview-materials' : 'module-product-materials',
      repository: REPOSITORY, expectedSourceSha: input.sourceSha, runHeadSha: input.runHeadSha,
      runId: input.runId, runAttempt: input.runAttempt, artifactId: input.artifactId, workflowPath: workflow.path,
      archive: { path: 'artifact.zip', ...downloaded }, inventory,
      metadata: metadataBinding,
      actualCheckoutVerified: false, candidatePlanGenerated: false, published: false, releaseQualified: false,
      blockers: [...(cliTestMaterial ? ['cli-consumer-test-archive-not-publishable'] : []),
        'producer-checkout-source-binding-unverified', 'product-member-projection-not-performed', 'source-native-legal-consumer-admission-unverified'],
      limitations: ['Run timestamps constrain artifact attempt association; a producer receipt must still bind the exact attempt and actual build checkout.',
        'ZIP custody and member integrity are transport facts. No members are extracted and no product or release admission is inferred.'] };
    let outputIdentity: { dev: number; ino: number } | undefined;
    try {
      assertOwnedTempParent(checked.temporaryParent);
      assertNewAcquisitionOutput(output);
      mkdirSync(output, { mode: 0o700 });
      const created = lstatSync(output);
      if (!created.isDirectory() || created.isSymbolicLink() || created.dev !== checked.temporaryParent.identity.dev) fail('created output ownership changed');
      outputIdentity = { dev: created.dev, ino: created.ino };
      renameSync(archive, path.join(output, 'artifact.zip'));
      mkdirSync(path.join(output, 'metadata'), { mode: 0o700 });
      for (const name of [...METADATA_NAMES, ...(legacy ? ['jobs'] : [])]) {
        const original = path.join(output, name === 'jobs' ? 'metadata/jobs.original.json' : originals[name].path);
        renameSync(path.join(temporary, name + '.json'), original);
        chmodSync(original, 0o400);
      }
      writeFileSync(path.join(output, 'metadata.json'), projection, { flag: 'wx', mode: 0o400 });
      verifyAcquiredMetadata(output, metadataBinding);
      writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (outputIdentity) {
        try {
          assertOwnedTempParent(checked.temporaryParent);
          const current = lstatSync(output);
          if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== outputIdentity.dev || current.ino !== outputIdentity.ino) fail('output ownership changed; partial originals retained');
        } catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], 'Artifact acquisition failed and output ownership changed; originals retained'), { cause: error }); }
        // A check followed by recursive removal still races with replacement.
        // Keep partial output on failure; never delete an uncertain directory.
      }
      throw error;
    }
    return receipt;
  }, checked.temporaryParent);
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 4) fail('input JSON and new output directory required');
    const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    console.log(JSON.stringify(await acquireIndependentProductInput(input, path.resolve(process.argv[3]), { token: process.env.GH_TOKEN }), null, 2));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
