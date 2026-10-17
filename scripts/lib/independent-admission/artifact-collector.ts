import {sharedSourceLifetime} from './shared-source-lifetime';
import moduleLimits from '../module-artifact-limits.json';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { verifyAcquiredMetadata } from '../../acquire-independent-product-input';
import { projectCliPublicationInput } from '../../project-cli-publication-input';
import { githubOriginFacts, githubOriginOriginals, type GitHubOriginObservation } from './github-origin';
import type { CollectedArtifactCapability, CollectedArtifactView, CollectedArtifactMember, PublicationMaterialView } from './artifact-contract';

type PortableSourceSnapshot={originals:NonNullable<Awaited<ReturnType<typeof import('./module-source-originals')['collectModuleSourceOriginals']>>>;lifetime:ReturnType<typeof sharedSourceLifetime>};
const portableSourceSnapshots=new WeakMap<object,PortableSourceSnapshot>();
const issued = new WeakMap<object, CollectedArtifactView>();
const disposers = new WeakMap<object, () => void>();
const sourceCompactors = new WeakMap<object, () => void>();
type PublicationArchiveSource = { kind: 'buffer'; bytes: Buffer } | { kind: 'file'; path: string };
interface PublicationBinding { origin: GitHubOriginObservation; producerReceiptPath: string; source: PublicationArchiveSource; projectionOutput: string }
const publicationBindings = new WeakMap<object, { view: PublicationMaterialView; binding: PublicationBinding }>();
const require = createRequire(import.meta.url);
const { withOwnedTempRoot } = require('../owned-temp-root.cjs');
const { inspectArtifact } = require('../product-artifact-command.cjs');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => { throw new Error('Independent artifact collector: ' + message); };

function readCustodyReceipt(root: string): Buffer {
  const file = path.join(root, 'receipt.json'), stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 ** 2) return fail('bounded ordinary custody receipt required');
  const bytes = readFileSync(file);
  if (bytes.length !== stat.size || bytes.length > 16 * 1024 ** 2) return fail('custody receipt changed');
  return bytes;
}

export function collectedArtifactView(value: unknown): CollectedArtifactView | undefined {
  return value !== null && typeof value === 'object' ? issued.get(value) : undefined;
}

export function publicationMaterialView(value: unknown): PublicationMaterialView | undefined {
  return value !== null && typeof value === 'object' && issued.has(value) ? publicationBindings.get(value)?.view : undefined;
}

/** Collector-owned projection locator for the fixed module lifecycle driver.
 * A path is not authority; callers must retain the real collected capability and
 * recheck its exact archives/originals before and after execution. */
export function collectedPublicationProjectionDirectory(artifact: unknown): string | undefined {
  return artifact && typeof artifact === 'object' && issued.has(artifact)
    ? publicationBindings.get(artifact)?.binding.projectionOutput : undefined;
}

/** Compatibility bridge for existing portable adapters only. Platform tgz
 * archives always use the bounded file/range contract, even when compressed small. */
export function readCollectedPortableArchive(artifact: unknown): Buffer {
  if (!artifact || typeof artifact !== 'object' || !issued.has(artifact)) return fail('real collected publication artifact required');
  const material = publicationBindings.get(artifact);
  if (!material || material.view.identity.target !== undefined || material.binding.source.kind !== 'buffer'
    || material.binding.source.bytes.length > 8 * 1024 ** 2) return fail('bounded portable archive binding required');
  const bytes = material.binding.source.bytes, identity = material.view.identity;
  if (bytes.length !== identity.archiveBytes || hash(bytes) !== identity.archiveSha256
    || 'sha512-' + createHash('sha512').update(bytes).digest('base64') !== identity.integrity) return fail('portable archive digest mismatch');
  return Buffer.from(bytes);
}

/** Whole-group read-only validation runs before any archive snapshot or
 * publication write; the shared archive helper owns every resource constant. */
export function preflightCollectedArchiveFiles(artifacts: readonly unknown[]): void {
  if (!Array.isArray(artifacts) || artifacts.length < 1 || artifacts.length > 64) return fail('bounded publication artifact group required');
  const rows = artifacts.map(artifact => {
    if (!artifact || typeof artifact !== 'object' || !issued.has(artifact)) return fail('real collected publication artifact required');
    const material = publicationBindings.get(artifact);
    if (!material) return fail('controlled publication archive binding required');
    return { source: material.binding.source, identity: material.view.identity };
  });
  const { preflightBoundPublicationArchiveFiles } = require('./publication-archive-file.ts') as typeof import('./publication-archive-file');
  preflightBoundPublicationArchiveFiles(rows);
}

/** The publisher consumes an exact, temporary read-only tgz instead of
 * guessing producer JSON paths or increasing a whole-archive Buffer limit. */
export async function withCollectedArchiveFile<T>(artifact: unknown,
  operation: (input: { readonly path: string; readonly identity: PublicationMaterialView['identity'] }) => Promise<T>): Promise<T> {
  if (!artifact || typeof artifact !== 'object' || !issued.has(artifact)) return fail('real collected publication artifact required');
  const material = publicationBindings.get(artifact);
  if (!material || typeof operation !== 'function') return fail('controlled publication archive binding required');
  const { withBoundPublicationArchiveFile } = await import('./publication-archive-file');
  const identity = material.view.identity;
  return withBoundPublicationArchiveFile(material.binding.source, identity, async ({ path }) => {
    if (!issued.has(artifact)) return fail('publication artifact revoked');
    return operation(Object.freeze({ path, identity }));
  });
}

/** Cleanup-only operation. The caller first finishes legal source reads and
 * compacts the reviewed source-material capability. A retained exact outer ZIP
 * must still exist before this helper removes its reconstructible projection. */
export function compactCollectedSourceOriginals(artifact: unknown): boolean {
  if (!artifact || typeof artifact !== 'object' || !issued.has(artifact)) return fail('real collected artifact required for compaction');
  const compact = sourceCompactors.get(artifact);
  if (!compact) return false;
  compact(); sourceCompactors.delete(artifact); return true;
}

/** Release disk snapshots once the complete admission/publication operation
 * finishes. Revocation also prevents a released token from issuing new views. */
export function releaseCollectedArtifact(capability: CollectedArtifactCapability): void {
  const dispose = disposers.get(capability);
  issued.delete(capability); disposers.delete(capability); publicationBindings.delete(capability); sourceCompactors.delete(capability); dispose?.();
}

/** Large-product adapters reuse the normal product projectors and the same
 * private issuer as CLI/client. Only a real observed platform origin can enter.
 * Source/native/legal/consumer gates remain independent of archive custody. */
export async function collectApiModuleAdmissionArtifact(input: {
  githubOrigin: unknown; acquisitionRoot: string; projectionOutput: string;
}): Promise<CollectedArtifactCapability> {
  return collectModuleAdmissionArtifact({ ...input, module: 'api' });
}

const moduleProjectors = {
  api: async () => (await import('../../project-api-product-input')).projectApiProductInput,
  css: async () => (await import('../../project-css-product-input')).projectCssProductInput,
  afs: async () => (await import('../../project-afs-product-input')).projectAfsProductInput,
} as const;

export async function collectModuleAdmissionArtifact(input: {
  module: 'api' | 'css' | 'afs'; githubOrigin: unknown; acquisitionRoot: string; projectionOutput: string;
}): Promise<CollectedArtifactCapability> {
  const origin = githubOriginFacts(input.githubOrigin);
  if (!Object.prototype.hasOwnProperty.call(moduleProjectors, input.module) || !origin
    || origin.workflowPath !== (input.module === 'afs' ? '.github/workflows/agentfs-module-mounted-acceptance.yml' : `.github/workflows/${input.module}-module-product.yml`) || !origin.target) return fail('controlled module platform origin required');
  const { productTarget } = await import('../../module-product-targets');
  if (input.module !== 'afs' && !productTarget(input.module, origin.target).nativeSourceAvailable) return fail('module native source unavailable');
  const root = path.resolve(input.acquisitionRoot);
  const receiptBytes = readCustodyReceipt(root);
  const custody = JSON.parse(receiptBytes.toString());
  verifyAcquiredMetadata(root, custody.metadata);
  if (custody.expectedSourceSha !== origin.sourceSha || custody.runHeadSha !== origin.runHeadSha
    || custody.runId !== origin.runId || custody.runAttempt !== origin.runAttempt
    || custody.artifactId !== origin.artifactId || custody.workflowPath !== origin.workflowPath
    || custody.archive?.sha256 !== origin.artifactSha256) return fail('observed module artifact/custody mismatch');
  const project = await moduleProjectors[input.module]();
  await project({ schemaVersion: 1, acquisitionRoot: root,
    custodyReceiptSha256: hash(receiptBytes), members: { producer: 'producer.receipt.json', archive: 'product.tgz', packRaw: 'evidence/pack.raw.log' } }, input.projectionOutput);
  const output = path.resolve(input.projectionOutput);
  const selections = input.module === 'afs'
    ? [ ['producer.receipt.json', 'producer.receipt.json'], ['product.tgz', 'product.tgz'] ] as const
    : [ ['producer.receipt.json', 'producer.receipt.json'], ['product.tgz', 'product.tgz'], ['evidence/pack.raw.log', 'pack.raw.log'] ] as const;
  const originals = selections.map(([name, destination]) => {
    const rows = custody.inventory.members.filter((row: any) => row.path === name && row.kind === 'file');
    if (rows.length !== 1) return fail('unique module original member required');
    return { row: rows[0] as CollectedArtifactMember, destination };
  });
  let phaseOriginals: import('./module-phase-originals').ModulePhaseOriginals | undefined;
  let sourceOriginals: Awaited<ReturnType<typeof import('./module-source-originals')['collectModuleSourceOriginals']>>;
  const readOriginal = (name: string, maximum: number): Buffer => {
    if (!Number.isSafeInteger(maximum) || maximum < 0) return fail('bounded module original required');
    if (sourceOriginals && name.startsWith('source-materials/')) return sourceOriginals.readSmall(name, Math.min(maximum, 8 * 1024 ** 2));
    if (phaseOriginals && /^evidence\/[a-z0-9-]+\.receipt\.json$/u.test(name)) return phaseOriginals.readSmallReceipt(name, Math.min(maximum, 1024 ** 2));
    const original = originals.find(item => item.row.path === name);
    if (!original || !Number.isSafeInteger(maximum) || maximum < 0 || original.row.bytes > maximum) return fail('bounded module original required');
    const file = path.join(output, original.destination), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== original.row.bytes) return fail('module original changed');
    const bytes = readFileSync(file);
    if (bytes.length !== original.row.bytes || hash(bytes) !== original.row.sha256) return fail('module original digest mismatch');
    return bytes;
  };
  const { indexProductArchiveOnDisk } = await import('./product-disk-inventory');
  const disk = await indexProductArchiveOnDisk(path.join(output, 'product.tgz'));
  try {
    const producer = JSON.parse(readOriginal('producer.receipt.json', 1024 ** 2).toString());
    if (producer.context?.target !== origin.target || producer.context?.actualCheckoutSha !== origin.sourceSha
      || producer.archive?.sha256 !== disk.archive.sha256 || producer.archive?.integrity !== disk.archive.integrity
      || producer.archive?.bytes !== disk.archive.bytes) return fail('module disk archive/producer mismatch');
    const { collectModulePhaseOriginals } = await import('./module-phase-originals');
    phaseOriginals = await collectModulePhaseOriginals({ archivePath: path.join(root, 'artifact.zip'),
      archiveSha256: origin.artifactSha256, inventory: custody.inventory, producer });
    const { collectModuleSourceOriginals } = await import('./module-source-originals');
    sourceOriginals = await collectModuleSourceOriginals({ archivePath: path.join(root, 'artifact.zip'),
      archiveSha256: origin.artifactSha256, inventory: custody.inventory, producer });
    const { MANIFEST_MAX_BYTES } = require('../../workspace-package-payload.cjs');
    const manifest = JSON.parse(disk.readMember('package.json', MANIFEST_MAX_BYTES).toString());
    const { verifyModuleProductInventory } = await import('./module-product-inventory');
    verifyModuleProductInventory({ module: input.module, target: origin.target, version: producer.context.version,
      manifest, members: disk.members });
    const capability = issueCollectedView(Object.freeze({
      identity: Object.freeze({ sourceSha: origin.sourceSha, package: manifest.name, version: manifest.version,
        target: origin.target, archiveSha256: disk.archive.sha256, integrity: disk.archive.integrity, archiveBytes: disk.archive.bytes }),
      members: disk.members, readMember: disk.readMember, readMemberRange: disk.readMemberRange, readBoundMemberRange: disk.readBoundMemberRange,
      producerOriginals: phaseOriginals.members,
      readProducerOriginal: readOriginal,
      readProducerOriginalRange(name: string, offset: number, length: number) {
        if (!sourceOriginals) return fail('registered source originals unavailable');
        return sourceOriginals.readRange(name, offset, length);
      },
    }), () => { sourceOriginals?.dispose(); disk.dispose(); }, { origin: input.githubOrigin as GitHubOriginObservation,
      projectionOutput: output, producerReceiptPath: 'producer.receipt.json', source: { kind: 'file', path: path.join(output, 'product.tgz') } });
    if (sourceOriginals) sourceCompactors.set(capability, sourceOriginals.compact);
    return capability;
  } catch (error) { sourceOriginals?.dispose(); disk.dispose(); throw error; }
}

/** Collect one exact dependency selected by the immutable publication lock.
 * The npm gitHead is retained as a registry source claim, not source admission.
 * No caller package/version/endpoint, transport or serialized plan issues trust. */
export async function collectRegistryPeerArtifact(input: {
  plan: unknown; requestKey: string;
}): Promise<CollectedArtifactCapability> {
  const { publicationPeerInputPlanView } = require('./peer-input-plan.ts') as typeof import('./peer-input-plan');
  const plan = publicationPeerInputPlanView(input.plan);
  if (!plan) return fail('real immutable publication peer plan capability required');
  const selected = plan.requests.filter(row => row.requestKey === input.requestKey);
  if (selected.length !== 1) return fail('one locked dependency request required');
  const request = selected[0]!;
  const registry = 'https://registry.npmjs.org/';
  const signal = AbortSignal.timeout(30_000);
  async function get(url: string, maximum: number): Promise<Buffer> {
    const parsed = new URL(url);
    if (parsed.origin !== registry.slice(0, -1) || parsed.username || parsed.password
      || parsed.search || parsed.hash) return fail('fixed registry original URL required');
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal });
    if (response.status !== 200 || !response.body) { void response.body?.cancel().catch(() => {}); return fail('registry original HTTP status ' + response.status); }
    const chunks: Buffer[] = []; let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const row = await reader.read(); if (row.done) break;
        size += row.value.length;
        if (size > maximum) return fail('registry original byte budget exceeded');
        chunks.push(Buffer.from(row.value));
      }
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    return Buffer.concat(chunks, size);
  }
  const metadataBytes = await get(registry + encodeURIComponent(request.package) + '/' + request.version, 256 * 1024);
  const metadata = JSON.parse(metadataBytes.toString());
  if (metadata.name !== request.package || metadata.version !== request.version
    || metadata.dist?.integrity !== request.integrity || !/^[a-f0-9]{40}$/u.test(metadata.gitHead ?? '')
    || typeof metadata.dist?.tarball !== 'string') return fail('locked registry metadata/source claim mismatch');
  const archive = await get(metadata.dist.tarball, 8 * 1024 ** 2);
  if ('sha512-' + createHash('sha512').update(archive).digest('base64') !== request.integrity) return fail('locked dependency archive SRI mismatch');
  const custody = Buffer.from(JSON.stringify({ kind: 'registry-dependency-originals', registry,
    package: request.package, version: request.version, integrity: request.integrity,
    lockOriginal: plan.lockOriginal, upstreamGitHeadClaim: metadata.gitHead,
    sourceVerified: false, legalVerified: false, consumerVerified: false }) + '\n');
  const originals = new Map([['registry.metadata.original.json', metadataBytes], ['dependency.tgz', archive], ['registry.custody.original.json', custody]]);
  const rows = Object.freeze([...originals].map(([name, bytes]) => Object.freeze({ path: name, sha256: hash(bytes), bytes: bytes.length, mode: 0o600 })));
  const read = (name: string, maximum: number): Buffer => {
    const bytes = originals.get(name);
    if (!Number.isSafeInteger(maximum) || maximum < 0 || !bytes || bytes.length > maximum) return fail('bounded registry original required');
    return Buffer.from(bytes);
  };
  return issueProductArchive(metadata.gitHead, { package: request.package, version: request.version,
    archive: { bytes: archive.length, sha256: hash(archive), integrity: request.integrity } }, archive, rows, read);
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
  const receiptBytes = readCustodyReceipt(root);
  const custody = JSON.parse(receiptBytes.toString('utf8'));
  verifyAcquiredMetadata(root, custody.metadata);
  if (custody.expectedSourceSha !== origin.sourceSha || custody.runHeadSha !== origin.runHeadSha
    || custody.runId !== origin.runId || custody.runAttempt !== origin.runAttempt
    || custody.artifactId !== origin.artifactId || custody.workflowPath !== origin.workflowPath
    || custody.archive?.sha256 !== origin.artifactSha256) fail('observed artifact/custody mismatch');
  const producerOriginals = new Map<string, Buffer>();
  const selected = custody.inventory.members.filter((row: any) => row.kind === 'file'&&!row.path.startsWith('source-materials/'));
  if (selected.length > 1000 || selected.some((row: any) => row.bytes > 8 * 1024 ** 2)
    || selected.reduce((total: number, row: any) => total + row.bytes, 0) > 16 * 1024 ** 2) fail('producer original resource bound exceeded');
  await withOwnedTempRoot('xpod-admission-originals-', async (temporary: string) => {
    const selections = selected.map((row: any) => ({ path: row.path, destination: row.path, bytes: row.bytes, sha256: row.sha256 }));
    const result = inspectArtifact([path.join(import.meta.dir, '../inspect-product-artifact.py'),
      path.join(root, 'artifact.zip'), origin.artifactSha256, String(moduleLimits.packedBytes), String(moduleLimits.expandedBytes),
      String(moduleLimits.members), '--selection-stdin', temporary, 'independent-source-originals'], {timeout:moduleLimits.timeoutMs,maxBuffer:32*1024**2,input:Buffer.from(JSON.stringify(selections))});
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
  const producer=JSON.parse(producerOriginals.get('result.json')!.toString());
  const {collectModuleSourceOriginals}=await import('./module-source-originals');
  const sourceOriginals=await collectModuleSourceOriginals({archivePath:path.join(root,'artifact.zip'),archiveSha256:origin.artifactSha256,inventory:custody.inventory,producer});
  const snapshot:PortableSourceSnapshot|undefined=sourceOriginals?{originals:sourceOriginals,lifetime:sharedSourceLifetime(sourceOriginals)}:undefined;
  const producerRows = Object.freeze(selected.map((row: any) => Object.freeze({ path: row.path, sha256: row.sha256, bytes: row.bytes, mode: row.mode ?? 0 })));
  try{return issueProductArchive(origin.sourceSha, row, archive, producerRows, (name, maximumBytes) => {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return fail('invalid original byte bound');
    const bytes = producerOriginals.get(name);
    const row = selected.find((item: any) => item.path === name);
    if (!bytes || !row || bytes.length > maximumBytes || hash(bytes) !== row.sha256) return fail('unique bounded producer original required');
    return Buffer.from(bytes);
  }, input.githubOrigin as GitHubOriginObservation, path.resolve(input.projectionOutput),snapshot);}catch(error){sourceOriginals?.dispose();throw error;}
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
  return issueProductArchive(view.identity.sourceSha, row, archive, view.producerOriginals, view.readProducerOriginal, publicationBindings.get(parent)?.binding.origin, publicationBindings.get(parent)?.binding.projectionOutput,portableSourceSnapshots.get(parent));
}

// Private issuer: only authenticated acquisition or a previously issued parent
// capability can reach this function. No JSON/hash-to-authority constructor.
function issueProductArchive(sourceSha: string, row: any, archive: Buffer,
  producerRows: readonly CollectedArtifactMember[], readProducerOriginal: CollectedArtifactView['readProducerOriginal'], origin?: GitHubOriginObservation, projectionOutput?: string,snapshot?:PortableSourceSnapshot): CollectedArtifactCapability {
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
    producerOriginals:Object.freeze([...new Map([...producerRows,...(snapshot?.originals.members??[])].map(row=>[row.path,row])).values()]),
    readProducerOriginal(name:string,maximum:number){return name.startsWith('source-materials/')&&snapshot?snapshot.originals.readSmall(name,maximum):readProducerOriginal(name,maximum);},
    ...(snapshot?{readProducerOriginalRange:(name:string,offset:number,length:number)=>snapshot.originals.readRange(name,offset,length)}:{}),
    readMember(name: string, maximumBytes: number): Buffer {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return fail('invalid member byte bound');
      const bytes = originals.get(name);
      if (!bytes || bytes.length > maximumBytes) return fail('unique bounded product member required');
      if (hash(bytes) !== memberHashes.get(name)) return fail('collected member digest mismatch');
      return Buffer.from(bytes);
    } });
  const release=snapshot?.lifetime.retain();
  let capability:CollectedArtifactCapability;
  try{capability=issueCollectedView(view,release, origin && projectionOutput ? { origin, projectionOutput, producerReceiptPath: 'result.json',
    source: { kind: 'buffer', bytes: Buffer.from(archive) } } : undefined);}catch(error){release?.();throw error;}
  if(snapshot){portableSourceSnapshots.set(capability,snapshot);sourceCompactors.set(capability,()=>snapshot.lifetime.compact());}
  return capability;
}

function issueCollectedView(view: CollectedArtifactView, dispose?: () => void, binding?: PublicationBinding): CollectedArtifactCapability {
  const capability = Object.freeze({}) as CollectedArtifactCapability;
  if (binding) {
    const origin = githubOriginFacts(binding.origin);
    const runOriginal = githubOriginOriginals(binding.origin).find(row => row.name === 'run.original.json');
    const run = runOriginal && JSON.parse(runOriginal.data.toString());
    const receipt = view.producerOriginals.find(row => row.path === binding.producerReceiptPath);
    if (!origin || origin.sourceSha !== view.identity.sourceSha || origin.target !== view.identity.target
      || !run || typeof run.event !== 'string' || typeof run.head_branch !== 'string' || !receipt) return fail('publication producer origin/material binding mismatch');
    publicationBindings.set(capability, { binding, view: Object.freeze({ origin: binding.origin, identity: view.identity,
      producer: Object.freeze({ sourceSha: origin.sourceSha, runHeadSha: origin.runHeadSha, event: run.event, headBranch: run.head_branch,
        workflowPath: origin.workflowPath, workflowSourceSha256: origin.workflowSourceSha256, runId: origin.runId,
        runAttempt: origin.runAttempt, artifactId: origin.artifactId, artifactSha256: origin.artifactSha256, jobId: origin.producerJobId }),
      producerReceipt: receipt, originals: view.producerOriginals,
      archive: Object.freeze({ bytes: view.identity.archiveBytes, sha256: view.identity.archiveSha256, integrity: view.identity.integrity }),
      readOriginal: view.readProducerOriginal,
    }) });
  }
  issued.set(capability, view);
  if (dispose) disposers.set(capability, dispose);
  return capability;
}

// Load the Bun-only publication execution graph only when an operation is requested.
export const preparePublicationGroup: typeof import('./publication-group').preparePublicationGroup = async input =>
  (await import('./publication-group')).preparePublicationGroup(input);
export const prepareRegistryConsumerProduct: typeof import('./publication-group').prepareRegistryConsumerProduct = async input =>
  (await import('./publication-group')).prepareRegistryConsumerProduct(input);
