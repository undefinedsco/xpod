import { createHash } from 'node:crypto';
import { CLI_PRODUCT_WORKFLOW, cliPublicationArtifactNames, type ArtifactAcquisitionInput } from '../../acquire-independent-product-input';
import { CLI_SOURCE_POLICY } from './source-rules';

declare const originBrand: unique symbol;
/** Only observeCliGitHubOrigin can issue this in-process capability. */
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
  readonly scope: 'github-api-run-workflow-artifact-observation-only';
  readonly originals: readonly { name: string; endpoint: string; sha256: string; bytes: number }[];
}
type Original = { name: string; endpoint: string; data: Buffer };
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

/** Fixed HTTPS transport and code-reviewed workflow policy. No transport callback,
 * caller workflow allowlist or serialized observation can grant this authority.
 * This does not download a product or attest the builder's actual checkout. */
export async function observeCliGitHubOrigin(input: ArtifactAcquisitionInput, options: { token?: string } = {}): Promise<GitHubOriginObservation> {
  if (input.schemaVersion !== 1 || !/^[a-f0-9]{40}$/u.test(input.sourceSha)
    || !/^[a-f0-9]{40}$/u.test(input.runHeadSha) || !/^[a-f0-9]{64}$/u.test(input.artifactSha256)
    || ![input.runId, input.runAttempt, input.artifactId].every(positive)) fail('exact coordinates required');
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
    || run.status !== 'completed' || run.conclusion !== 'success' || !positive(run.workflow_id)
    || !['workflow_dispatch', 'pull_request'].includes(run.event)
    || (run.event !== 'pull_request' && input.sourceSha !== input.runHeadSha)
    || run.path?.split('@')[0] !== CLI_PRODUCT_WORKFLOW) fail('untrusted run coordinate');
  const workflow = await read('workflow.original.json', `actions/workflows/${run.workflow_id}`);
  if (workflow.id !== run.workflow_id || workflow.path !== CLI_PRODUCT_WORKFLOW) fail('unexpected workflow');
  const content = await read('workflow-source.original.json', `contents/${CLI_PRODUCT_WORKFLOW}?ref=${input.sourceSha}`);
  if (content.type !== 'file' || content.path !== CLI_PRODUCT_WORKFLOW || content.encoding !== 'base64'
    || typeof content.content !== 'string') fail('workflow source missing');
  const workflowBytes = Buffer.from(content.content.replace(/\s/gu, ''), 'base64');
  if (sha(workflowBytes) !== CLI_SOURCE_POLICY.workflow) fail('immutable workflow policy not reviewed');
  const artifact = await read('artifact.original.json', `actions/artifacts/${input.artifactId}`);
  if (artifact.id !== input.artifactId || artifact.expired !== false || artifact.workflow_run?.id !== input.runId
    || artifact.workflow_run?.head_sha !== input.runHeadSha || artifact.digest !== 'sha256:' + input.artifactSha256
    || !positive(artifact.size_in_bytes) || !cliPublicationArtifactNames({ expectedSourceSha: input.sourceSha,
      runId: input.runId, runAttempt: input.runAttempt }).includes(artifact.name)) fail('artifact binding mismatch');
  const jobs = await read('jobs.original.json', `actions/runs/${input.runId}/attempts/${input.runAttempt}/jobs?per_page=100`);
  if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length || jobs.jobs.length > 100) fail('incomplete job observation');
  const os = artifact.name.startsWith('xpod-cli-publication-preparation-macOS-') ? 'macos-latest' : 'ubuntu-latest';
  const matching = jobs.jobs.filter((job: any) => job.name === `standalone-cli (${os})`);
  if (matching.length !== 1) fail('unique producer job required');
  const job = matching[0];
  const created = Date.parse(artifact.created_at), start = Date.parse(job.started_at), end = Date.parse(job.completed_at);
  if (!positive(job.id) || job.run_id !== input.runId || job.run_attempt !== input.runAttempt
    || job.head_sha !== input.runHeadSha || job.status !== 'completed' || job.conclusion !== 'success'
    || ![created, start, end].every(Number.isFinite) || created < start || created > end
    || !job.steps?.some((step: any) => step.name === 'Build normal CLI publication preparation'
      && step.status === 'completed' && step.conclusion === 'success')) fail('producer job/attempt window mismatch');
  const facts: GitHubOriginFacts = Object.freeze({ repository, workflowPath: CLI_PRODUCT_WORKFLOW,
    workflowSourceSha256: sha(workflowBytes), sourceSha: input.sourceSha, runHeadSha: input.runHeadSha,
    runId: input.runId, runAttempt: input.runAttempt, artifactId: input.artifactId,
    artifactSha256: input.artifactSha256, producerJobId: job.id,
    scope: 'github-api-run-workflow-artifact-observation-only',
    originals: Object.freeze(originals.map(row => Object.freeze({ name: row.name, endpoint: row.endpoint,
      sha256: sha(row.data), bytes: row.data.length }))) });
  const observation = Object.freeze({}) as GitHubOriginObservation;
  issued.set(observation, { facts, originals }); return observation;
}
