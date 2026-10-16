import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { acquireIndependentProductInput, acquireLegacyRootSupply, verifyAcquiredMetadata, type ArtifactAcquisitionInput } from '../../scripts/acquire-independent-product-input';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(entries = [{ name: 'products/api.tgz', body: 'tiny-original', mode: 0o100644 }]) {
  mkdirSync('.test-data/artifact-acquisition', { recursive: true });
  const root = mkdtempSync(path.resolve('.test-data/artifact-acquisition/case-')); roots.push(root);
  const zip = path.join(root, 'fixture.zip');
  const made = spawnSync('python3', ['-c', `import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:\n for row in json.loads(sys.argv[2]):\n  i=zipfile.ZipInfo(row['name']);i.create_system=3;i.external_attr=row['mode']<<16;i.compress_type=zipfile.ZIP_DEFLATED;z.writestr(i,row['body'])`, zip, JSON.stringify(entries)], { encoding: 'utf8' });
  if (made.status !== 0) throw Error(made.stderr);
  const bytes = readFileSync(zip), sha256 = createHash('sha256').update(bytes).digest('hex');
  const input: ArtifactAcquisitionInput = { schemaVersion: 1, sourceSha: 'a'.repeat(40), runHeadSha: 'a'.repeat(40), runId: 42, runAttempt: 2, artifactId: 91, artifactSha256: sha256 };
  const run: any = { id: 42, run_attempt: 2, status: 'completed', conclusion: 'success', repository: { full_name: 'undefinedsco/xpod' },
    head_repository: { full_name: 'undefinedsco/xpod' }, head_sha: input.runHeadSha, event: 'push', workflow_id: 7,
    path: '.github/workflows/cli-package.yml', run_started_at: '2026-10-15T00:00:00Z', updated_at: '2026-10-15T00:02:00Z' };
  const workflow: any = { id: 7, path: run.path };
  const artifact: any = { id: 91, name: `xpod-cli-Linux-${input.sourceSha}`, expired: false,
    workflow_run: { id: 42, head_sha: input.runHeadSha }, digest: 'sha256:' + sha256, size_in_bytes: bytes.length, created_at: '2026-10-15T00:01:00Z' };
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  let downloaded = bytes;
  let redirect = false;
  let location = 'https://signed.example.invalid/zip';
  const transport = (async (url: string | URL | Request, options?: RequestInit) => {
    const address = String(url); requests.push({ url: address, options });
    if (address.endsWith('/attempts/2')) return new Response(JSON.stringify(run, null, 3) + ' \n');
    if (address.endsWith('/workflows/7')) return Response.json(workflow);
    if (address.endsWith('/artifacts/91')) return Response.json(artifact);
    if (address.endsWith('/artifacts/91/zip')) return redirect ? new Response(null, { status: 302, headers: { location } }) : new Response(downloaded);
    if (address === 'https://signed.example.invalid/zip') return new Response(downloaded);
    throw Error('unexpected endpoint ' + address);
  }) as typeof fetch;
  return { root, input, run, workflow, artifact, requests, transport, bytes,
    output: path.join(root, 'acquired'), setDownload: (value: Buffer) => { downloaded = value; }, redirect: (value = location) => { redirect = true; location = value; } };
}
test('acquires exact ZIP and inventory while keeping actual checkout/product qualification blocked', async () => {
  const f = fixture();
  const result = await acquireIndependentProductInput(f.input, f.output, { fetch: f.transport });
  expect(readFileSync(path.join(f.output, 'artifact.zip')).equals(f.bytes)).toBe(true);
  expect(result.inventory.members[0].path).toBe('products/api.tgz');
  expect(result.inventory.extracted).toBe(false); expect(existsSync(path.join(f.output, 'products'))).toBe(false);
  expect(result.actualCheckoutVerified).toBe(false); expect(result.releaseQualified).toBe(false);
  expect(result.candidatePlanGenerated).toBe(false); expect(result.status).toBe('blocked');
  expect(result.materialRole).toBe('test-materials'); expect(result.blockers).toContain('cli-consumer-test-archive-not-publishable');
  expect(JSON.parse(readFileSync(path.join(f.output, 'metadata.json'), 'utf8')).run.run_attempt).toBe(2);
});
test('AFS product archive role is distinct from native inputs and mounted evidence', async () => {
  const f = fixture(); f.workflow.path = f.run.path = '.github/workflows/agentfs-module-mounted-acceptance.yml';
  f.artifact.name = `afs-module-products-linux-x64-${f.input.sourceSha}-42-2`;
  const result = await acquireIndependentProductInput(f.input, f.output, { fetch: f.transport });
  expect(result.materialRole).toBe('module-product-materials'); expect(result.releaseQualified).toBe(false);
  const evidence = fixture(); evidence.workflow.path = evidence.run.path = f.run.path;
  evidence.artifact.name = `afs-module-mounted-linux-x64-${evidence.input.sourceSha}-42-2`;
  await expect(acquireIndependentProductInput(evidence.input, evidence.output, { fetch: evidence.transport })).rejects.toThrow();
});
test('rejects destination and parent symlinks before making network requests', async () => {
  const f = fixture(); const outside = path.join(f.root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, path.join(f.root, 'link'), 'dir');
  await expect(acquireIndependentProductInput(f.input, path.join(f.root, 'link/new'), { fetch: f.transport })).rejects.toThrow('without links');
  symlinkSync(path.join(f.root, 'missing'), f.output);
  await expect(acquireIndependentProductInput(f.input, f.output, { fetch: f.transport })).rejects.toThrow('already exists');
  expect(f.requests).toHaveLength(0);
});
test('PR merge checkout may differ from run head without asserting checkout admission', async () => {
  const f = fixture(); f.run.event = 'pull_request'; f.input.sourceSha = 'b'.repeat(40); f.artifact.name = `xpod-cli-Linux-${f.input.sourceSha}`;
  const result = await acquireIndependentProductInput(f.input, f.output, { fetch: f.transport });
  expect(result.expectedSourceSha).not.toBe(result.runHeadSha); expect(result.actualCheckoutVerified).toBe(false);
});
test('preserves response original bytes, hashes them and rejects tampering or a forged projection', async () => {
  const f = fixture();
  const result = await acquireIndependentProductInput(f.input, f.output, { fetch: f.transport });
  const binding = result.metadata.originals.run;
  const original = path.join(f.output, binding.path);
  const raw = readFileSync(original);
  expect(raw.toString()).toBe(JSON.stringify(f.run, null, 3) + ' \n');
  expect(binding.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
  expect(binding.bytes).toBe(raw.length); expect(statSync(original).mode & 0o222).toBe(0);
  expect(() => verifyAcquiredMetadata(f.output, result.metadata)).not.toThrow();
  chmodSync(original, 0o600); writeFileSync(original, 'changed');
  expect(() => verifyAcquiredMetadata(f.output, result.metadata)).toThrow('hash mismatch');
  writeFileSync(original, raw);
  const projected = path.join(f.output, 'metadata.json'); chmodSync(projected, 0o600);
  const forged = Buffer.from(JSON.stringify({ run: { ...f.run, conclusion: 'failure' }, workflow: f.workflow, artifact: f.artifact }));
  writeFileSync(projected, forged);
  expect(() => verifyAcquiredMetadata(f.output, result.metadata)).toThrow('hash mismatch');
  const rehashed = { ...result.metadata, projection: { ...result.metadata.projection, bytes: forged.length, sha256: createHash('sha256').update(forged).digest('hex') } };
  expect(() => verifyAcquiredMetadata(f.output, rehashed)).toThrow('differs from originals');
});
for (const change of ['fork', 'failed', 'attempt', 'workflow', 'artifact-run', 'expired', 'digest', 'name', 'time', 'non-pr-source']) {
  test(`rejects untrusted metadata: ${change}`, async () => {
    const f = fixture();
    if (change === 'fork') f.run.head_repository.full_name = 'other/xpod';
    if (change === 'failed') f.run.conclusion = 'failure';
    if (change === 'attempt') f.run.run_attempt = 3;
    if (change === 'workflow') f.workflow.path = '.github/workflows/api-module-inputs.yml';
    if (change === 'artifact-run') f.artifact.workflow_run.id = 43;
    if (change === 'expired') f.artifact.expired = true;
    if (change === 'digest') f.artifact.digest = 'sha256:' + '0'.repeat(64);
    if (change === 'name') f.artifact.name = 'some-native-inputs';
    if (change === 'time') f.artifact.created_at = '2026-10-14T00:00:00Z';
    if (change === 'non-pr-source') f.input.sourceSha = 'b'.repeat(40);
    await expect(acquireIndependentProductInput(f.input, f.output, { fetch: f.transport })).rejects.toThrow();
    expect(existsSync(f.output)).toBe(false);
    expect(f.requests.some(row => row.url.endsWith('/zip'))).toBe(false);
  });
}
test('redirected object download receives no GitHub authorization token', async () => {
  const f = fixture(); f.redirect();
  await acquireIndependentProductInput(f.input, f.output, { fetch: f.transport, token: 'fixture-private-token' });
  expect(f.requests.at(-1)!.options?.headers).toBeUndefined();
  expect(readFileSync(path.join(f.output, 'metadata.json'), 'utf8')).not.toContain('fixture-private-token');
});
test('rejects insecure redirects without contacting the redirected host', async () => {
  const f = fixture(); f.redirect('http://other.example.invalid/file');
  await expect(acquireIndependentProductInput(f.input, f.output, { fetch: f.transport, token: 'secret' })).rejects.toThrow('redirect');
  expect(f.requests.some(row => row.url.startsWith('http:'))).toBe(false);
});
test('corrupt member data is rejected and the owned download root is cleaned', async () => {
  const f = fixture();
  const bytes = Buffer.from(f.bytes);
  const payloadOffset = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
  bytes[payloadOffset] ^= 0xff;
  f.input.artifactSha256 = createHash('sha256').update(bytes).digest('hex');
  f.artifact.digest = 'sha256:' + f.input.artifactSha256; f.setDownload(bytes);
  const ownedRoots = () => readdirSync(os.tmpdir()).filter(name => name.startsWith('xpod-artifact-acquisition-')).sort();
  const before = ownedRoots();
  await expect(acquireIndependentProductInput(f.input, f.output, { fetch: f.transport })).rejects.toThrow('ZIP inspection');
  expect(existsSync(f.output)).toBe(false); expect(ownedRoots()).toEqual(before);
});
test('concurrent destination creation is preserved rather than overwritten or cleaned', async () => {
  const f = fixture();
  const transport = (async (...args: Parameters<typeof fetch>) => {
    if (String(args[0]).endsWith('/zip')) { mkdirSync(f.output); writeFileSync(path.join(f.output, 'other-owner'), 'keep'); }
    return f.transport(...args);
  }) as typeof fetch;
  await expect(acquireIndependentProductInput(f.input, f.output, { fetch: transport })).rejects.toThrow();
  expect(readFileSync(path.join(f.output, 'other-owner'), 'utf8')).toBe('keep');
});
test('rejects changed downloaded bytes and preserves an existing destination', async () => {
  const f = fixture(); f.setDownload(Buffer.from('changed'));
  await expect(acquireIndependentProductInput(f.input, f.output, { fetch: f.transport })).rejects.toThrow('digest/size');
  expect(existsSync(f.output)).toBe(false);
  const good = fixture(); mkdirSync(good.output); writeFileSync(path.join(good.output, 'original'), 'keep');
  await expect(acquireIndependentProductInput(good.input, good.output, { fetch: good.transport })).rejects.toThrow();
  expect(readFileSync(path.join(good.output, 'original'), 'utf8')).toBe('keep');
});
test('enforces actual streamed bytes even without a Content-Length', async () => {
  const f = fixture(); f.artifact.size_in_bytes = 1;
  await expect(acquireIndependentProductInput(f.input, f.output, { fetch: f.transport, limits: { packedBytes: 8 } })).rejects.toThrow('actual size');
  expect(existsSync(f.output)).toBe(false);
});
for (const entries of [
  [{ name: '../escape', body: 'x', mode: 0o100644 }],
  [{ name: 'link', body: '../outside', mode: 0o120777 }],
  [{ name: 'dup', body: 'a', mode: 0o100644 }, { name: 'dup', body: 'b', mode: 0o100644 }],
  [{ name: 'parent', body: 'a', mode: 0o100644 }, { name: 'parent/child', body: 'b', mode: 0o100644 }],
]) test('rejects unsafe ZIP without extracting or retaining an output', async () => {
  const f = fixture(entries);
  await expect(acquireIndependentProductInput(f.input, f.output, { fetch: f.transport })).rejects.toThrow('ZIP inspection');
  expect(existsSync(f.output)).toBe(false);
});
test('bounds expanded data and member count before member projection', async () => {
  const f = fixture([{ name: 'large', body: 'x'.repeat(1000), mode: 0o100644 }]);
  await expect(acquireIndependentProductInput(f.input, f.output, { fetch: f.transport, limits: { expandedBytes: 8 } })).rejects.toThrow('ZIP inspection');
  const many = fixture([{ name: 'one', body: 'a', mode: 0o100644 }, { name: 'two', body: 'b', mode: 0o100644 }]);
  await expect(acquireIndependentProductInput(many.input, many.output, { fetch: many.transport, limits: { members: 1 } })).rejects.toThrow('ZIP inspection');
});
test('CSS registration accepts only exact successful product runs, never in-progress same-run or diagnostics', async () => {
 for(const mode of ['success','ongoing','failed','diagnostics','wrong-attempt','native-workflow']) {
  const f=fixture();f.workflow.path=f.run.path='.github/workflows/css-module-product.yml';
  f.artifact.name=`css-module-products-darwin-arm64-${f.input.sourceSha}-42-2`;
  if(mode==='ongoing')f.run.status='in_progress';
  if(mode==='failed')f.run.conclusion='failure';
  if(mode==='diagnostics')f.artifact.name=f.artifact.name.replace('products','diagnostics');
  if(mode==='wrong-attempt')f.artifact.name=f.artifact.name.replace('-42-2','-42-1');
  if(mode==='native-workflow')f.run.path=f.workflow.path='.github/workflows/build-qlever-macos-runtime.yml';
  if(mode==='success') {
   const result=await acquireIndependentProductInput(f.input,f.output,{fetch:f.transport});
   expect(result.materialRole).toBe('controlled-preview-materials');expect(result.releaseQualified).toBe(false);
  } else {await expect(acquireIndependentProductInput(f.input,f.output,{fetch:f.transport})).rejects.toThrow();expect(existsSync(f.output)).toBe(false);}
 }
});

// Same-run legacy policy has its own entry; independent producer trust is unchanged.
test('same-workflow legacy supply requires successful producer job and exact runtime/artifact custody', async () => {
  const saved = Object.fromEntries(['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'].map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'undefinedsco/xpod', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2' });
    for (const negative of ['none', 'job-failed', 'job-open', 'expired', 'wrong-source', 'old-attempt', 'digest', 'runtime']) {
      const f = fixture([{ name: 'supply-index.original.json', body: '{}', mode: 0o100644 }]);
      f.run.status = 'in_progress'; f.run.conclusion = null; f.run.updated_at = f.run.run_started_at; f.run.path = '.github/workflows/legacy-root-compat.yml'; f.workflow.path = f.run.path;
      f.artifact.name = `legacy-root-normal-afs-${f.input.sourceSha}-42-2`;
      const jobs = { total_count: 1, jobs: [{ name: 'legacy-root-normal-afs', status: 'completed', conclusion: 'success', run_id: 42, run_attempt: 2, head_sha: f.input.runHeadSha, started_at: '2026-10-15T00:00:00Z', completed_at: '2026-10-15T00:02:00Z' }] };
      if (negative === 'job-failed') jobs.jobs[0].conclusion = 'failure';
      if (negative === 'job-open') jobs.jobs[0].status = 'in_progress';
      if (negative === 'expired') f.artifact.expired = true;
      if (negative === 'wrong-source') f.input.sourceSha = 'b'.repeat(40);
      if (negative === 'old-attempt') jobs.jobs[0].run_attempt = 1;
      if (negative === 'digest') f.artifact.digest = 'sha256:' + 'b'.repeat(64);
      if (negative === 'runtime') process.env.GITHUB_RUN_ATTEMPT = '1';
      const transport = (async (url: any, options: any) => String(url).endsWith('/jobs?per_page=100') ? Response.json(jobs) : f.transport(url, options)) as typeof fetch;
      if (negative === 'none') {
        const result = await acquireLegacyRootSupply(f.input, f.output, { fetch: transport });
        expect(result.kind).toBe('legacy-root-same-run-acquisition');
        expect(readFileSync(path.join(f.output, 'metadata/jobs.original.json')).length > 0).toBe(true);
        expect(result.inventory.members.length).toBe(1);
        await expect(acquireIndependentProductInput(f.input, path.join(f.root, 'independent'), { fetch: transport })).rejects.toThrow();
      } else await expect(acquireLegacyRootSupply(f.input, f.output, { fetch: transport })).rejects.toThrow();
      process.env.GITHUB_RUN_ATTEMPT = '2';
    }
  } finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
test('actual queued GitHub attempt admits only its already successful exact normal producer', async () => {
  const observed = JSON.parse(readFileSync(path.resolve('tests/fixtures/legacy-root-queued-run.json'), 'utf8'));
  expect(observed.run.status).toBe('queued');
  const saved = Object.fromEntries(['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'].map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'undefinedsco/xpod', GITHUB_RUN_ID: String(observed.run.id), GITHUB_RUN_ATTEMPT: String(observed.run.run_attempt) });
    for (const negative of ['none', 'producer-queued', 'producer-failed', 'wrong-job', 'wrong-attempt']) {
      // Original run and terminal producer fields; tiny synthetic ZIP/metadata transport.
      const f = fixture([{ name: 'supply-index.original.json', body: '{}', mode: 0o100644 }]);
      const run = structuredClone(observed.run), job = structuredClone(observed.producerJob);
      Object.assign(f.input, { sourceSha: observed.actualSourceSha, runHeadSha: run.head_sha, runId: run.id, runAttempt: run.run_attempt });
      Object.assign(f.artifact, { name: `legacy-root-normal-afs-${f.input.sourceSha}-${run.id}-${run.run_attempt}`, workflow_run: { id: run.id, head_sha: run.head_sha }, created_at: job.started_at });
      if (negative === 'producer-queued') { job.status = 'queued'; job.conclusion = null; }
      if (negative === 'producer-failed') job.conclusion = 'failure';
      if (negative === 'wrong-job') job.name = 'another-normal-afs';
      if (negative === 'wrong-attempt') job.run_attempt++;
      const transport = (async (url: any) => {
        const address = String(url);
        if (address.endsWith(`/attempts/${run.run_attempt}`)) return Response.json(run);
        if (address.endsWith(`/workflows/${run.workflow_id}`)) return Response.json({ id: run.workflow_id, path: run.path });
        if (address.endsWith('/jobs?per_page=100')) return Response.json({ total_count: 1, jobs: [job] });
        if (address.endsWith('/artifacts/91')) return Response.json(f.artifact);
        if (address.endsWith('/artifacts/91/zip')) return new Response(f.bytes);
        throw new Error('Unexpected endpoint');
      }) as typeof fetch;
      if (negative === 'none') {
        const result = await acquireLegacyRootSupply(f.input, f.output, { fetch: transport });
        expect(result.kind).toBe('legacy-root-same-run-acquisition');
        await expect(acquireIndependentProductInput(f.input, path.join(f.root, 'independent'), { fetch: transport })).rejects.toThrow();
      } else await expect(acquireLegacyRootSupply(f.input, f.output, { fetch: transport })).rejects.toThrow();
    }
  } finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
test('failed actual ZIP inspection retains original bounded diagnostics without the transport token', async () => {
  const f = fixture([{ name: '../unsafe', body: 'tiny', mode: 0o100644 }]);
  const diagnostics = path.join(f.root, 'diagnostics');
  await expect(acquireIndependentProductInput(f.input, f.output, { fetch: f.transport, token: 'test-secret-canary', diagnostics })).rejects.toThrow('ZIP inspection failed');
  expect(existsSync(f.output)).toBe(false);
  const directories = readdirSync(diagnostics); expect(directories.length).toBe(1);
  const directory = path.join(diagnostics, directories[0]);
  const receiptBytes = readFileSync(path.join(directory, 'command.original.json'));
  const receipt = JSON.parse(receiptBytes.toString()); expect(receipt.status === 0).toBe(false);
  for (const channel of ['stdout', 'stderr']) {
    const row = receipt[channel], bytes = readFileSync(path.join(directory, row.path));
    expect(bytes.length).toBe(row.bytes); expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256);
    expect(bytes.includes(Buffer.from('test-secret-canary'))).toBe(false);
  }
  expect(receiptBytes.includes(Buffer.from('test-secret-canary'))).toBe(false);
});
test('actual acquisition allocates beside checked output even when OS temp is elsewhere', async () => {
  const f = fixture(), operatingSystem = createRequire(import.meta.url)('node:os'), previous = Object.getOwnPropertyDescriptor(operatingSystem, 'tmpdir')!, foreign = path.join(f.root, 'foreign-os-temp'); mkdirSync(foreign);
  let observed = false;
  const transport = (async (url: any, options: any) => {
    if (String(url).endsWith('/artifacts/91/zip')) {
      const temporary = readdirSync(f.root).filter(name => name.startsWith('xpod-artifact-acquisition-'));
      expect(temporary.length).toBe(1); expect(readdirSync(foreign).length).toBe(0); expect(existsSync(f.output)).toBe(false); observed = true;
    }
    return f.transport(url, options);
  }) as typeof fetch;
  try {
    Object.defineProperty(operatingSystem, 'tmpdir', { value: () => foreign, configurable: true });
    await acquireIndependentProductInput(f.input, f.output, { fetch: transport });
    expect(observed).toBe(true); expect(readFileSync(path.join(f.output, 'artifact.zip')).equals(f.bytes)).toBe(true);
    expect(readdirSync(f.root).some(name => name.startsWith('xpod-artifact-acquisition-'))).toBe(false);
  } finally { Object.defineProperty(operatingSystem, 'tmpdir', previous); }
});

test('parent identity swap during download preserves replacement output and primary plus cleanup errors', async () => {
  const f = fixture(), moved = f.root + '.original'; let swapped = false;
  const transport = (async (url: any, options: any) => {
    if (String(url).endsWith('/artifacts/91/zip')) {
      renameSync(f.root, moved); mkdirSync(f.root); mkdirSync(f.output); writeFileSync(path.join(f.output, 'sentinel'), 'another owner'); swapped = true;
    }
    return f.transport(url, options);
  }) as typeof fetch;
  try {
    let failure: any;
    try { await acquireIndependentProductInput(f.input, f.output, { fetch: transport }); } catch (error) { failure = error; }
    expect(swapped).toBe(true); expect(failure instanceof AggregateError).toBe(true); expect(failure.errors.length).toBe(2);
    expect(failure.cause).toBe(failure.errors[0]); expect(failure.errors[1].message.includes('parent identity changed')).toBe(true);
    expect(readFileSync(path.join(f.output, 'sentinel'), 'utf8')).toBe('another owner');
    expect(readdirSync(moved).some(name => name.startsWith('xpod-artifact-acquisition-'))).toBe(true);
  } finally {
    if (swapped) { rmSync(f.root, { recursive: true, force: true }); renameSync(moved, f.root); }
  }
});
for (const replacement of ['directory', 'symlink', 'partial-owned']) test('actual publication failure retains '+replacement+' output without path-based deletion', () => {
  const f = fixture(), resultFile = path.join(f.root, 'race-result.json');
  const data = { input: f.input, run: f.run, workflow: f.workflow, artifact: f.artifact, bytes: f.bytes.toString('base64'), output: f.output, resultFile, replacement };
  const code = `import {mock} from 'bun:test';import fs from 'node:fs';import path from 'node:path';
const f=${JSON.stringify(data)},rename=fs.renameSync;const primary=new Error('actual injected publication failure');let observed=false;
mock.module('node:fs',()=>({...fs,renameSync:(source,target)=>{
 const trigger=f.replacement==='partial-owned'?String(source).endsWith('/run.json'):String(source).endsWith('artifact.zip');
 if(trigger&&String(target).startsWith(f.output+path.sep)){
  observed=true;
  if(f.replacement!=='partial-owned'){
   rename(f.output,f.output+'.original');
   if(f.replacement==='directory'){fs.mkdirSync(f.output);fs.writeFileSync(path.join(f.output,'sentinel'),'another owner');}
   else{const other=f.output+'.other';fs.mkdirSync(other);fs.writeFileSync(path.join(other,'sentinel'),'another owner');fs.symlinkSync(other,f.output,'dir');}
  }
  throw primary;
 }
 return rename(source,target);
}}));
const transport=async url=>{const a=String(url);if(a.endsWith('/attempts/2'))return Response.json(f.run);if(a.endsWith('/workflows/7'))return Response.json(f.workflow);if(a.endsWith('/artifacts/91'))return Response.json(f.artifact);if(a.endsWith('/artifacts/91/zip'))return new Response(Buffer.from(f.bytes,'base64'));throw Error('unexpected endpoint')};
let failure;try{const {acquireIndependentProductInput}=await import(${JSON.stringify(path.resolve('scripts/acquire-independent-product-input.ts'))});await acquireIndependentProductInput(f.input,f.output,{fetch:transport});}catch(error){failure=error;}
fs.writeFileSync(f.resultFile,JSON.stringify({observed,primarySame:failure===primary,aggregate:failure instanceof AggregateError,firstPrimary:failure?.errors?.[0]===primary,causePrimary:failure?.cause===primary,secondary:String(failure?.errors?.[1]),receiptExists:fs.existsSync(path.join(f.output,'receipt.json'))}));`;
  const child = spawnSync('bun', ['-e', code], { encoding: 'utf8', timeout: 10000 }); expect(child.status).toBe(0);
  const observed = JSON.parse(readFileSync(resultFile, 'utf8')); expect(observed.observed).toBe(true); expect(observed.receiptExists).toBe(false);
  if (replacement === 'partial-owned') {
    expect(observed.primarySame).toBe(true); expect(observed.aggregate).toBe(false); expect(readFileSync(path.join(f.output, 'artifact.zip')).equals(f.bytes)).toBe(true);
  } else {
    expect(observed.aggregate).toBe(true); expect(observed.firstPrimary).toBe(true); expect(observed.causePrimary).toBe(true); expect(observed.secondary.includes('ownership changed')).toBe(true);
    expect(existsSync(f.output + '.original')).toBe(true); expect(readFileSync(path.join(f.output, 'sentinel'), 'utf8')).toBe('another owner');
    expect(statSync(f.output + '.original').isDirectory()).toBe(true);
  }
});
