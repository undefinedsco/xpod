import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  acquireCandidateAdmission,
  unzipEntry,
  PRODUCER_WORKFLOW_PATH,
  StepError,
  type Candidate,
  type Dependencies,
  type GitHubClient,
} from '../../scripts/acquire-private17-candidate-admission';

const candidate: Candidate = {
  producerRepo: 'example/private-producer',
  sourceSha: 'c'.repeat(40),
  installedImage: `ghcr.io/undefinedsco/xpod@sha256:${'b'.repeat(64)}`,
  pgImage: `ccr.ccs.tencentyun.com/undefineds/xpod-rdf-postgres@sha256:${'d'.repeat(64)}`,
  requestId: 'xpod-123-1',
};
const tag = `private17-${'c'.repeat(40)}-${'b'.repeat(64)}`;
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function proofBytes(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 2, status: 'ok', sourceSha: candidate.sourceSha,
    serviceImage: candidate.installedImage, postgresImage: candidate.pgImage, ...overrides,
  }));
}

interface FakeState {
  runs: Record<number, Record<string, unknown>>;
  /** Runs listed by the workflow runs endpoint. */
  listed: number[];
  release?: { id: number; body: string; upload_url: string; assets: { name: string; url: string }[] };
  zips: Record<number, { proof: Buffer; summary: Buffer }>;
  dispatches: unknown[];
  uploads: Buffer[];
  createdReleases: unknown[];
  /** Runs that appear after the dispatch, and the poll counts until they complete. */
  onDispatch?: () => void;
  progress?: () => void;
}

function producerRun(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, display_title: `QLever Installed Image Conformance ${candidate.requestId}`, path: PRODUCER_WORKFLOW_PATH,
    head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    repository: { full_name: 'example/private-producer' }, ...overrides,
  };
}

function fake(state: FakeState): Dependencies {
  const github: GitHubClient = {
    async json<T>(_token: string, method: string, path: string, body?: unknown): Promise<T | undefined> {
      state.progress?.();
      if (method === 'GET' && path === `/repos/undefinedsco/xpod/releases/tags/${tag}`) return state.release as T | undefined;
      if (method === 'POST' && path.endsWith('/dispatches')) {
        state.dispatches.push(body);
        state.onDispatch?.();
        return undefined;
      }
      if (method === 'GET' && path.includes('/actions/workflows/')) {
        return { workflow_runs: state.listed.map(id => state.runs[id]) } as T;
      }
      const artifacts = /\/actions\/runs\/(\d+)\/artifacts/.exec(path);
      if (method === 'GET' && artifacts) {
        const id = Number(artifacts[1]);
        return { artifacts: state.zips[id]
          ? [{ id, name: `private17-joint-admission-${id}`, expired: false, archive_download_url: `zip:${id}` }]
          : [] } as T;
      }
      const run = /\/actions\/runs\/(\d+)$/.exec(path);
      if (method === 'GET' && run) return state.runs[Number(run[1])] as T | undefined;
      if (method === 'POST' && path === '/repos/undefinedsco/xpod/releases') {
        state.createdReleases.push(body);
        return { id: 9, body: '', upload_url: 'https://uploads.example/assets{?name,label}', assets: [] } as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    async bytes(_token: string, url: string): Promise<Buffer> {
      if (url.startsWith('zip:')) return Buffer.from(url);
      if (url === 'asset:published') return state.release!.assets.length ? publishedBytes : Buffer.alloc(0);
      throw new Error(`unexpected bytes ${url}`);
    },
    async uploadAsset(_token: string, _url: string, _name: string, bytes: Buffer): Promise<void> {
      state.uploads.push(bytes);
    },
  };
  let clock = 0;
  return {
    github,
    unzipEntry(zip: Buffer, entry: string): Buffer {
      const entryFiles = state.zips[Number(zip.toString().slice(4))];
      return entry === 'private17-admission.json' ? entryFiles.proof : entryFiles.summary;
    },
    sleep: async (ms: number) => { clock += ms; },
    now: () => clock,
    privateToken: 'private-token',
    publicToken: 'public-token',
    pollMs: 1000,
    appearTimeoutMs: 5000,
    completeTimeoutMs: 10_000,
  };
}

let publishedBytes = Buffer.alloc(0);

function zipFor(proof: Buffer, summaryOverrides: Record<string, unknown> = {}): { proof: Buffer; summary: Buffer } {
  return { proof, summary: Buffer.from(JSON.stringify({ proofSha256: sha256(proof), sourceSha: candidate.sourceSha, ...summaryOverrides })) };
}

function baseState(): FakeState {
  return { runs: {}, listed: [], zips: {}, dispatches: [], uploads: [], createdReleases: [] };
}

describe('candidate Private17 admission without a person in the loop', () => {
  it('dispatches the producer for the exact pair, waits for it and publishes its proof', async () => {
    const state = baseState();
    const proof = proofBytes();
    state.zips[77] = zipFor(proof);
    let polls = 0;
    state.onDispatch = () => {
      state.runs[77] = producerRun(77, { status: 'in_progress', conclusion: null });
      state.listed = [77];
    };
    state.progress = () => {
      if (state.runs[77]?.status === 'in_progress' && ++polls > 4) state.runs[77] = producerRun(77);
    };

    const result = await acquireCandidateAdmission(candidate, fake(state));

    expect(result).toEqual({ digest: sha256(proof), runId: 77, reused: false });
    expect(state.dispatches).toEqual([{ ref: 'main', inputs: {
      xpod_ref: candidate.sourceSha, installed_service_image: candidate.installedImage,
      pg17_qlever_image: candidate.pgImage, request_id: candidate.requestId,
    } }]);
    expect(state.createdReleases).toEqual([expect.objectContaining({
      tag_name: tag, target_commitish: candidate.sourceSha, prerelease: true,
      body: expect.stringContaining('producer run: 77'),
    })]);
    expect(state.uploads).toEqual([proof]);
  });

  it('resumes the run a retried job already started instead of dispatching twice', async () => {
    const state = baseState();
    const proof = proofBytes();
    state.runs[5] = producerRun(5);
    state.listed = [5];
    state.zips[5] = zipFor(proof);

    const result = await acquireCandidateAdmission(candidate, fake(state));

    expect(state.dispatches).toHaveLength(0);
    expect(result.digest).toBe(sha256(proof));
  });

  it('reuses a published proof only when its producer run still yields the same bytes', async () => {
    const state = baseState();
    const proof = proofBytes();
    state.runs[8] = producerRun(8);
    state.zips[8] = zipFor(proof);
    publishedBytes = proof;
    state.release = { id: 1, body: 'transport\n\nproducer run: 8', upload_url: '', assets: [{ name: 'private17-admission.json', url: 'asset:published' }] };

    await expect(acquireCandidateAdmission(candidate, fake(state))).resolves.toEqual({ digest: sha256(proof), runId: 8, reused: true });

    publishedBytes = proofBytes({ status: 'ok', note: 'tampered' });
    await expect(acquireCandidateAdmission(candidate, fake(state))).rejects.toThrow('published-bytes-mismatch');
    expect(state.dispatches).toHaveLength(0);
  });

  it('refuses a published proof that names no producer run', async () => {
    const state = baseState();
    state.release = { id: 1, body: 'Sanitized exact-pair native admission transport. Not RC acceptance.', upload_url: '', assets: [] };

    await expect(acquireCandidateAdmission(candidate, fake(state))).rejects.toThrow('release-without-provenance');
  });

  it.each([
    ['another workflow file', { path: '.github/workflows/other.yml' }, 'unexpected-producer-run'],
    ['a non-main branch', { head_branch: 'feature' }, 'unexpected-producer-run'],
    ['another repository', { repository: { full_name: 'someone/private-producer' } }, 'unexpected-producer-run'],
    ['a failed producer', { conclusion: 'failure' }, 'producer-run-failed'],
  ])('rejects a proof from %s', async (_label, overrides, errorClass) => {
    const state = baseState();
    state.runs[3] = producerRun(3, overrides);
    state.listed = [3];
    state.zips[3] = zipFor(proofBytes());

    await expect(acquireCandidateAdmission(candidate, fake(state))).rejects.toThrow(errorClass);
    expect(state.createdReleases).toHaveLength(0);
  });

  it.each([
    ['another source', proofBytes({ sourceSha: 'e'.repeat(40) }), {}, 'pair-mismatch'],
    ['another service image', proofBytes({ serviceImage: `ghcr.io/undefinedsco/xpod@sha256:${'f'.repeat(64)}` }), {}, 'pair-mismatch'],
    ['a summary of other bytes', proofBytes(), { proofSha256: '0'.repeat(64) }, 'summary-mismatch'],
  ])('rejects a proof for %s', async (_label, proof, summary, errorClass) => {
    const state = baseState();
    state.runs[4] = producerRun(4);
    state.listed = [4];
    state.zips[4] = zipFor(proof as Buffer, summary as Record<string, unknown>);

    await expect(acquireCandidateAdmission(candidate, fake(state))).rejects.toThrow(errorClass);
    expect(state.uploads).toHaveLength(0);
  });

  it('fails closed when the dispatched run never appears or never finishes', async () => {
    const missing = baseState();
    await expect(acquireCandidateAdmission(candidate, fake(missing))).rejects.toThrow('producer-run-not-found');

    const stuck = baseState();
    stuck.runs[6] = producerRun(6, { status: 'queued', conclusion: null });
    stuck.listed = [6];
    await expect(acquireCandidateAdmission(candidate, fake(stuck))).rejects.toThrow('producer-run-timeout');
  });

  it('rejects malformed candidate coordinates before any request', async () => {
    const state = baseState();
    await expect(acquireCandidateAdmission({ ...candidate, requestId: 'bad id' }, fake(state))).rejects.toBeInstanceOf(StepError);
    await expect(acquireCandidateAdmission({ ...candidate, pgImage: 'postgres:17' }, fake(state))).rejects.toThrow('invalid-pg-image');
    expect(state.dispatches).toHaveLength(0);
  });

  it('extracts entries from a real artifact archive', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'private17-zip-'));
    try {
      writeFileSync(path.join(dir, 'private17-admission.json'), '{"status":"ok"}');
      writeFileSync(path.join(dir, 'proof-summary.json'), '{"proofSha256":"x"}');
      execFileSync('zip', ['-q', 'artifact.zip', 'private17-admission.json', 'proof-summary.json'], { cwd: dir });
      const zip = readFileSync(path.join(dir, 'artifact.zip'));
      expect(unzipEntry(zip, 'private17-admission.json').toString()).toBe('{"status":"ok"}');
      expect(unzipEntry(zip, 'proof-summary.json').toString()).toBe('{"proofSha256":"x"}');
      expect(() => unzipEntry(zip, 'missing.json')).toThrow('proof-entry-missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
