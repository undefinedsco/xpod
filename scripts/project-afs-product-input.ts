import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { MODULE_TARGETS } from '../packages/xpod-cli/src/module-catalog';
import { assertPreviewProductContext, productOriginal, withProductProjection } from './lib/product-artifact-projection';

const WORKFLOW = '.github/workflows/agentfs-module-mounted-acceptance.yml';
const fail = (message: string): never => { throw Error('AFS normal product projection: ' + message); };
/** Normal mounted-module producer transport only. Native archives and the older
 * inventory/safeBuild export cannot substitute for the actual normal product. */
export async function projectAfsProductInput(input: {
  schemaVersion: 1; acquisitionRoot: string; custodyReceiptSha256: string;
  members: { producer: 'producer.receipt.json'; archive: 'product.tgz'; packRaw?: string };
}, output: string) {
  if (input.schemaVersion !== 1 || input.members?.producer !== 'producer.receipt.json' || input.members.archive !== 'product.tgz') fail('fixed normal product members required');
  const artifactName = (target: string, custody: any) => `afs-module-production-${target}-${custody.expectedSourceSha}-${custody.runId}-${custody.runAttempt}`;
  return withProductProjection(input, output, { workflowPath: WORKFLOW, materialRole: 'controlled-preview-materials',
    artifactNames: custody => MODULE_TARGETS.map(target => artifactName(`${target.platform}-${target.arch}`, custody)) },
  async ({ root, custody, metadata: { run, artifact }, temporary, member, project, select, writeOutput }) => {
    const targets = MODULE_TARGETS.filter(row => artifactName(`${row.platform}-${row.arch}`, custody) === artifact.name);
    if (targets.length !== 1) fail('unique normal module target required');
    const target = `${targets[0]!.platform}-${targets[0]!.arch}`;
    const producerMember = member('producer.receipt.json', 1024 * 1024), archiveMember = member('product.tgz', 512 * 1024 ** 2);
    project([select(producerMember, 'producer.receipt.json')]);
    const producer = JSON.parse(productOriginal(path.join(temporary, 'producer.receipt.json'), producerMember.sha256).toString());
    const context = assertPreviewProductContext(producer, custody, run, WORKFLOW, 'afs-module-product-production', target);
    if (producer.archive?.path !== 'product.tgz' || producer.archive.bytes !== archiveMember.bytes || producer.archive.sha256 !== archiveMember.sha256
      || !Array.isArray(producer.phases) || producer.phases.length !== 8 || producer.phases[4].name !== 'afs-build'
      || producer.packRaw?.path !== 'evidence/afs-build.raw.log' || !isDeepStrictEqual(producer.packRaw, producer.phases[4].raw)) fail('normal archive/phase reference mismatch');
    const raw = member(producer.packRaw.path, 128 * 1024 ** 2, 0);
    if (raw.bytes !== producer.packRaw.bytes || raw.sha256 !== producer.packRaw.sha256) fail('actual normal build original mismatch');
    project([select(archiveMember, 'product.tgz')]);
    const sha512 = createHash('sha512');
    for await (const chunk of createReadStream(path.join(temporary, 'product.tgz'))) sha512.update(chunk);
    if (producer.archive.integrity !== 'sha512-' + sha512.digest('base64')) fail('actual normal product integrity mismatch');
    const receipt = { schemaVersion: 1, kind: 'afs-product-input-projection', status: 'projected-blocked',
      custodyReceipt: { path: path.join(root, 'receipt.json'), sha256: input.custodyReceiptSha256 },
      producerReceipt: { path: 'producer.receipt.json', sha256: producerMember.sha256 },
      archive: { ...producer.archive }, sourceSha: context.actualCheckoutSha, runHeadSha: context.runHeadSha,
      runId: context.runId, runAttempt: context.runAttempt, target, version: context.version,
      actualCheckoutVerified: false, exactAttemptAdmitted: false, published: false, releaseQualified: false,
      sourceAdmission: false, nativeAdmission: false, legalClearance: false, consumerValidated: false,
      scope: 'exact normal mounted-module original transport only; no source, native, legal or consumer admission' };
    writeOutput(receipt); return receipt;
  });
}
