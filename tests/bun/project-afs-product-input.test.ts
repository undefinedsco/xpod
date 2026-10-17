import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { acquireIndependentProductInput } from '../../scripts/acquire-independent-product-input';
import { projectAfsProductInput } from '../../scripts/project-afs-product-input';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
test('AFS normal product projection uses normal archive originals and cannot become native/source approval', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'afs-product-projection-'));
  try {
    const source = 'a'.repeat(40), workflow = '.github/workflows/agentfs-module-mounted-acceptance.yml';
    const driver=Buffer.from('actual producer bundled negative-contract fixture');
    const archive = Buffer.from('normal tar archive byte fixture'), raw = Buffer.from('closed AFS normal build original');
    const original = { path: 'evidence/afs-build.raw.log', bytes: raw.length, sha256: hash(raw) };
    const producer = { schemaVersion: 1, kind: 'afs-module-product-production', status: 'controlled-preview-materials',
      context: { repository: 'undefinedsco/xpod', workflowPath: workflow, workflowRef: `undefinedsco/xpod/${workflow}@refs/heads/staging`,
        workflowSha: source, runId: 42, runAttempt: 1, event: 'workflow_dispatch', runHeadSha: source, githubSha: source,
        actualCheckoutSha: source, target: 'darwin-arm64', version: '0.1.0-preview.1' },
      sourceBefore: { sha: source, status: '' }, sourceAfter: { sha: source, status: '' },
      archive: { path: 'product.tgz', bytes: archive.length, sha256: hash(archive), integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') },
      phases: Array.from({ length: 8 }, (_, index) => ({ name: index === 4 ? 'afs-build' : 'phase-' + index, raw: original })), packRaw: original,
      published: false, releaseQualified: false, consumerValidated: false, legalClearance: false, nativeAdmission: false };
    const files = [['producer.receipt.json', Buffer.from(JSON.stringify(producer))], ['product.tgz', archive], ['module-admission.mjs',driver], [original.path, raw]]
      .map(([name, body]) => ({ name, body: (body as Buffer).toString('base64') }));
    const file = path.join(root, 'artifact.zip');
    const created = spawnSync('python3', ['-c', "import zipfile,json,base64,sys\nwith zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:\n for r in json.loads(sys.argv[2]):z.writestr(r['name'],base64.b64decode(r['body']))", file, JSON.stringify(files)]);
    expect(created.status).toBe(0);
    const zip = fs.readFileSync(file), archiveSha256 = hash(zip);
    const run = { id: 42, run_attempt: 1, head_sha: source, repository: { full_name: 'undefinedsco/xpod' }, head_repository: { full_name: 'undefinedsco/xpod' },
      status: 'completed', conclusion: 'success', event: 'workflow_dispatch', workflow_id: 7, path: workflow, run_started_at: '2026-10-15T00:00:00Z', updated_at: '2026-10-15T00:02:00Z' };
    const artifact = { id: 91, name: `afs-module-production-darwin-arm64-${source}-42-1`, size_in_bytes: zip.length, digest: 'sha256:' + archiveSha256,
      created_at: '2026-10-15T00:01:00Z', expired: false, workflow_run: { id: 42, head_sha: source } };
    const transport = (async (url: any) => String(url).endsWith('/attempts/1') ? Response.json(run)
      : String(url).endsWith('/workflows/7') ? Response.json({ id: 7, path: workflow })
      : String(url).endsWith('/artifacts/91') ? Response.json(artifact) : new Response(zip)) as typeof fetch;
    const acquisitionRoot = path.join(root, 'acquired');
    await acquireIndependentProductInput({ schemaVersion: 1, sourceSha: source, runHeadSha: source, runId: 42, runAttempt: 1, artifactId: 91, artifactSha256: archiveSha256 }, acquisitionRoot, { fetch: transport });
    const output = path.join(root, 'projected');
    const result = await projectAfsProductInput({ schemaVersion: 1, acquisitionRoot,
      custodyReceiptSha256: hash(fs.readFileSync(path.join(acquisitionRoot, 'receipt.json'))), members: { producer: 'producer.receipt.json', archive: 'product.tgz' } }, output);
    expect(fs.readFileSync(path.join(output, 'product.tgz'))).toEqual(archive);
    expect(fs.readFileSync(path.join(output,'module-admission.mjs'))).toEqual(driver);
    expect(result.preflightDriver.sha256).toBe(hash(driver));
    expect(result.sourceAdmission).toBe(false); expect(result.nativeAdmission).toBe(false); expect(result.releaseQualified).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
