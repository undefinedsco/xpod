import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { verifyAcquiredMetadata } from '../../acquire-independent-product-input';
import { projectCliPublicationInput } from '../../project-cli-publication-input';
import { githubOriginFacts } from './github-origin';
import type { CollectedArtifactCapability, CollectedArtifactView, CollectedArtifactMember } from './artifact-contract';

const issued = new WeakMap<object, CollectedArtifactView>();
const require = createRequire(import.meta.url);
const { withOwnedTempRoot } = require('../owned-temp-root.cjs');
const { inspectArtifact } = require('../product-artifact-command.cjs');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => { throw new Error('Independent artifact collector: ' + message); };

export function collectedArtifactView(value: unknown): CollectedArtifactView | undefined {
  return value !== null && typeof value === 'object' ? issued.get(value) : undefined;
}

/** Reuses a previously acquired original without redownloading it. The live
 * observation capability is mandatory: offline JSON/custody hashes cannot mint
 * authority. The existing projector rechecks actual ZIP bytes and members.
 * First adapter supports the real normal CLI/client producer only. Module
 * collectors must extend this same issuer after their origin policy is reviewed.
 * This grants artifact custody, never source/native/legal/release approval. */
export async function collectAdmissionArtifact(input: {
  githubOrigin: unknown;
  acquisitionRoot: string;
  projectionOutput: string;
  product: 'cli' | 'client';
}): Promise<CollectedArtifactCapability> {
  const origin = githubOriginFacts(input.githubOrigin);
  if (!origin) return fail('controlled origin observation required');
  if (!['cli', 'client'].includes(input.product)) fail('unsupported collector product');
  const root = path.resolve(input.acquisitionRoot);
  const receiptBytes = readFileSync(path.join(root, 'receipt.json'));
  const custody = JSON.parse(receiptBytes.toString('utf8'));
  verifyAcquiredMetadata(root, custody.metadata);
  if (custody.expectedSourceSha !== origin.sourceSha || custody.runHeadSha !== origin.runHeadSha
    || custody.runId !== origin.runId || custody.runAttempt !== origin.runAttempt
    || custody.artifactId !== origin.artifactId || custody.workflowPath !== origin.workflowPath
    || custody.archive?.sha256 !== origin.artifactSha256) fail('observed artifact/custody mismatch');
  const producerOriginals = new Map<string, Buffer>();
  const selected = custody.inventory.members.filter((row: any) => row.kind === 'file');
  if (selected.length > 1000 || selected.some((row: any) => row.bytes > 8 * 1024 ** 2)
    || selected.reduce((total: number, row: any) => total + row.bytes, 0) > 16 * 1024 ** 2) fail('producer original resource bound exceeded');
  await withOwnedTempRoot('xpod-admission-originals-', async (temporary: string) => {
    const selections = selected.map((row: any) => ({ path: row.path, destination: row.path, bytes: row.bytes, sha256: row.sha256 }));
    const result = inspectArtifact([path.join(import.meta.dir, '../inspect-product-artifact.py'),
      path.join(root, 'artifact.zip'), origin.artifactSha256, String(8 * 1024 ** 2), String(16 * 1024 ** 2),
      '1000', JSON.stringify(selections), temporary, 'independent-source-originals'], { timeout: 30_000, maxBuffer: 1024 ** 2 });
    if (result.error || result.status !== 0 || result.signal) fail('producer ZIP member verification failed: '
      + String(result.error?.message ?? result.stderr).slice(0, 1200));
    const checked = JSON.parse(result.stdout);
    if (!isDeepStrictEqual(checked.members, custody.inventory.members)) fail('complete acquired ZIP inventory mismatch');
    for (const row of selected) {
      const bytes = readFileSync(path.join(temporary, row.path));
      if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) fail('producer original changed after projection');
      producerOriginals.set(row.path, bytes);
    }
  });
  // Bound inner inflation before invoking the normal preparation verifier.
  // It will consume these same hash-bound ZIP members, never a replacement tar.
  const { inspectTarballBuffer } = require('../../workspace-package-payload.cjs');
  for (const name of ['cli.tgz', 'client.tgz']) {
    const bytes = producerOriginals.get(name);
    if (!bytes) fail('normal publication archives missing');
    inspectTarballBuffer(bytes, { expandedBytes: 16 * 1024 ** 2, members: 20000 });
  }
  const projected = await projectCliPublicationInput({ schemaVersion: 1, acquisitionRoot: root,
    custodyReceiptSha256: hash(receiptBytes) }, input.projectionOutput);
  const row = projected.products[input.product];
  const archive = readFileSync(path.join(input.projectionOutput, row.archive.path));
  const producerRows = Object.freeze(selected.map((row: any) => Object.freeze({ path: row.path, sha256: row.sha256, bytes: row.bytes, mode: row.mode ?? 0 })));
  return issueProductArchive(origin.sourceSha, row, archive, producerRows, (name, maximumBytes) => {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return fail('invalid original byte bound');
    const bytes = producerOriginals.get(name);
    const row = selected.find((item: any) => item.path === name);
    if (!bytes || !row || bytes.length > maximumBytes || hash(bytes) !== row.sha256) return fail('unique bounded producer original required');
    return Buffer.from(bytes);
  });
}

/** A sibling archive from the same authenticated producer ZIP needs no second
 * network download and cannot be substituted by a caller-provided file. */
export function collectRelatedAdmissionArtifact(parent: CollectedArtifactCapability, product: 'cli' | 'client'): CollectedArtifactCapability {
  const view = collectedArtifactView(parent);
  if (!view) return fail('collected parent capability required');
  if (!['cli', 'client'].includes(product)) return fail('unsupported related product');
  const producer = JSON.parse(view.readProducerOriginal('result.json', 1024 ** 2).toString('utf8'));
  const row = producer.products?.[product];
  if (producer.context?.checkoutSha !== view.identity.sourceSha || row?.package !== '@undefineds.co/xpod-' + product) fail('related producer identity mismatch');
  const archive = view.readProducerOriginal(row.archive.path, 8 * 1024 ** 2);
  return issueProductArchive(view.identity.sourceSha, row, archive, view.producerOriginals, view.readProducerOriginal);
}

// Private issuer: only authenticated acquisition or a previously issued parent
// capability can reach this function. No JSON/hash-to-authority constructor.
function issueProductArchive(sourceSha: string, row: any, archive: Buffer,
  producerRows: readonly CollectedArtifactMember[], readProducerOriginal: CollectedArtifactView['readProducerOriginal']): CollectedArtifactCapability {
  if (archive.length !== row.archive.bytes || hash(archive) !== row.archive.sha256
    || 'sha512-' + createHash('sha512').update(archive).digest('base64') !== row.archive.integrity) fail('projected product archive mismatch');
  const { inspectTarballBuffer } = require('../../workspace-package-payload.cjs');
  const inspected = inspectTarballBuffer(archive, { expandedBytes: 16 * 1024 ** 2, members: 20000 });
  if (inspected.manifest.name !== row.package || inspected.manifest.version !== row.version) fail('archive product identity mismatch');
  const originals = new Map<string, Buffer>();
  const memberHashes = new Map<string, string>();
  const members = inspected.entries.filter((entry: any) => entry.type === 'file').map((entry: any) => {
    if (!entry.path.startsWith('package/')) fail('unexpected product member root');
    if (entry.size > 8 * 1024 ** 2) fail('product member byte budget exceeded');
    const relative = entry.path.slice('package/'.length);
    originals.set(relative, Buffer.from(entry.content));
    memberHashes.set(relative, entry.sha256);
    return Object.freeze({ path: relative, sha256: entry.sha256, bytes: entry.size, mode: entry.mode });
  });
  const identity = Object.freeze({ sourceSha, package: row.package, version: row.version,
    archiveSha256: row.archive.sha256, integrity: row.archive.integrity, archiveBytes: archive.length });
  const view: CollectedArtifactView = Object.freeze({ identity, members: Object.freeze(members),
    producerOriginals: producerRows,
    readProducerOriginal,
    readMember(name: string, maximumBytes: number): Buffer {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return fail('invalid member byte bound');
      const bytes = originals.get(name);
      if (!bytes || bytes.length > maximumBytes) return fail('unique bounded product member required');
      if (hash(bytes) !== memberHashes.get(name)) return fail('collected member digest mismatch');
      return Buffer.from(bytes);
    } });
  const capability = Object.freeze({}) as CollectedArtifactCapability;
  issued.set(capability, view); return capability;
}
