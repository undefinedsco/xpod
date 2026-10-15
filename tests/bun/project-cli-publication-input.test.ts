import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { acquireIndependentProductInput } from '../../scripts/acquire-independent-product-input';
import { preparePublication } from '../../scripts/prepare-cli-publication';
import { projectCliPublicationInput } from '../../scripts/project-cli-publication-input';
const { inspectTarballBuffer } = createRequire(import.meta.url)('../../scripts/workspace-package-payload.cjs');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sri = (bytes: Buffer) => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
function tar(files: Record<string, Buffer>) {
  const packed = spawnSync('python3', ['-c', "import tarfile,io,sys,json,base64\nwith tarfile.open(fileobj=sys.stdout.buffer,mode='w|gz') as t:\n for name,data in json.loads(sys.argv[1]).items():\n  b=base64.b64decode(data);i=tarfile.TarInfo('package/'+name);i.size=len(b);i.mode=420;t.addfile(i,io.BytesIO(b))", JSON.stringify(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, value.toString('base64')]))) ]);
  if (packed.status !== 0) throw Error('tiny tar'); return packed.stdout;
}
async function fixture(alter: (result: any, files: Record<string, Buffer>) => void = () => {}) {
  mkdirSync('.test-data/cli-projection', { recursive: true });
  const root = mkdtempSync(path.resolve('.test-data/cli-projection/case-')); roots.push(root);
  const json = (value: any) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const sourceCli = json({ name: '@undefineds.co/xpod-cli', version: '1.2.3', dependencies: { '@undefineds.co/xpod-client': 'workspace:*' } });
  const sourceClient = json({ name: '@undefineds.co/xpod-client', version: '4.5.6', devDependencies: { '@undefineds.co/xpod-cli': 'workspace:*' } });
  const client = tar({ 'package.json': json({ name: '@undefineds.co/xpod-client', version: '4.5.6' }), 'dist/index.mjs': Buffer.from('export {};') });
  const clientFiles = inspectTarballBuffer(client).entries.filter((row: any) => row.type === 'file').map((row: any) => ({ path: row.path, bytes: row.size, sha256: row.sha256, mode: row.mode }));
  const clientInventory = json({ schemaVersion: 1, files: clientFiles });
  const index = json({ schemaVersion: 1, producer: { name: '@undefineds.co/xpod-cli', version: '1.2.3' },
    runtimeClients: [{ name: '@undefineds.co/xpod-client', version: '4.5.6', files: clientFiles.map((row: any) => ({ ...row, path: row.path.slice(8) })), publication: { archive: 'client.tgz', inventory: 'client.inventory.json' } }],
    files: [{ path: 'client.tgz', bytes: client.length, sha256: hash(client) }, { path: 'client.inventory.json', bytes: clientInventory.length, sha256: hash(clientInventory) }] });
  const cli = tar({ 'package.json': json({ name: '@undefineds.co/xpod-cli', version: '1.2.3', dependencies: { '@undefineds.co/xpod-client': '4.5.6' }, exports: { './producer-materials': './dist/producer-materials/index.json' } }),
    'dist/producer-materials/index.json': index, 'dist/producer-materials/client.tgz': client, 'dist/producer-materials/client.inventory.json': clientInventory });
  const source = 'a'.repeat(40), head = 'b'.repeat(40);
  const context = { checkoutSha: source, eventHeadSha: head, runId: '42', runAttempt: '2', environment: 'github-actions', runnerOS: 'Linux', workingTreeDirty: false };
  const ref = (file: string, bytes: Buffer) => ({ path: file, sha256: hash(bytes) });
  const input = { schemaVersion: 1 as const, cli: { ...ref('cli.tgz', cli), integrity: sri(cli) }, client: { ...ref('client.tgz', client), integrity: sri(client) },
    sourceManifests: { cli: ref('source-manifests/cli.package.json', sourceCli), client: ref('source-manifests/client.package.json', sourceClient) } };
  const files: Record<string, Buffer> = { 'cli.tgz': cli, 'client.tgz': client, 'producer-index.json': index,
    'source-manifests/cli.package.json': sourceCli, 'source-manifests/client.package.json': sourceClient, 'input.json': json(input),
    'source-inputs.json': json({ schemaVersion: 1, context, generatedBuildManifest: { private: true }, files: [
      { path: 'packages/xpod-cli/package.json', bytes: sourceCli.length, sha256: hash(sourceCli) }, { path: 'packages/xpod-client/package.json', bytes: sourceClient.length, sha256: hash(sourceClient) }] }) };
  const build = path.join(root, 'originals'); mkdirSync(build);
  for (const [file, bytes] of Object.entries(files)) { mkdirSync(path.dirname(path.join(build, file)), { recursive: true }); writeFileSync(path.join(build, file), bytes); }
  files['preparation.json'] = json(preparePublication(input, build));
  const result: any = { schemaVersion: 1, kind: 'cli-publication-preparation-producer', status: 'prepared-not-published', context,
    products: { cli: { package: '@undefineds.co/xpod-cli', version: '1.2.3', archive: { ...input.cli, bytes: cli.length } }, client: { package: '@undefineds.co/xpod-client', version: '4.5.6', archive: { ...input.client, bytes: client.length } } },
    sourceInputs: ref('source-inputs.json', files['source-inputs.json']), producerIndex: ref('producer-index.json', index), preparation: ref('preparation.json', files['preparation.json']),
    embeddedClientIdentityVerified: true, privateConsumerArtifactsReused: false, legalQualified: false, nativeQualified: false, releaseQualified: false, published: false };
  alter(result, files);
  files['inventory.json'] = json({ schemaVersion: 1, scope: 'all artifact members except this inventory and result.json, avoiding self-reference', files: Object.entries(files).map(([file, bytes]) => ({ path: file, bytes: bytes.length, mode: 0o644, sha256: hash(bytes) })) });
  result.inventory = ref('inventory.json', files['inventory.json']); files['result.json'] = json(result);
  const zip = path.join(root, 'fixture.zip');
  const zipped = spawnSync('python3', ['-c', "import json,zipfile,base64,sys\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:\n for name,data in json.loads(sys.argv[2]).items():\n  i=zipfile.ZipInfo(name);i.create_system=3;i.external_attr=33188<<16;z.writestr(i,base64.b64decode(data))", zip, JSON.stringify(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, value.toString('base64')]))) ]);
  if (zipped.status !== 0) throw Error('tiny zip');
  const bytes = readFileSync(zip), digest = hash(bytes), workflow = '.github/workflows/cli-package.yml';
  const run = { id: 42, run_attempt: 2, head_sha: head, repository: { full_name: 'undefinedsco/xpod' }, head_repository: { full_name: 'undefinedsco/xpod' }, status: 'completed', conclusion: 'success', event: 'pull_request', workflow_id: 7, path: workflow,
    run_started_at: '2026-10-15T00:00:00Z', updated_at: '2026-10-15T00:02:00Z' };
  const artifact = { id: 91, name: `xpod-cli-publication-preparation-Linux-${source}-42-2`, size_in_bytes: bytes.length, digest: 'sha256:' + digest, expired: false, workflow_run: { id: 42, head_sha: head }, created_at: '2026-10-15T00:01:00Z' };
  const transport = (async (url: any) => { const address = String(url); if (address.endsWith('/attempts/2')) return Response.json(run); if (address.endsWith('/workflows/7')) return Response.json({ id: 7, path: workflow }); if (address.endsWith('/artifacts/91')) return Response.json(artifact); if (address.endsWith('/zip')) return new Response(bytes); throw Error('endpoint'); }) as typeof fetch;
  const acquired = path.join(root, 'acquired');
  await acquireIndependentProductInput({ schemaVersion: 1, sourceSha: source, runHeadSha: head, runId: 42, runAttempt: 2, artifactId: 91, artifactSha256: digest }, acquired, { fetch: transport });
  return { root, acquired, files, output: path.join(root, 'projected'), input: { schemaVersion: 1 as const, acquisitionRoot: acquired, custodyReceiptSha256: hash(readFileSync(path.join(acquired, 'receipt.json'))) } };
}
test('projects normal publication originals and reuses their actual preparation verifier', async () => {
  const f = await fixture(); const result = await projectCliPublicationInput(f.input, f.output);
  for (const file of ['cli.tgz', 'client.tgz', 'result.json', 'preparation.json']) expect(readFileSync(path.join(f.output, file)).equals(f.files[file])).toBe(true);
  expect(result.sourceSha).toBe('a'.repeat(40)); expect(result.eventHeadSha).toBe('b'.repeat(40)); expect(result.runId).toBe('42');
  expect(result.releaseQualified).toBe(false); expect(result.actualCheckoutVerified).toBe(false);
});
for (const change of ['numeric-id', 'leading-zero', 'checkout', 'head', 'dirty', 'private-reuse', 'qualification', 'archive-hash', 'source-ref']) test(`rejects publication binding mismatch: ${change}`, async () => {
  const f = await fixture(result => {
    if (change === 'numeric-id') result.context.runId = 42;
    if (change === 'leading-zero') result.context.runId = '042';
    if (change === 'checkout') result.context.checkoutSha = 'c'.repeat(40);
    if (change === 'head') result.context.eventHeadSha = 'a'.repeat(40);
    if (change === 'dirty') result.context.workingTreeDirty = true;
    if (change === 'private-reuse') result.privateConsumerArtifactsReused = true;
    if (change === 'qualification') result.legalQualified = true;
    if (change === 'archive-hash') result.products.cli.archive.sha256 = '0'.repeat(64);
    if (change === 'source-ref') result.sourceInputs.sha256 = '0'.repeat(64);
  });
  await expect(projectCliPublicationInput(f.input, f.output)).rejects.toThrow();
});
for (const target of ['source-inputs.json', 'preparation.json']) test(`rejects rehashed inconsistent ${target}`, async () => {
  const f = await fixture((result, files) => {
    const value = JSON.parse(files[target].toString());
    if (target === 'source-inputs.json') value.context.checkoutSha = 'c'.repeat(40);
    else value.cli.files[0].sha256 = '0'.repeat(64);
    files[target] = Buffer.from(JSON.stringify(value));
    result[target === 'source-inputs.json' ? 'sourceInputs' : 'preparation'].sha256 = hash(files[target]);
  });
  await expect(projectCliPublicationInput(f.input, f.output)).rejects.toThrow();
});
test('old CLI consumer test material role cannot enter publication projection', async () => {
  const f = await fixture(); const file = path.join(f.acquired, 'receipt.json');
  const receipt = JSON.parse(readFileSync(file, 'utf8')); receipt.materialRole = 'test-materials';
  writeFileSync(file, JSON.stringify(receipt)); f.input.custodyReceiptSha256 = hash(readFileSync(file));
  await expect(projectCliPublicationInput(f.input, f.output)).rejects.toThrow('custody required');
});
