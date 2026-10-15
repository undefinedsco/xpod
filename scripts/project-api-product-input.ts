import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import path from 'node:path';
import { API_PRODUCT_WORKFLOW } from './acquire-independent-product-input';
import { productOriginal, withProductProjection } from './lib/product-artifact-projection';
import { parseApiPackReceipt } from './collect-api-release-input';
import { exactVersion } from './independent-release-plan';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const BOUNDS = { archive: 512 * 1024 ** 2, packRaw: 64 * 1024, producer: 1024 * 1024 };
export interface ApiProductProjectionInput {
  schemaVersion: 1;
  acquisitionRoot: string;
  custodyReceiptSha256: string;
  members: { producer: 'producer.receipt.json'; archive: 'product.tgz'; packRaw: 'evidence/pack.raw.log' };
}
function fail(message: string): never { throw new Error('API product projection: ' + message); }
export async function projectApiProductInput(input: ApiProductProjectionInput, output: string) {
  if (input?.schemaVersion !== 1 || !/^[a-f0-9]{64}$/u.test(input.custodyReceiptSha256)
    || input.members?.producer !== 'producer.receipt.json' || input.members.archive !== 'product.tgz'
    || input.members.packRaw !== 'evidence/pack.raw.log') fail('explicit API producer member contract required');
  return await withProductProjection(input, output, { workflowPath: API_PRODUCT_WORKFLOW, materialRole: 'controlled-preview-materials',
    artifactNames: custody => [`api-module-products-darwin-arm64-${custody.expectedSourceSha}-${custody.runId}-${custody.runAttempt}`] }, async ({ root, custody, metadata: { run }, temporary, member, project, select, writeOutput }) => {
  const producerMember = member(input.members.producer, BOUNDS.producer);
  const archiveMember = member(input.members.archive, BOUNDS.archive);
  const packMember = member(input.members.packRaw, BOUNDS.packRaw);
    project([select(producerMember, 'producer.receipt.json')]);
    const producer = JSON.parse(productOriginal(path.join(temporary, 'producer.receipt.json'), producerMember.sha256).toString());
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
    const packed = parseApiPackReceipt(productOriginal(path.join(temporary, 'pack.raw.log'), packMember.sha256));
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
    writeOutput(receipt, { 'collector-input.json': inputBytes });
    return receipt;
  });
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 4) fail('input JSON and new output directory required');
    console.log(JSON.stringify(await projectApiProductInput(JSON.parse(readFileSync(process.argv[2], 'utf8')), process.argv[3]), null, 2));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
