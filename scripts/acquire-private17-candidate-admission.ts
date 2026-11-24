#!/usr/bin/env bun
/**
 * Obtain the Private17 exact-pair joint admission for one candidate without a person in the loop.
 *
 * The candidate dispatches the private producer workflow (repository given by the workflow) for its own
 * source SHA and service image, waits for that run, checks where the proof came from, and then
 * publishes the sanitized proof as the `private17-<sha>-<digest>` Release the deploy gate already
 * downloads. The digest of those bytes is handed to the deploy gate as its admission authority, in
 * place of the repository variable a person used to set by hand.
 *
 * Authority: the proof must come from a successful `workflow_dispatch` run of the pinned workflow
 * file on the producer repository's `main`, found by the request id this candidate gave it. The deploy gate still
 * verifies the proof's full contents (source, images, runner, fixtures, cleanup) independently.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const PUBLIC_REPO = 'undefinedsco/xpod';
export const PRODUCER_WORKFLOW = 'qlever-installed-image-conformance.yml';
export const PRODUCER_WORKFLOW_PATH = `.github/workflows/${PRODUCER_WORKFLOW}`;
export const PRODUCER_RUN_NAME = 'QLever Installed Image Conformance';
export const PROOF_ASSET = 'private17-admission.json';
const PROOF_MAX_BYTES = 64 * 1024;
const RUN_MARKER = /^producer run: (\d{1,20})$/m;

export class StepError extends Error {
  constructor(readonly stage: string, readonly errorClass: string) {
    super(JSON.stringify({ stage, errorClass }));
  }
}

export interface Candidate {
  /** owner/name of the private producer repository, supplied by the workflow. */
  producerRepo: string;
  sourceSha: string;
  installedImage: string;
  pgImage: string;
  requestId: string;
}

export interface GitHubClient {
  /** JSON request against api.github.com; `undefined` for 404, StepError for other failures. */
  json<T>(token: string, method: string, path: string, body?: unknown): Promise<T | undefined>;
  /** Raw bytes of a URL (artifact zip, release asset). */
  bytes(token: string, url: string, accept: string): Promise<Buffer>;
  uploadAsset(token: string, uploadUrl: string, name: string, bytes: Buffer): Promise<void>;
}

export interface Dependencies {
  github: GitHubClient;
  /** Extract one file from a zip archive. */
  unzipEntry(zip: Buffer, entry: string): Buffer;
  sleep(ms: number): Promise<void>;
  now(): number;
  privateToken: string;
  publicToken: string;
  /** How long to wait for the dispatched run to appear and to finish. */
  appearTimeoutMs?: number;
  completeTimeoutMs?: number;
  pollMs?: number;
}

interface WorkflowRun {
  id: number;
  name?: string;
  display_title: string;
  path: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  repository: { full_name: string };
}

interface Release {
  id: number;
  body: string | null;
  upload_url: string;
  assets: { name: string; url: string }[];
}

export function private17Tag(candidate: Candidate): string {
  return `private17-${candidate.sourceSha}-${candidate.installedImage.split('@sha256:')[1]}`;
}

export function validateCandidate(candidate: Candidate): Candidate {
  if (!/^[a-f0-9]{40}$/.test(candidate.sourceSha)) throw new StepError('private17-input', 'invalid-source-sha');
  if (!/^ghcr\.io\/undefinedsco\/xpod@sha256:[a-f0-9]{64}$/.test(candidate.installedImage)) {
    throw new StepError('private17-input', 'invalid-service-image');
  }
  if (!/^ccr\.ccs\.tencentyun\.com\/undefineds\/xpod-rdf-postgres@sha256:[a-f0-9]{64}$/.test(candidate.pgImage)) {
    throw new StepError('private17-input', 'invalid-pg-image');
  }
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(candidate.requestId)) throw new StepError('private17-input', 'invalid-request-id');
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(candidate.producerRepo) || candidate.producerRepo === PUBLIC_REPO) {
    throw new StepError('private17-input', 'invalid-producer-repo');
  }
  return candidate;
}

/** The run must be the pinned producer workflow on main, started by this candidate, and green. */
export function assertProducerRun(run: WorkflowRun, candidate: Pick<Candidate, 'producerRepo' | 'requestId'>): void {
  const expectedTitle = `${PRODUCER_RUN_NAME} ${candidate.requestId}`;
  if (run.repository?.full_name !== candidate.producerRepo || run.path !== PRODUCER_WORKFLOW_PATH
    || run.head_branch !== 'main' || run.event !== 'workflow_dispatch' || run.display_title !== expectedTitle) {
    throw new StepError('private17-provenance', 'unexpected-producer-run');
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    throw new StepError('private17-producer', 'producer-run-failed');
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Cheap identity checks; the deploy gate runs the full public validator on the same bytes. */
export function assertProofIdentity(proof: Buffer, summary: Buffer, candidate: Candidate): string {
  if (proof.length === 0 || proof.length > PROOF_MAX_BYTES) throw new StepError('private17-proof', 'invalid-size');
  const digest = sha256(proof);
  let parsedProof: Record<string, unknown>;
  let parsedSummary: Record<string, unknown>;
  try {
    parsedProof = JSON.parse(proof.toString('utf8'));
    parsedSummary = JSON.parse(summary.toString('utf8'));
  } catch {
    throw new StepError('private17-proof', 'invalid-json');
  }
  if (parsedSummary.proofSha256 !== digest || parsedSummary.sourceSha !== candidate.sourceSha) {
    throw new StepError('private17-proof', 'summary-mismatch');
  }
  if (parsedProof.status !== 'ok' || parsedProof.sourceSha !== candidate.sourceSha
    || parsedProof.serviceImage !== candidate.installedImage || parsedProof.postgresImage !== candidate.pgImage) {
    throw new StepError('private17-proof', 'pair-mismatch');
  }
  return digest;
}

async function producerProof(deps: Dependencies, runId: number, candidate: Candidate): Promise<{ proof: Buffer; digest: string }> {
  const run = await deps.github.json<WorkflowRun>(deps.privateToken, 'GET', `/repos/${candidate.producerRepo}/actions/runs/${runId}`);
  if (!run) throw new StepError('private17-provenance', 'producer-run-missing');
  assertProducerRun(run, candidate);
  const artifacts = await deps.github.json<{ artifacts: { id: number; name: string; expired: boolean; archive_download_url: string }[] }>(
    deps.privateToken, 'GET', `/repos/${candidate.producerRepo}/actions/runs/${runId}/artifacts?per_page=100`);
  const artifact = artifacts?.artifacts.find(entry => entry.name === `private17-joint-admission-${runId}` && !entry.expired);
  if (!artifact) throw new StepError('private17-producer', 'proof-artifact-missing');
  const zip = await deps.github.bytes(deps.privateToken, artifact.archive_download_url, 'application/vnd.github+json');
  const proof = deps.unzipEntry(zip, PROOF_ASSET);
  const digest = assertProofIdentity(proof, deps.unzipEntry(zip, 'proof-summary.json'), candidate);
  return { proof, digest };
}

async function dispatchProducer(deps: Dependencies, candidate: Candidate): Promise<number> {
  const runsPath = `/repos/${candidate.producerRepo}/actions/workflows/${PRODUCER_WORKFLOW}/runs?event=workflow_dispatch&branch=main&per_page=30`;
  const title = `${PRODUCER_RUN_NAME} ${candidate.requestId}`;
  const find = async (): Promise<WorkflowRun | undefined> =>
    (await deps.github.json<{ workflow_runs: WorkflowRun[] }>(deps.privateToken, 'GET', runsPath))
      ?.workflow_runs.find(run => run.display_title === title);
  // A retried job keeps its request id, so it resumes the run it already started.
  let found = await find();
  if (!found) {
    await deps.github.json(deps.privateToken, 'POST', `/repos/${candidate.producerRepo}/actions/workflows/${PRODUCER_WORKFLOW}/dispatches`, {
      ref: 'main',
      inputs: {
        xpod_ref: candidate.sourceSha,
        installed_service_image: candidate.installedImage,
        pg17_qlever_image: candidate.pgImage,
        request_id: candidate.requestId,
      },
    });
  }
  const pollMs = deps.pollMs ?? 15_000;
  const appearBy = deps.now() + (deps.appearTimeoutMs ?? 3 * 60_000);
  while (!found) {
    if (deps.now() > appearBy) throw new StepError('private17-dispatch', 'producer-run-not-found');
    await deps.sleep(pollMs);
    found = await find();
  }
  let run: WorkflowRun = found;
  const completeBy = deps.now() + (deps.completeTimeoutMs ?? 40 * 60_000);
  while (run.status !== 'completed') {
    if (deps.now() > completeBy) throw new StepError('private17-producer', 'producer-run-timeout');
    await deps.sleep(pollMs);
    const latest: WorkflowRun | undefined = await deps.github.json<WorkflowRun>(
      deps.privateToken, 'GET', `/repos/${candidate.producerRepo}/actions/runs/${run.id}`);
    if (!latest) throw new StepError('private17-provenance', 'producer-run-missing');
    run = latest;
  }
  return run.id;
}

async function releaseAsset(deps: Dependencies, release: Release): Promise<Buffer> {
  const asset = release.assets.find(entry => entry.name === PROOF_ASSET);
  if (!asset) throw new StepError('private17-release', 'asset-missing');
  return deps.github.bytes(deps.publicToken, asset.url, 'application/octet-stream');
}

/** A published proof is reused only when its producer run still verifies and yields the same bytes. */
async function reusePublished(deps: Dependencies, release: Release, candidate: Candidate): Promise<{ digest: string; runId: number }> {
  const marker = RUN_MARKER.exec(release.body ?? '');
  if (!marker) throw new StepError('private17-release', 'release-without-provenance');
  const runId = Number(marker[1]);
  const published = await releaseAsset(deps, release);
  const { digest } = await producerProof(deps, runId, candidate);
  if (sha256(published) !== digest) throw new StepError('private17-release', 'published-bytes-mismatch');
  return { digest, runId };
}

export async function acquireCandidateAdmission(candidate: Candidate, deps: Dependencies): Promise<{ digest: string; runId: number; reused: boolean }> {
  validateCandidate(candidate);
  const tag = private17Tag(candidate);
  const existing = await deps.github.json<Release>(deps.publicToken, 'GET', `/repos/${PUBLIC_REPO}/releases/tags/${tag}`);
  if (existing) return { ...await reusePublished(deps, existing, candidate), reused: true };

  const runId = await dispatchProducer(deps, candidate);
  const { proof, digest } = await producerProof(deps, runId, candidate);
  let release: Release | undefined;
  try {
    release = await deps.github.json<Release>(deps.publicToken, 'POST', `/repos/${PUBLIC_REPO}/releases`, {
      tag_name: tag,
      target_commitish: candidate.sourceSha,
      name: tag,
      body: `Sanitized exact-pair native admission transport. Not RC acceptance.\n\nproducer run: ${runId}`,
      prerelease: true,
    });
  } catch (error) {
    // Another attempt published the same pair first; accept it only if it verifies.
    const raced = await deps.github.json<Release>(deps.publicToken, 'GET', `/repos/${PUBLIC_REPO}/releases/tags/${tag}`);
    if (!raced) throw error;
    return { ...await reusePublished(deps, raced, candidate), reused: true };
  }
  if (!release) throw new StepError('private17-release', 'release-create-failed');
  await deps.github.uploadAsset(deps.publicToken, release.upload_url, PROOF_ASSET, proof);
  return { digest, runId, reused: false };
}

function createGitHubClient(fetchImpl: typeof fetch = fetch): GitHubClient {
  const headers = (token: string, accept: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    accept,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'xpod-candidate-private17',
  });
  return {
    async json<T>(token: string, method: string, path: string, body?: unknown): Promise<T | undefined> {
      const response = await fetchImpl(`https://api.github.com${path}`, {
        method,
        headers: { ...headers(token, 'application/vnd.github+json'), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new StepError('private17-github', `http-${response.status}`);
      return response.status === 204 ? undefined : await response.json() as T;
    },
    async bytes(token: string, url: string, accept: string): Promise<Buffer> {
      // Redirects to signed storage URLs drop the Authorization header (cross-origin).
      const response = await fetchImpl(url, { headers: headers(token, accept), redirect: 'follow' });
      if (!response.ok) throw new StepError('private17-github', `http-${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    async uploadAsset(token: string, uploadUrl: string, name: string, bytes: Buffer): Promise<void> {
      const url = `${uploadUrl.replace(/\{.*\}$/, '')}?name=${encodeURIComponent(name)}`;
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { ...headers(token, 'application/vnd.github+json'), 'content-type': 'application/json' },
        body: bytes,
      });
      if (!response.ok) throw new StepError('private17-release', `asset-upload-http-${response.status}`);
    },
  };
}

/** Info-ZIP `unzip` cannot read an archive from stdin, so the archive goes through an owned temp file. */
export function unzipEntry(zip: Buffer, entry: string): Buffer {
  const dir = mkdtempSync(path.join(process.env.RUNNER_TEMP || tmpdir(), 'private17-proof-'));
  try {
    const archive = path.join(dir, 'proof.zip');
    writeFileSync(archive, zip, { mode: 0o600 });
    const result = spawnSync('unzip', ['-p', archive, entry], { maxBuffer: PROOF_MAX_BYTES * 2 });
    if (result.error || result.status !== 0 || !result.stdout?.length) throw new StepError('private17-producer', 'proof-entry-missing');
    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function argValue(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new StepError('private17-input', `missing-${flag.replace(/^--/, '')}`);
  return value;
}

async function cli(): Promise<void> {
  const privateToken = process.env.XPOD_PRO_ACTIONS_TOKEN ?? '';
  const publicToken = process.env.GH_TOKEN ?? '';
  if (!privateToken) throw new StepError('private17-input', 'missing-private-producer-token');
  if (!publicToken) throw new StepError('private17-input', 'missing-public-token');
  const result = await acquireCandidateAdmission({
    sourceSha: argValue('--source-sha'),
    producerRepo: argValue('--producer-repo'),
    installedImage: argValue('--installed-image'),
    pgImage: argValue('--pg-image'),
    requestId: argValue('--request-id'),
  }, {
    github: createGitHubClient(),
    unzipEntry,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    privateToken,
    publicToken,
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `admission_sha256=${result.digest}\n`);
  process.stdout.write(`${JSON.stringify({ stage: 'private17-transport', status: 'ok', producerRun: result.runId, reused: result.reused })}\n`);
}

if (require.main === module) {
  cli().catch((error) => {
    process.stderr.write(`${error instanceof StepError ? error.message : JSON.stringify({ stage: 'private17-transport', errorClass: 'unexpected' })}\n`);
    process.exitCode = 1;
  });
}
