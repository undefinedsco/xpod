import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { API_PRODUCT_WORKFLOW, assertNewAcquisitionOutput, verifyAcquiredMetadata } from './acquire-independent-product-input';
import { parseApiPackReceipt } from './collect-api-release-input';
import { exactVersion } from './independent-release-plan';
const { withOwnedTempRoot } = createRequire(import.meta.url)('./lib/owned-temp-root.cjs');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const BOUNDS = { archive: 512 * 1024 ** 2, packRaw: 64 * 1024, producer: 1024 * 1024 };
export interface ApiProductProjectionInput {
  schemaVersion: 1;
  acquisitionRoot: string;
  custodyReceiptSha256: string;
  members: { producer: 'producer.receipt.json'; archive: 'product.tgz'; packRaw: 'evidence/pack.raw.log' };
}
function fail(message: string): never { throw new Error('API product projection: ' + message); }
function original(file: string, expected?: string): Buffer {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 ** 2) fail('bounded regular original required');
  const bytes = readFileSync(file);
  if (expected && hash(bytes) !== expected) fail('original hash mismatch');
  return bytes;
}
/** Projects only the API pilot's fixed member contract. Producer claims remain unadmitted. */
export async function projectApiProductInput(input: ApiProductProjectionInput, output: string) {
  if (input?.schemaVersion !== 1 || !/^[a-f0-9]{64}$/u.test(input.custodyReceiptSha256)
    || input.members?.producer !== 'producer.receipt.json' || input.members.archive !== 'product.tgz'
    || input.members.packRaw !== 'evidence/pack.raw.log') fail('explicit API producer member contract required');
  output = assertNewAcquisitionOutput(output);
  const root = path.resolve(input.acquisitionRoot);
  const custody = JSON.parse(original(path.join(root, 'receipt.json'), input.custodyReceiptSha256).toString());
  if (custody.schemaVersion !== 1 || custody.kind !== 'independent-product-artifact-acquisition' || custody.status !== 'blocked'
    || custody.repository !== 'undefinedsco/xpod' || custody.workflowPath !== API_PRODUCT_WORKFLOW
    || custody.materialRole !== 'controlled-preview-materials' || custody.published !== false || custody.releaseQualified !== false
    || custody.archive?.path !== 'artifact.zip' || !/^[a-f0-9]{64}$/u.test(custody.archive.sha256)) fail('API product custody required; test/native artifacts cannot project');
  verifyAcquiredMetadata(root, custody.metadata);
  const metadata = JSON.parse(original(path.join(root, 'metadata.json')).toString());
  const { run, workflow, artifact } = metadata;
  if (run.id !== custody.runId || run.run_attempt !== custody.runAttempt || run.head_sha !== custody.runHeadSha
    || run.status !== 'completed' || run.conclusion !== 'success' || workflow.id !== run.workflow_id
    || workflow.path !== API_PRODUCT_WORKFLOW || run.path?.split('@')[0] !== API_PRODUCT_WORKFLOW
    || run.repository?.full_name !== custody.repository || run.head_repository?.full_name !== custody.repository
    || artifact.id !== custody.artifactId || artifact.expired !== false || artifact.workflow_run?.id !== run.id
    || artifact.workflow_run?.head_sha !== custody.runHeadSha || artifact.digest !== 'sha256:' + custody.archive.sha256
    || artifact.name !== `api-module-products-darwin-arm64-${custody.expectedSourceSha}-${custody.runId}-${custody.runAttempt}`) fail('saved API producer metadata mismatch');
  const inventory = custody.inventory?.members;
  if (!Array.isArray(inventory)) fail('ZIP member inventory required');
  function member(name: string, bound: number) {
    const selected = inventory.filter((row: any) => row.path === name);
    if (selected.length !== 1 || selected[0].kind !== 'file' || !Number.isSafeInteger(selected[0].bytes)
      || selected[0].bytes < 1 || selected[0].bytes > bound || !/^[a-f0-9]{64}$/u.test(selected[0].sha256)) fail('unique ordinary bounded member required: ' + name);
    return selected[0];
  }
  const producerMember = member(input.members.producer, BOUNDS.producer);
  const archiveMember = member(input.members.archive, BOUNDS.archive);
  const packMember = member(input.members.packRaw, BOUNDS.packRaw);
  const zipStat = lstatSync(path.join(root, 'artifact.zip'));
  if (!zipStat.isFile() || zipStat.isSymbolicLink() || zipStat.size !== custody.archive.bytes || zipStat.size !== artifact.size_in_bytes) fail('original ZIP size/type mismatch');
  return await withOwnedTempRoot('xpod-api-product-projection-', async (temporary: string) => {
    function project(selections: any[]) {
      const result = spawnSync('python3', [path.join(import.meta.dir, 'lib/inspect-product-artifact.py'), path.join(root, 'artifact.zip'), custody.archive.sha256,
        String(512 * 1024 ** 2), String(1024 ** 3), '50000', JSON.stringify(selections), temporary], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0 || result.error) fail('ZIP projection failed');
      const checked = JSON.parse(result.stdout);
      if (checked.selectedMembersProjected !== selections.length || checked.innerArchiveExpanded !== false) fail('ZIP projection facts mismatch');
      for (const row of [producerMember, archiveMember, packMember]) {
        const actual = checked.members.filter((entry: any) => entry.path === row.path);
        if (actual.length !== 1 || actual[0].kind !== row.kind || actual[0].bytes !== row.bytes || actual[0].sha256 !== row.sha256) fail('ZIP inventory changed');
      }
    }
    const select = (row: any, destination: string) => ({ path: row.path, destination, bytes: row.bytes, sha256: row.sha256 });
    project([select(producerMember, 'producer.receipt.json')]);
    const producer = JSON.parse(original(path.join(temporary, 'producer.receipt.json'), producerMember.sha256).toString());
    const context = producer.context;
    if (producer.schemaVersion !== 1 || producer.kind !== 'api-module-product-production' || producer.status !== 'controlled-preview-materials'
      || !context || context.repository !== custody.repository || context.workflowPath !== API_PRODUCT_WORKFLOW
      || typeof context.workflowRef !== 'string' || !context.workflowRef.startsWith(`${custody.repository}/${API_PRODUCT_WORKFLOW}@`)
      || !/^[a-f0-9]{40}$/u.test(context.workflowSha) || context.runId !== custody.runId || context.runAttempt !== custody.runAttempt
      || context.runHeadSha !== custody.runHeadSha || context.event !== run.event || context.actualCheckoutSha !== custody.expectedSourceSha
      || context.githubSha !== context.actualCheckoutSha || context.target !== 'darwin-arm64' || !exactVersion(context.version)
      || producer.sourceBefore?.sha !== context.actualCheckoutSha || producer.sourceAfter?.sha !== context.actualCheckoutSha
      || producer.sourceBefore.status !== '' || producer.sourceAfter.status !== ''
      || producer.published !== false || producer.releaseQualified !== false || producer.consumerValidated !== false
      || producer.legalClearance !== false || producer.nativeAdmission !== false) fail('producer context/source/preview binding mismatch');
    if (producer.archive?.path !== input.members.archive || producer.archive.bytes !== archiveMember.bytes || producer.archive.sha256 !== archiveMember.sha256
      || producer.packRaw?.path !== input.members.packRaw || producer.packRaw.bytes !== packMember.bytes || producer.packRaw.sha256 !== packMember.sha256) fail('producer selected member binding mismatch');
    project([select(archiveMember, 'product.tgz'), select(packMember, 'pack.raw.log')]);
    const integrityHash = createHash('sha512');
    for await (const chunk of createReadStream(path.join(temporary, 'product.tgz'))) integrityHash.update(chunk);
    const integrity = 'sha512-' + integrityHash.digest('base64');
    const packed = parseApiPackReceipt(original(path.join(temporary, 'pack.raw.log'), packMember.sha256));
    if (producer.archive.integrity !== integrity || packed.integrity !== integrity || packed.sha256 !== archiveMember.sha256
      || packed.members !== producer.archive.members) fail('original pack/archive binding mismatch');
    const collectorInput = { schemaVersion: 1, expectedSourceSha: context.actualCheckoutSha,
      archive: { path: 'product.tgz', sha256: archiveMember.sha256 }, packReceipt: { path: 'pack.raw.log', sha256: packMember.sha256 } };
    const inputBytes = Buffer.from(JSON.stringify(collectorInput, null, 2) + '\n');
    const receipt = { schemaVersion: 1, kind: 'api-product-input-projection', status: 'projected-blocked',
      custodyReceipt: { path: path.join(root, 'receipt.json'), sha256: input.custodyReceiptSha256 }, members: input.members,
      producerReceipt: { path: 'producer.receipt.json', sha256: producerMember.sha256 },
      sourceSha: context.actualCheckoutSha, runHeadSha: context.runHeadSha, runId: context.runId, runAttempt: context.runAttempt,
      collectorInput: { path: 'collector-input.json', bytes: inputBytes.length, sha256: hash(inputBytes) },
      actualCheckoutVerified: false, exactAttemptAdmitted: false, collectorExecuted: false, published: false, releaseQualified: false,
      selectedMembersProjected: 3, innerArchiveExpanded: false,
      blockers: ['producer-checkout-and-attempt-claims-not-independently-admitted', 'producer-phase-closure-not-admitted',
        'collector-not-executed', 'source-native-legal-consumer-admission-unverified'],
      producerBlockers: producer.blockers ?? [],
      limitations: ['Context/source comparisons bind producer claims to custody facts; no new admission authority is created.',
        'Only selected original members are copied. The inner tgz is not expanded or verified as an API module here.'] };
    let owned = false;
    try {
      mkdirSync(output, { mode: 0o700 }); owned = true;
      for (const file of ['producer.receipt.json', 'product.tgz', 'pack.raw.log']) renameSync(path.join(temporary, file), path.join(output, file));
      writeFileSync(path.join(output, 'collector-input.json'), inputBytes, { flag: 'wx', mode: 0o400 });
      writeFileSync(path.join(output, 'projection.receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
    } catch (error) {
      if (owned) {
        try { rmSync(output, { recursive: true, force: true }); }
        catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], 'Projection and cleanup failed'), { cause: error }); }
      }
      throw error;
    }
    return receipt;
  });
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 4) fail('input JSON and new output directory required');
    console.log(JSON.stringify(await projectApiProductInput(JSON.parse(readFileSync(process.argv[2], 'utf8')), process.argv[3]), null, 2));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
