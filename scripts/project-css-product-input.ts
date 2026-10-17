import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import path from 'node:path';
import { CSS_PRODUCT_WORKFLOW } from './acquire-independent-product-input';
import { assertPreviewProductContext, productOriginal, withProductProjection } from './lib/product-artifact-projection';
import { parsePhysicalPackReceipt } from './lib/physical-pack-receipt';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const ARCHIVE_BOUND = 512 * 1024 ** 2;
const PHASES = ['install', 'tools', 'client', 'cli', 'afs-client', 'dependency-state', 'pack'];
const NATIVE_ORIGINALS = ['run.raw.json', 'artifact.metadata.raw.json', 'native-jobs.raw.json', 'native.zip',
  'qlever-local-runtime-darwin-arm64.tar.gz', 'qlever-local-acceptance.json'];
export interface CssProductProjectionInput {
  schemaVersion: 1;
  acquisitionRoot: string;
  custodyReceiptSha256: string;
  members: { producer: 'producer.receipt.json'; archive: 'product.tgz'; packRaw: 'evidence/pack.raw.log' };
}
function fail(message: string): never { throw new Error('CSS product projection: ' + message); }
/** CSS component generation shares stdout with one final normal pack result. */
export function parseCssPackReceipt(raw: Buffer): any {
  if (raw.length > 64 * 1024) fail('pack raw exceeds bound');
  const candidates = raw.toString('utf8').split(/\r?\n/u).flatMap(line => {
    try { const value = JSON.parse(line); return value && typeof value === 'object' && 'archive' in value ? [line] : []; }
    catch { return []; }
  });
  if (candidates.length !== 1) fail('unique normal CSS pack result required');
  return parsePhysicalPackReceipt(Buffer.from(candidates[0]), fail);
}

/** Transport-only CSS adapter. The common ZIP scanner is the sole extractor. */
export async function projectCssProductInput(input: CssProductProjectionInput, output: string) {
  if (input?.schemaVersion !== 1 || !/^[a-f0-9]{64}$/u.test(input.custodyReceiptSha256)
    || input.members?.producer !== 'producer.receipt.json' || input.members.archive !== 'product.tgz'
    || input.members.packRaw !== 'evidence/pack.raw.log') fail('explicit CSS producer member contract required');
  return await withProductProjection(input, output, { workflowPath: CSS_PRODUCT_WORKFLOW, materialRole: 'controlled-preview-materials',
    artifactNames: custody => [`css-module-products-darwin-arm64-${custody.expectedSourceSha}-${custody.runId}-${custody.runAttempt}`] }, async session => {
    const { root, custody, metadata: { run }, temporary, member, select, project, writeOutput } = session;
    const producerMember = member(input.members.producer, 1024 * 1024);
    const archiveMember = member(input.members.archive, ARCHIVE_BOUND);
    const packMember = member(input.members.packRaw, 64 * 1024);
    project([select(producerMember, 'producer.receipt.json')]);
    const producer = JSON.parse(productOriginal(path.join(temporary, 'producer.receipt.json'), producerMember.sha256).toString());
    const context = assertPreviewProductContext(producer, custody, run, CSS_PRODUCT_WORKFLOW, 'css-module-product-production');
    if (typeof context.actualMacOSVersion !== 'string' || context.actualMacOSVersion.split('.')[0] !== '15'
      || context.actualMachine !== 'arm64') fail('native macOS15 producer claim required');
    const bind = (reference: any, expected: string, bound: number, minimum: 0 | 1 = 1) => {
      const row = member(expected, bound, minimum);
      if (reference?.path !== expected || reference.bytes !== row.bytes || reference.sha256 !== row.sha256) fail('original member reference mismatch: ' + expected);
      return row;
    };
    bind(producer.archive, input.members.archive, ARCHIVE_BOUND);
    bind(producer.packRaw, input.members.packRaw, 64 * 1024);
    if (!Array.isArray(producer.phases) || producer.phases.length !== PHASES.length) fail('complete normal phase references required');
    producer.phases.forEach((phase: any, index: number) => {
      const expected = PHASES[index];
      if (phase.name !== expected) fail('normal phase order mismatch');
      bind(phase.receipt, `evidence/${expected}.receipt.json`, 1024 * 1024);
      bind(phase.raw, `evidence/${expected}.raw.log`, 128 * 1024 * 1024, 0);
    });
    const native = producer.nativeAcquisition;
    if (!native || !Number.isSafeInteger(native.artifactId) || native.artifactId < 1
      || !Number.isSafeInteger(native.nativeJobId) || native.nativeJobId < 1
      || native.officialIdentityAuthenticated !== false || native.releaseAccepted !== false
      || !Array.isArray(native.originals) || native.originals.length !== NATIVE_ORIGINALS.length) fail('native original references required');
    native.originals.forEach((reference: any, index: number) => bind(reference, `originals/${NATIVE_ORIGINALS[index]}`,
      ['native.zip', 'qlever-local-runtime-darwin-arm64.tar.gz'].includes(NATIVE_ORIGINALS[index]) ? ARCHIVE_BOUND : 1024 * 1024));
    // Every referenced phase/native byte remains in the unique original ZIP.
    // These claims are hash-bound, not reclassified as independently admitted.
    project([select(archiveMember, 'product.tgz'), select(packMember, 'pack.raw.log')]);
    const digest = createHash('sha512');
    for await (const bytes of createReadStream(path.join(temporary, 'product.tgz'))) digest.update(bytes);
    const integrity = 'sha512-' + digest.digest('base64');
    const packed = parseCssPackReceipt(productOriginal(path.join(temporary, 'pack.raw.log'), packMember.sha256));
    if (producer.archive.integrity !== integrity || packed.integrity !== integrity || packed.sha256 !== archiveMember.sha256
      || packed.members !== producer.archive.members || packed.publicationMode !== 'preview'
      || packed.status !== 'controlled-preview' || packed.releaseAccepted !== false || packed.nativeAdmission !== false) fail('normal preview pack/archive binding mismatch');
    const archive = { path: 'product.tgz', bytes: archiveMember.bytes, sha256: archiveMember.sha256, integrity, members: packed.members };
    const packageIdentity = { name: '@undefineds.co/xpod-css-darwin-arm64', version: context.version, target: 'darwin-arm64' };
    const consumerInput = Buffer.from(JSON.stringify({ schemaVersion: 1, expectedSourceSha: context.actualCheckoutSha,
      archive, package: packageIdentity, custodyReceiptSha256: input.custodyReceiptSha256 }, null, 2) + '\n');
    const receipt = { schemaVersion: 1, kind: 'css-product-input-projection', status: 'projected-blocked',
      custodyReceipt: { path: path.join(root, 'receipt.json'), sha256: input.custodyReceiptSha256 }, members: input.members,
      producerReceipt: { path: 'producer.receipt.json', bytes: producerMember.bytes, sha256: producerMember.sha256 },
      sourceSha: context.actualCheckoutSha, runHeadSha: context.runHeadSha, runId: context.runId, runAttempt: context.runAttempt,
      archive, package: packageIdentity,
      originalEvidence: { phases: producer.phases, native: native.originals, retainedIn: 'custody-original-zip' },
      consumerInput: { path: 'consumer-input.json', bytes: consumerInput.length, sha256: hash(consumerInput) },
      actualCheckoutVerified: false, exactAttemptAdmitted: false, phaseClosureAdmitted: false,
      consumerValidated: false, registryConsumerValidated: false, legalClearance: false, nativeAdmission: false, published: false, releaseQualified: false,
      selectedMembersProjected: 3, innerArchiveExpanded: false,
      blockers: ['producer-checkout-attempt-and-phase-closure-not-independently-admitted', 'module-inventory-and-native-closure-not-verified',
        'registry-consumer-legal-native-release-admission-unverified'],
      limitations: ['References are rehashed against the complete original ZIP; only the three selected originals are copied.',
        'The inner product tgz and native archives remain unexpanded. No source/native/legal/consumer admission is created.'] };
    writeOutput(receipt, { 'consumer-input.json': consumerInput });
    return receipt;
  });
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 4) fail('input JSON and new output directory required');
    console.log(JSON.stringify(await projectCssProductInput(JSON.parse(readFileSync(process.argv[2], 'utf8')), process.argv[3]), null, 2));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
