import { createHash } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { MODULE_TARGETS } from '../packages/xpod-cli/src/module-catalog';
const { withOwnedTempRoot } = createRequire(import.meta.url)('./lib/owned-temp-root.cjs');

// Trust is program policy, not a caller-supplied workflow allowlist. Neither the
// API native-input workflow nor contract fixtures are product producers.
const REPOSITORY = 'undefinedsco/xpod';
export const API_PRODUCT_WORKFLOW = '.github/workflows/api-module-product.yml';
const PRODUCERS = new Set(['.github/workflows/cli-package.yml', '.github/workflows/agentfs-module-mounted-acceptance.yml', API_PRODUCT_WORKFLOW]);
const LIMITS = { packedBytes: 512 * 1024 ** 2, expandedBytes: 1024 ** 3, members: 50_000 };
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
  // Tests and constrained callers may lower transport limits, never raise them.
  limits?: Partial<typeof LIMITS>;
}
function fail(message: string): never { throw new Error('Artifact acquisition: ' + message); }
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0; }
export function assertNewAcquisitionOutput(output: string): string {
  output = path.resolve(output);
  let parent = path.parse(output).root;
  for (const part of path.dirname(output).slice(parent.length).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, part);
    const stat = lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('output parent must be an existing directory without links');
  }
  try { lstatSync(output); fail('output already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return output;
}
function limit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!positive(value) || value > maximum) fail('invalid lower resource bound');
  return value;
}
async function stream(response: Response, destination: string, bound: number) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > bound)) {
    await response.body?.cancel();
    fail('download declared size exceeds bound');
  }
  if (!response.body) fail('download body missing');
  const fd = openSync(destination, 'wx', 0o600), hash = createHash('sha256');
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > bound) fail('download actual size exceeds bound');
      hash.update(chunk.value);
      let offset = 0;
      while (offset < chunk.value.length) offset += writeSync(fd, chunk.value, offset);
    }
    if (length !== null && Number(length) !== bytes) fail('download content length mismatch');
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await reader.cancel().catch(() => {});
    closeSync(fd);
  }
}
/** Acquires a ZIP and inventory, never extracts members or confers product admission. */
export async function acquireIndependentProductInput(input: ArtifactAcquisitionInput, output: string, dependencies: Dependencies = {}) {
  if (input?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/u.test(input.sourceSha) || !/^[a-f0-9]{40}$/u.test(input.runHeadSha)
    || !/^[a-f0-9]{64}$/u.test(input.artifactSha256) || ![input.runId, input.runAttempt, input.artifactId].every(positive)) fail('exact source/run/attempt/artifact binding required');
  if (Object.keys(input).some(key => !['schemaVersion', 'sourceSha', 'runHeadSha', 'runId', 'runAttempt', 'artifactId', 'artifactSha256'].includes(key))) fail('unknown acquisition selector');
  output = assertNewAcquisitionOutput(output);
  const limits = { packedBytes: limit(dependencies.limits?.packedBytes, LIMITS.packedBytes),
    expandedBytes: limit(dependencies.limits?.expandedBytes, LIMITS.expandedBytes), members: limit(dependencies.limits?.members, LIMITS.members) };
  const transport = dependencies.fetch ?? fetch;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
    ...(dependencies.token ? { Authorization: `Bearer ${dependencies.token}` } : {}) };
  const endpoint = (relative: string) => `https://api.github.com/repos/${REPOSITORY}/${relative}`;
  return await withOwnedTempRoot('xpod-artifact-acquisition-', async (temporary: string) => {
    const metadata: Record<string, unknown> = {};
    const originals: MetadataBinding['originals'] = {};
    async function json(name: string, relative: string): Promise<any> {
      const response = await transport(endpoint(relative), { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (response.status !== 200) fail('GitHub metadata request failed');
      const destination = path.join(temporary, name + '.json');
      const downloaded = await stream(response, destination, 1024 * 1024);
      const raw = readFileSync(destination);
      if (raw.length !== downloaded.bytes || sha256(raw) !== downloaded.sha256) fail('metadata changed before parsing');
      const value = JSON.parse(raw.toString('utf8'));
      metadata[name] = value;
      originals[name] = { path: `metadata/${name}.original.json`, ...downloaded, endpoint: endpoint(relative) };
      return value;
    }
    const run = await json('run', `actions/runs/${input.runId}/attempts/${input.runAttempt}`);
    if (run.id !== input.runId || run.run_attempt !== input.runAttempt || run.status !== 'completed' || run.conclusion !== 'success'
      || run.repository?.full_name !== REPOSITORY || run.head_repository?.full_name !== REPOSITORY || run.head_sha !== input.runHeadSha
      || !['push', 'pull_request', 'workflow_dispatch'].includes(run.event) || !positive(run.workflow_id)) fail('untrusted producer run');
    if (run.event !== 'pull_request' && input.sourceSha !== input.runHeadSha) fail('non-PR build source differs from run head');
    const workflow = await json('workflow', `actions/workflows/${run.workflow_id}`);
    if (workflow.id !== run.workflow_id || !PRODUCERS.has(workflow.path) || run.path?.split('@')[0] !== workflow.path) fail('untrusted producer workflow');
    const artifact = await json('artifact', `actions/artifacts/${input.artifactId}`);
    const allowedNames = workflow.path === '.github/workflows/cli-package.yml'
      ? ['Linux', 'macOS'].map(os => `xpod-cli-${os}-${input.sourceSha}`)
      : workflow.path === API_PRODUCT_WORKFLOW
        ? [`api-module-products-darwin-arm64-${input.sourceSha}-${input.runId}-${input.runAttempt}`]
      : MODULE_TARGETS.map(target => `afs-module-products-${target.platform}-${target.arch}-${input.sourceSha}-${input.runId}-${input.runAttempt}`);
    const created = Date.parse(artifact.created_at), started = Date.parse(run.run_started_at), completed = Date.parse(run.updated_at);
    if (artifact.id !== input.artifactId || !allowedNames.includes(artifact.name) || artifact.expired !== false || artifact.workflow_run?.id !== run.id
      || artifact.workflow_run?.head_sha !== input.runHeadSha || artifact.digest !== 'sha256:' + input.artifactSha256
      || !positive(artifact.size_in_bytes) || artifact.size_in_bytes > limits.packedBytes
      || ![created, started, completed].every(Number.isFinite) || created < started || created > completed) fail('artifact identity/digest/attempt window mismatch');
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
    const inspected = spawnSync('python3', [path.join(import.meta.dir, 'lib/inspect-product-artifact.py'), archive, input.artifactSha256,
      String(limits.packedBytes), String(limits.expandedBytes), String(limits.members)], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    if (inspected.status !== 0 || inspected.error) fail('artifact ZIP inspection failed');
    const inventory = JSON.parse(inspected.stdout);
    const projection = Buffer.from(JSON.stringify(metadata, null, 2) + '\n');
    const metadataBinding: MetadataBinding = { originals,
      projection: { path: 'metadata.json', bytes: projection.length, sha256: sha256(projection) } };
    const cliTestMaterial = workflow.path === '.github/workflows/cli-package.yml';
    const receipt = { schemaVersion: 1, kind: 'independent-product-artifact-acquisition', status: 'blocked',
      materialRole: cliTestMaterial ? 'test-materials' : workflow.path === API_PRODUCT_WORKFLOW ? 'controlled-preview-materials' : 'module-product-materials',
      repository: REPOSITORY, expectedSourceSha: input.sourceSha, runHeadSha: input.runHeadSha,
      runId: input.runId, runAttempt: input.runAttempt, artifactId: input.artifactId, workflowPath: workflow.path,
      archive: { path: 'artifact.zip', ...downloaded }, inventory,
      metadata: metadataBinding,
      actualCheckoutVerified: false, candidatePlanGenerated: false, published: false, releaseQualified: false,
      blockers: [...(cliTestMaterial ? ['cli-consumer-test-archive-not-publishable'] : []),
        'producer-checkout-source-binding-unverified', 'product-member-projection-not-performed', 'source-native-legal-consumer-admission-unverified'],
      limitations: ['Run timestamps constrain artifact attempt association; a producer receipt must still bind the exact attempt and actual build checkout.',
        'ZIP custody and member integrity are transport facts. No members are extracted and no product or release admission is inferred.'] };
    let outputOwned = false;
    try {
      mkdirSync(output, { mode: 0o700 }); outputOwned = true;
      renameSync(archive, path.join(output, 'artifact.zip'));
      mkdirSync(path.join(output, 'metadata'), { mode: 0o700 });
      for (const name of METADATA_NAMES) {
        const original = path.join(output, originals[name].path);
        renameSync(path.join(temporary, name + '.json'), original);
        chmodSync(original, 0o400);
      }
      writeFileSync(path.join(output, 'metadata.json'), projection, { flag: 'wx', mode: 0o400 });
      verifyAcquiredMetadata(output, metadataBinding);
      writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (outputOwned) {
        try { rmSync(output, { recursive: true, force: true }); }
        catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], 'Artifact output and cleanup failed'), { cause: error }); }
      }
      throw error;
    }
    return receipt;
  });
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 4) fail('input JSON and new output directory required');
    const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    console.log(JSON.stringify(await acquireIndependentProductInput(input, path.resolve(process.argv[3]), { token: process.env.GH_TOKEN }), null, 2));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
