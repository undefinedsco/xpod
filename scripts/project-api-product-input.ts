import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import path from 'node:path';
import { API_PRODUCT_WORKFLOW } from './acquire-independent-product-input';
import { assertPreviewProductContext, productOriginal, withProductProjection } from './lib/product-artifact-projection';
import { productTargets } from './module-product-targets';
import { parseApiPackReceipt } from './collect-api-release-input';
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
  const targets = productTargets('api').filter(target => target.nativeSourceAvailable);
  const artifactName = (target: string, custody: any) => `api-module-products-${target}-${custody.expectedSourceSha}-${custody.runId}-${custody.runAttempt}`;
  return await withProductProjection(input, output, { workflowPath: API_PRODUCT_WORKFLOW, materialRole: 'controlled-preview-materials',
    artifactNames: custody => targets.map(target => artifactName(target.target, custody)) }, async ({ root, custody, metadata: { run, artifact }, temporary, member, project, select, writeOutput }) => {
  const producerMember = member(input.members.producer, BOUNDS.producer);
  const archiveMember = member(input.members.archive, BOUNDS.archive);
  const packMember = member(input.members.packRaw, BOUNDS.packRaw);
    project([select(producerMember, 'producer.receipt.json')]);
    const producer = JSON.parse(productOriginal(path.join(temporary, 'producer.receipt.json'), producerMember.sha256).toString());
    const matches = targets.filter(target => artifactName(target.target, custody) === artifact.name);
    if (matches.length !== 1) fail('unique observed artifact target required');
    const context = assertPreviewProductContext(producer, custody, run, API_PRODUCT_WORKFLOW, 'api-module-product-production', matches[0].target);
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
