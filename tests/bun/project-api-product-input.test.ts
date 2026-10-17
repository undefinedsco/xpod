import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireIndependentProductInput, API_PRODUCT_WORKFLOW } from '../../scripts/acquire-independent-product-input';
import { projectApiProductInput, type ApiProductProjectionInput } from '../../scripts/project-api-product-input';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture(alter: (producer: any) => void = () => {}, packAlter: (packed: any) => void = () => {}) {
  mkdirSync('.test-data/api-product-projection', { recursive: true });
  const root = mkdtempSync(path.resolve('.test-data/api-product-projection/case-')); roots.push(root);
  const source = 'a'.repeat(40), head = 'b'.repeat(40);
  const made = spawnSync('python3', ['-c', "import tarfile,io,sys\nwith tarfile.open(fileobj=sys.stdout.buffer,mode='w|gz') as t:\n b=b'{}';i=tarfile.TarInfo('package/package.json');i.size=len(b);t.addfile(i,io.BytesIO(b))"]);
  if (made.status !== 0) throw Error('tiny tar fixture');
  const archive = made.stdout;
  const packed: any = { archive: '/original/build/product.tgz', sha256: hash(archive), integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64'), members: 1, publishReady: false };
  packAlter(packed);
  const raw = Buffer.from('$ bun scripts/pack.ts stage /original/build/product.tgz\n' + JSON.stringify(packed) + '\n');
  const producer: any = { schemaVersion: 1, kind: 'api-module-product-production', status: 'controlled-preview-materials',
    context: { repository: 'undefinedsco/xpod', workflowPath: API_PRODUCT_WORKFLOW,
      workflowRef: `undefinedsco/xpod/${API_PRODUCT_WORKFLOW}@refs/pull/62/merge`, workflowSha: source,
      runId: 42, runAttempt: 2, event: 'pull_request', runHeadSha: head, githubSha: source,
      actualCheckoutSha: source, target: 'darwin-arm64', version: '0.0.0-preview.1' },
    sourceBefore: { sha: source, status: '' }, sourceAfter: { sha: source, status: '' },
    archive: { path: 'product.tgz', bytes: archive.length, sha256: hash(archive), integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64'), members: 1 },
    packRaw: { path: 'evidence/pack.raw.log', bytes: raw.length, sha256: hash(raw) }, phases: [],
    published: false, releaseQualified: false, consumerValidated: false, legalClearance: false, nativeAdmission: false,
    blockers: ['preview-not-publishable'] };
  alter(producer);
  const producerBytes = Buffer.from(JSON.stringify(producer, null, 2) + '\n');
  const zip = path.join(root, 'original.zip');
  const files = [{ path: 'producer.receipt.json', body: producerBytes.toString('base64') }, { path: 'product.tgz', body: archive.toString('base64') },
    { path: 'evidence/pack.raw.log', body: raw.toString('base64') }, { path: 'decoy/product.tgz', body: Buffer.from('not-selected').toString('base64') }];
  const zipped = spawnSync('python3', ['-c', "import json,zipfile,base64,sys\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:\n for r in json.loads(sys.argv[2]):z.writestr(r['path'],base64.b64decode(r['body']))", zip, JSON.stringify(files)]);
  if (zipped.status !== 0) throw Error('tiny ZIP fixture');
  const bytes = readFileSync(zip), digest = hash(bytes);
  const run = { id: 42, run_attempt: 2, head_sha: head, repository: { full_name: 'undefinedsco/xpod' }, head_repository: { full_name: 'undefinedsco/xpod' },
    status: 'completed', conclusion: 'success', event: 'pull_request', workflow_id: 7, path: API_PRODUCT_WORKFLOW,
    run_started_at: '2026-10-15T00:00:00Z', updated_at: '2026-10-15T00:02:00Z' };
  const artifact = { id: 91, name: `api-module-products-darwin-arm64-${source}-42-2`, size_in_bytes: bytes.length,
    digest: 'sha256:' + digest, expired: false, workflow_run: { id: 42, head_sha: head }, created_at: '2026-10-15T00:01:00Z' };
  const transport = (async (url: any) => {
    const address = String(url);
    if (address.endsWith('/attempts/2')) return Response.json(run);
    if (address.endsWith('/workflows/7')) return Response.json({ id: 7, path: API_PRODUCT_WORKFLOW });
    if (address.endsWith('/artifacts/91')) return Response.json(artifact);
    if (address.endsWith('/zip')) return new Response(bytes);
    throw Error('unexpected endpoint');
  }) as typeof fetch;
  const acquired = path.join(root, 'acquired');
  await acquireIndependentProductInput({ schemaVersion: 1, sourceSha: source, runHeadSha: head, runId: 42, runAttempt: 2, artifactId: 91, artifactSha256: digest }, acquired, { fetch: transport });
  const input: ApiProductProjectionInput = { schemaVersion: 1, acquisitionRoot: acquired,
    custodyReceiptSha256: hash(readFileSync(path.join(acquired, 'receipt.json'))),
    members: { producer: 'producer.receipt.json', archive: 'product.tgz', packRaw: 'evidence/pack.raw.log' } };
  return { root, acquired, input, archive, raw, producerBytes, output: path.join(root, 'projected') };
}
test('projects exact original members, ignores same basename decoy and emits blocked collector input', async () => {
  const f = await fixture(); const result = await projectApiProductInput(f.input, f.output);
  expect(readFileSync(path.join(f.output, 'product.tgz')).equals(f.archive)).toBe(true);
  expect(readFileSync(path.join(f.output, 'pack.raw.log')).equals(f.raw)).toBe(true);
  expect(readFileSync(path.join(f.output, 'producer.receipt.json')).equals(f.producerBytes)).toBe(true);
  const input = JSON.parse(readFileSync(path.join(f.output, 'collector-input.json'), 'utf8'));
  expect(input.expectedSourceSha).toBe('a'.repeat(40)); expect(input.packReceipt.sha256).toBe(hash(f.raw));
  expect(result.runHeadSha).toBe('b'.repeat(40)); expect(result.actualCheckoutVerified).toBe(false);
  expect(result.exactAttemptAdmitted).toBe(false); expect(result.collectorExecuted).toBe(false);
  expect(result.releaseQualified).toBe(false); expect(result.producerBlockers).toEqual(['preview-not-publishable']);
  expect(result.selectedMembersProjected).toBe(3); expect(result.innerArchiveExpanded).toBe(false);
});
for (const change of ['source', 'attempt', 'event-head', 'workflow', 'dirty', 'target', 'clearance', 'archive-path', 'pack-hash']) {
  test(`rejects producer/custody mismatch: ${change}`, async () => {
    const f = await fixture(producer => {
      if (change === 'source') producer.context.actualCheckoutSha = 'c'.repeat(40);
      if (change === 'attempt') producer.context.runAttempt = 3;
      if (change === 'event-head') producer.context.runHeadSha = 'a'.repeat(40);
      if (change === 'workflow') producer.context.workflowPath = '.github/workflows/api-module-inputs.yml';
      if (change === 'dirty') producer.sourceAfter.status = ' M source.ts';
      if (change === 'target') producer.context.target = 'linux-x64';
      if (change === 'clearance') producer.legalClearance = true;
      if (change === 'archive-path') producer.archive.path = 'decoy/product.tgz';
      if (change === 'pack-hash') producer.packRaw.sha256 = '0'.repeat(64);
    });
    await expect(projectApiProductInput(f.input, f.output)).rejects.toThrow(); expect(existsSync(f.output)).toBe(false);
  });
}
test('rejects original pack result with rehashed but inconsistent SRI', async () => {
  const f = await fixture(() => {}, packed => { packed.integrity = 'sha512-' + 'A'.repeat(86) + '=='; });
  await expect(projectApiProductInput(f.input, f.output)).rejects.toThrow('pack/archive');
});
test('requires exact full paths and refuses native-input/test-material custody roles', async () => {
  const f = await fixture();
  await expect(projectApiProductInput({ ...f.input, members: { ...f.input.members, packRaw: 'pack.raw.log' as any } }, f.output)).rejects.toThrow('member contract');
  const receiptFile = path.join(f.acquired, 'receipt.json'); const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  receipt.materialRole = 'test-materials'; writeFileSync(receiptFile, JSON.stringify(receipt));
  f.input.custodyReceiptSha256 = hash(readFileSync(receiptFile));
  await expect(projectApiProductInput(f.input, f.output)).rejects.toThrow('custody required');
});
for (const change of ['missing', 'duplicate']) test(`rejects ${change} exact member in the custody inventory`, async () => {
  const f = await fixture();
  const file = path.join(f.acquired, 'receipt.json'); const receipt = JSON.parse(readFileSync(file, 'utf8'));
  const row = receipt.inventory.members.find((member: any) => member.path === 'evidence/pack.raw.log');
  if (change === 'missing') receipt.inventory.members = receipt.inventory.members.filter((member: any) => member !== row);
  else receipt.inventory.members.push(row);
  writeFileSync(file, JSON.stringify(receipt)); f.input.custodyReceiptSha256 = hash(readFileSync(file));
  await expect(projectApiProductInput(f.input, f.output)).rejects.toThrow('unique ordinary');
  expect(existsSync(f.output)).toBe(false);
});
test('rejects custody raw metadata or ZIP mutation and preserves existing destination', async () => {
  const f = await fixture(); const metadata = path.join(f.acquired, 'metadata/run.original.json'); chmodSync(metadata, 0o600); writeFileSync(metadata, '{}');
  await expect(projectApiProductInput(f.input, f.output)).rejects.toThrow('metadata original hash');
  const changed = await fixture(); writeFileSync(path.join(changed.acquired, 'artifact.zip'), 'changed');
  await expect(projectApiProductInput(changed.input, changed.output)).rejects.toThrow('ZIP');
  const good = await fixture(); mkdirSync(good.output); writeFileSync(path.join(good.output, 'original'), 'keep');
  await expect(projectApiProductInput(good.input, good.output)).rejects.toThrow('already exists');
  expect(readFileSync(path.join(good.output, 'original'), 'utf8')).toBe('keep');
});
