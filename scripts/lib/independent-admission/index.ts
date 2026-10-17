import {publicationLegalMaterials} from './publication-legal-materials';
import { githubOriginFacts } from './github-origin';
import { collectedArtifactView, publicationMaterialView, readCollectedPortableArchive } from './artifact-collector';
import { derivedSourceView } from './source-context';
import { consumerObservationView } from './consumer-context';
import { verifyRuntimeClosure, verifyCollectedRuntimeClosure } from './runtime-closure';
import { verifyNativeAdmission, verifyCollectedNativeAdmission } from './native-admission';
import { inspectModuleSourcePhases } from './module-source-phases';
import { verifyLegalAdmission } from './legal-admission';
import { verifyCliInputSet } from './source-rules';
import { verifyCollectedCliBuildExecution,portableSourceMaterialView,type CliExecutionFacts } from './source-execution';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

export type Gate = 'source' | 'native' | 'legal' | 'consumer' | 'runtime-closure';
export interface OriginalReference { path: string; sha256: string }
export interface AdmissionContext {
  sourceSha: string;
  runHeadSha: string;
  package: string;
  version: string;
  target?: string;
  archive: Buffer;
  readOriginal(reference: OriginalReference): Buffer;
  readTracked(path: string): Buffer;
  trackedPaths?: readonly string[];
  /** Opaque operational capability; never read from a serialized release input. */
  githubOrigin?: unknown;
  collectedArtifact?: unknown;
  relatedArtifacts?: readonly unknown[];
  derivedSource?: unknown;
  /** Issued only by the fixed, owned-process consumer observer. */
  consumerObservation?: unknown;
  /** Opaque central material capability, separate from native release approval. */
  nativeMaterials?: unknown;
  /** Private registry-original and module-source material handles; never approval JSON. */
  legalOriginals?: readonly unknown[];
  legalSourceMaterials?: unknown;
}
/** Large platform gates receive a real collected archive handle, never a
 * caller-supplied whole tgz Buffer. Existing portable adapter signatures stay compatible. */
export type CollectedAdmissionContext = Omit<AdmissionContext, 'archive'> & { collectedArtifact: unknown; archive?: never };

export interface SourceMaterialFacts {
  listedTrackedSourceBytesVerified: boolean;
  sourceInputSetVerified: boolean;
  generatedBuildManifestVerified: boolean;
  archiveInventoryBindingVerified: boolean;
  canonicalOutputBindingsVerified: boolean;
  compiledOutputDerivationVerified: boolean;
  githubRunArtifactObserved: boolean;
  artifactCustodyVerified: boolean;
  derivedSourceVerified: boolean;
  originAdmissionVerified: boolean;
  actualOwnedCommandClosureVerified: boolean;
  descendantClosureVerified: false;
  sourceQualified: boolean;
}
export interface AdmissionResult { status: 'pending' | 'verified'; reason: string; pending?: string[]; facts?: SourceMaterialFacts; details?: unknown }
interface Adapter {
  verify(evidence: any, context: AdmissionContext): AdmissionResult;
  verifyCollected?(evidence: unknown, context: CollectedAdmissionContext): AdmissionResult;
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const reject = (message: string): never => { throw new Error('Independent source admission: ' + message); };

/** Actual normal publication originals only. Structural validation does not
 * manufacture GitHub acquisition or execution authority from serialized JSON. */
const source: Adapter = {
  verify(evidence, context) {
    if (evidence?.sourceAuthority && (evidence.sourceAuthority.sourceCommit !== context.sourceSha
      || evidence.sourceAuthority.dirty !== false)) reject('source authority mismatch');
    if (evidence?.schemaVersion !== 1 || evidence.kind !== 'cli-publication-preparation-producer') {
      return { status: 'pending', reason: 'source-schema-unverified: no reviewed adapter for this original format' };
    }
    if (!['@undefineds.co/xpod-cli', '@undefineds.co/xpod-client'].includes(context.package) || context.target !== undefined) reject('cross-product producer');
    const collected = collectedArtifactView(context.collectedArtifact);
    const derived = derivedSourceView(context.derivedSource);
    if (collected && (collected.identity.sourceSha !== context.sourceSha || collected.identity.package !== context.package
      || collected.identity.version !== context.version || collected.identity.target !== context.target
      || collected.identity.archiveSha256 !== digest(context.archive))) reject('collected product identity mismatch');
    if (derived && derived.sourceSha !== context.sourceSha) reject('derived source identity mismatch');
    if (collected && !isDeepStrictEqual(evidence, JSON.parse(collected.readProducerOriginal('result.json', 1024 ** 2).toString()))) reject('producer evidence differs from collected original');
    const readOriginal = (reference: OriginalReference): Buffer => {
      if (!collected) return context.readOriginal(reference);
      const bytes = collected.readProducerOriginal(reference.path, 8 * 1024 ** 2);
      if (digest(bytes) !== reference.sha256) reject('collected original reference mismatch');
      return bytes;
    };
    const readTracked = derived ? derived.readTracked : context.readTracked;
    const trackedPaths = derived ? derived.trackedPaths : context.trackedPaths;
    const observed = evidence.context;
    if (!observed || observed.checkoutSha !== context.sourceSha || observed.eventHeadSha !== context.runHeadSha || observed.workingTreeDirty !== false) reject('source authority mismatch');
    if (observed.environment !== 'github-actions' || !/^[1-9]\d*$/u.test(observed.runId ?? '')
      || !/^[1-9]\d*$/u.test(observed.runAttempt ?? '')) reject('invalid producer run coordinate');
    if (evidence.status !== 'prepared-not-published' || evidence.published !== false) reject('invalid publication producer status');
    const product = evidence.products?.[context.package.endsWith('-cli') ? 'cli' : 'client'];
    if (!product || product.package !== context.package || product.version !== context.version
      || product.archive?.sha256 !== digest(context.archive) || product.archive.bytes !== context.archive.length
      || product.archive.integrity !== 'sha512-' + createHash('sha512').update(context.archive).digest('base64')) reject('source/product/archive binding mismatch');
    const inventory = JSON.parse(readOriginal(evidence.inventory).toString());
    if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.files) || !inventory.files.length) reject('missing producer inventory');
    const originals = new Map<string, Buffer>(),originalPaths=new Set<string>();
    for (const row of inventory.files) {
      if (!row || typeof row.path !== 'string' || !row.path || row.path.includes('\\')
        || row.path.startsWith('/') || row.path.split('/').some((part: string) => !part || part === '.' || part === '..')
        || originalPaths.has(row.path) || !Number.isSafeInteger(row.bytes) || row.bytes < 0) reject('invalid producer inventory');
      originalPaths.add(row.path);
      if(row.path.startsWith('source-materials/')){
        const registered=collected?.producerOriginals.find(member=>member.path===row.path);
        if(!registered||registered.bytes!==row.bytes||registered.sha256!==row.sha256)reject('source original absent from authenticated acquired inventory');
        continue;
      }
      const bytes = readOriginal(row);
      if (bytes.length !== row.bytes) reject('producer original size mismatch');
      originals.set(row.path, bytes);
    }
    const bound = (reference: OriginalReference): Buffer => {
      const bytes = readOriginal(reference);
      if (!originals.get(reference.path)?.equals(bytes)) reject('producer inventory binding mismatch');
      return bytes;
    };
    const inputs = JSON.parse(bound(evidence.sourceInputs).toString());
    if (inputs.schemaVersion !== 1 || JSON.stringify(inputs.context) !== JSON.stringify(observed)
      || !Array.isArray(inputs.files) || !inputs.files.length) reject('missing producer build inputs');
    const seen = new Set<string>();
    for (const row of inputs.files) {
      if (!row || typeof row.path !== 'string' || !row.path || row.path.includes('\\') || row.path.startsWith('/')
        || row.path.split('/').some((part: string) => !part || part === '.' || part === '..') || seen.has(row.path)) reject('invalid build input inventory');
      seen.add(row.path);
      const bytes = readTracked(row.path);
      if (bytes.length !== row.bytes || digest(bytes) !== row.sha256) reject('build input differs from exact Git source');
    }
    const rules = trackedPaths
      ? verifyCliInputSet(inputs.files, inputs.generatedBuildManifest, readTracked, trackedPaths)
      : { sourceInputSetVerified: false, generatedBuildManifestVerified: false, pending: 'source-input-set-unverified: trusted tracked tree listing unavailable' };
    // Bind these original materials, without mistaking them for a complete
    // compilation graph or claiming that the workflow actually executed them.
    const producerIndex = bound(evidence.producerIndex); bound(evidence.preparation);
    const views = [collected, ...(context.relatedArtifacts ?? []).map(collectedArtifactView)].filter(view => view !== undefined);
    const products = new Map<'cli' | 'client', NonNullable<typeof collected>>();
    for (const role of ['cli', 'client'] as const) {
      const expected = evidence.products?.[role];
      const view = views.find(view => expected && view.identity.sourceSha === context.sourceSha
        && view.identity.package === expected.package && view.identity.version === expected.version
        && view.identity.archiveSha256 === expected.archive?.sha256);
      if (view) products.set(role, view);
    }
    const execution: CliExecutionFacts = collected && derived && products.size === 2
      ? verifyCollectedCliBuildExecution({artifact:context.collectedArtifact as import('./artifact-contract').CollectedArtifactCapability,
        source:context.derivedSource,relatedArtifacts:context.relatedArtifacts as readonly import('./artifact-contract').CollectedArtifactCapability[]|undefined})
      : { actualOwnedCommandClosureVerified: false, controlledBuildDerivationVerified: false,
        pending: ['execution-capabilities-missing: controlled CLI/client archives and derived source required'],
        scope: 'controlled approved commands, original inputs/outputs and owned groups; no escaped-session or reproducible-compilation attestation' };
    let canonicalOutputBindingsVerified = false;
    if (execution.controlledBuildDerivationVerified) {
      canonicalOutputBindingsVerified = true;
    } else if (rules.sourceInputSetVerified) {
      const cliProduct = evidence.products?.cli;
      const cliArchive = originals.get(cliProduct?.archive?.path);
      if (!cliArchive || digest(cliArchive) !== cliProduct.archive.sha256
        || cliProduct.archive.integrity !== 'sha512-' + createHash('sha512').update(cliArchive).digest('base64')) reject('CLI archive material mismatch');
      const require = createRequire(import.meta.url);
      const { inspectTarballBuffer } = require('../../workspace-package-payload.cjs');
      const inspected = inspectTarballBuffer(cliArchive);
      const exported = inspected.manifest.exports?.['./producer-materials'];
      if (typeof exported !== 'string' || !exported.startsWith('./')) reject('CLI source material entry absent');
      const indexPath = 'package/' + exported.slice(2);
      const embeddedIndex = inspected.entries.find((row: any) => row.path === indexPath && row.type === 'file');
      if (!embeddedIndex || !embeddedIndex.content.equals(producerIndex)) reject('embedded source index differs from producer original');
      const { verifyCanonicalPublicationInputs } = require('../../prepare-cli-publication.ts') as typeof import('../../prepare-cli-publication');
      // Existing canonical verifier compares original Git inputs and metafile /
      // output hashes; it explicitly does not prove a reproducible compilation.
      verifyCanonicalPublicationInputs(inspected.entries, JSON.parse(producerIndex.toString()), indexPath, context.sourceSha);
      canonicalOutputBindingsVerified = true;
    }
    if (!originals.get(product.archive.path)?.equals(context.archive)) reject('archive absent from producer inventory');
    const origin = githubOriginFacts(context.githubOrigin);
    if (origin && (origin.sourceSha !== context.sourceSha || origin.runHeadSha !== context.runHeadSha
      || String(origin.runId) !== observed.runId || String(origin.runAttempt) !== observed.runAttempt)) reject('observed run/attempt/source mismatch');
    const cleanupBytes = originals.get('cleanup.json');
    const cleanup = cleanupBytes ? JSON.parse(cleanupBytes.toString()) : undefined;
    const originAdmissionVerified = Boolean(collected && derived && rules.sourceInputSetVerified && rules.generatedBuildManifestVerified);
    const pending = [
      ...(!execution.actualOwnedCommandClosureVerified && (!cleanup || cleanup.descendantClosureVerified !== true)
        ? ['producer-descendant-closure-unverified: current original does not verify descendants; actual wait/close/process-group originals and verifier required']
        : !execution.actualOwnedCommandClosureVerified ? ['producer-descendant-closure-unverified: caller closure boolean is not independent execution authority'] : []),
      ...(!collected || !derived ? ['source-origin-unverified: collected artifact and derived source capabilities required'] : []),
      ...(rules.pending ? [rules.pending] : []),
      ...execution.pending,
      ...(collected&&execution.controlledBuildDerivationVerified&&portableSourceMaterialView(context.collectedArtifact)?.dependencySnapshotVerified!==true
        ? ['portable-source-snapshots-unverified: actual dependency/toolchain/source originals required'] : []),
      ...(collected&&execution.controlledBuildDerivationVerified
        ? (portableSourceMaterialView(context.collectedArtifact)?.outputs.length
          ? portableSourceMaterialView(context.collectedArtifact)!.pending
          : ['portable-bundle-input-originals-unresolved: actual complete bundle graphs required']) : []),
      ...(!collected ? ['producer-inventory-completeness-unverified: listed originals are bound but exact acquired artifact member set is not observed'] : []),
    ];
    const sourceQualified = originAdmissionVerified && execution.actualOwnedCommandClosureVerified
      && execution.controlledBuildDerivationVerified && pending.length === 0;
    return { status: sourceQualified ? 'verified' : 'pending', reason: pending.join('; ') || 'controlled-source-and-build-evidence-verified', pending, facts: {
      listedTrackedSourceBytesVerified: true, sourceInputSetVerified: rules.sourceInputSetVerified,
      generatedBuildManifestVerified: rules.generatedBuildManifestVerified, archiveInventoryBindingVerified: true,
      canonicalOutputBindingsVerified, compiledOutputDerivationVerified: execution.controlledBuildDerivationVerified,
      githubRunArtifactObserved: Boolean(origin || collected), artifactCustodyVerified: Boolean(collected), derivedSourceVerified: Boolean(derived),
      originAdmissionVerified, actualOwnedCommandClosureVerified: execution.actualOwnedCommandClosureVerified,
      descendantClosureVerified: false, sourceQualified,
    } };
  },
};

function legalGate(evidence: unknown, context: AdmissionContext | CollectedAdmissionContext): AdmissionResult {
  const bound=publicationLegalMaterials(context.collectedArtifact,context.derivedSource);
  const result = verifyLegalAdmission(evidence,{...context,legalOriginals:context.legalOriginals??bound?.originals});
  return { status: result.status, reason: result.reason, pending: result.pending, details:{...result.facts,coverage:result.coverage} };
}


function consumerGate(_evidence: unknown, context: AdmissionContext | CollectedAdmissionContext): AdmissionResult {
    const observation = consumerObservationView(context.consumerObservation);
    if (!observation) return { status: 'pending', reason: 'A real fixed consumer observation capability is required' };
    const identity = observation.identity;
    const collected = collectedArtifactView(context.collectedArtifact);
    const archiveIdentity = collected?.identity;
    const actual = Buffer.isBuffer(context.archive) ? { archiveSha256: digest(context.archive), archiveBytes: context.archive.length,
      integrity: 'sha512-' + createHash('sha512').update(context.archive).digest('base64') } : archiveIdentity;
    if (!actual) return { status: 'pending', reason: 'Real collected archive identity required' };
    if (identity.sourceSha !== context.sourceSha || identity.package !== context.package
      || identity.version !== context.version || identity.target !== context.target
      || identity.archiveSha256 !== actual.archiveSha256
      || identity.archiveBytes !== actual.archiveBytes
      || identity.integrity !== actual.integrity) reject('consumer observation product identity mismatch');
    if (observation.stage !== 'prepublish') return { status: 'pending', reason: 'Prepublish consumer observation required for this gate' };
    return observation.allProfilesVerified
      ? { status: 'verified', reason: 'Fixed Node/Bun public export consumer profiles verified; no remote Pod/auth/chat claim' }
      : { status: 'pending', reason: 'Complete public export consumer profiles remain pending; base import success is a separate observation' };
}

const collectedSourceReports = new WeakMap<object, WeakMap<object, any>>();
/** A module's reviewed source observer owns its private materials capability.
 * Cache only a completed real observation within this live process, allowing
 * sequential gate evaluation without rereading multi-GiB snapshots per axis. */
function inspectCollectedModuleSource(context: CollectedAdmissionContext): any {
  const artifact = collectedArtifactView(context.collectedArtifact), source = derivedSourceView(context.derivedSource);
  const material = publicationMaterialView(context.collectedArtifact);
  if (!artifact || !source || !material || typeof context.collectedArtifact !== 'object' || typeof context.derivedSource !== 'object') return {
    status: 'pending', reason: 'Controlled module producer and immutable Git source required' };
  const artifactKey = context.collectedArtifact as object, sourceKey = context.derivedSource as object;
  const cache = collectedSourceReports.get(artifactKey), cached = cache?.get(sourceKey);
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  let adapter: { inspectModuleSourceAdmission(input: { artifact: unknown; source: unknown; origin: unknown }): any };
  try { adapter = require('./module-source-admission.ts'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    const phases = inspectModuleSourcePhases({ artifact: context.collectedArtifact, source: context.derivedSource, origin: material.origin });
    return { status: 'pending', reason: phases.status === 'pending' ? phases.reason : 'Reviewed full module source adapter unavailable', phases };
  }
  const report = adapter.inspectModuleSourceAdmission({ artifact: context.collectedArtifact, source: context.derivedSource, origin: material.origin });
  if (report.status === 'verified' && report.sourceQualified === true && report.materials) {
    const reports = cache ?? new WeakMap<object, any>(); reports.set(sourceKey, report); collectedSourceReports.set(artifactKey, reports);
  }
  return report;
}

/** Getter only for a completed source observation in this process. No caller
 * report, JSON receipt or boolean can create a source material capability. */
export function collectedPublicationSourceMaterials(artifact:unknown,source:unknown):unknown{
  if(!collectedArtifactView(artifact)||!derivedSourceView(source)||!artifact||typeof artifact!=='object'||!source||typeof source!=='object')return undefined;
  if(collectedArtifactView(artifact)!.identity.target===undefined)return portableSourceMaterialView(artifact)?artifact:undefined;
  return collectedSourceReports.get(artifact)?.get(source)?.materials;
}

/** One gate registry. Product identities remain in the existing module catalog.
 * Unimplemented adapters must stay fail closed; arbitrary approval booleans have
 * no meaning here. No public token constructor or caller transport grants trust. */
const adapters: Readonly<Record<Gate, Adapter>> = Object.freeze<Record<Gate, Adapter>>({
  source: { ...source, verifyCollected: (_evidence, context) => {
    const report = inspectCollectedModuleSource(context);
    return { status: report.status, reason: report.reason, details: report };
  } },
  'runtime-closure': { verify: (evidence, context) => {
    const result = verifyRuntimeClosure(evidence, context);
    return { status: result.status, reason: result.reason, pending: [...result.pending] };
  }, verifyCollected: (evidence, context) => {
    const result = verifyCollectedRuntimeClosure(evidence, context);
    return { status: result.status, reason: result.reason, pending: [...result.pending], details: result.facts };
  } },
  native: { verify: (evidence, context) => {
    const result = verifyNativeAdmission(evidence, context);
    return { status: result.status, reason: result.reason, pending: [...result.pending] };
  }, verifyCollected: (evidence, context) => {
    const result = verifyCollectedNativeAdmission(evidence, context);
    return { status: result.status, reason: result.reason, pending: [...result.pending], details: result.facts };
  } },
  legal: { verify: legalGate, verifyCollected: legalGate },
  consumer: { verify: consumerGate, verifyCollected: consumerGate },
});
export function verifyAdmission(gate: Gate, evidence: unknown, context: AdmissionContext | CollectedAdmissionContext): AdmissionResult {
  if (!Object.prototype.hasOwnProperty.call(adapters, gate)) throw new Error('Unknown independent admission gate');
  if (!Buffer.isBuffer(context.archive)) return verifyCollectedAdmission(gate, evidence, context as CollectedAdmissionContext);
  return adapters[gate].verify(evidence, context as AdmissionContext);
}

export function verifyCollectedAdmission(gate: Gate, evidence: unknown, context: CollectedAdmissionContext): AdmissionResult {
  if (!Object.prototype.hasOwnProperty.call(adapters, gate)) throw new Error('Unknown independent admission gate');
  const collected = collectedArtifactView(context.collectedArtifact);
  if (!collected) return { status: 'pending', reason: 'Real collected archive capability required for bounded admission' };
  const identity = collected.identity;
  if (identity.sourceSha !== context.sourceSha || identity.package !== context.package || identity.version !== context.version
    || identity.target !== context.target) reject('collected admission product identity mismatch');
  if (identity.target === undefined) return adapters[gate].verify(evidence, { ...context, archive: readCollectedPortableArchive(context.collectedArtifact) });
  const adapter = adapters[gate];
  if (adapter.verifyCollected) return adapter.verifyCollected(evidence, context);
  return { status: 'pending', reason: `Bounded collected ${gate} adapter required for platform product; portable consumer or archive Buffer is not a substitute` };
}

export interface CollectedPublicationAdmissionInput {
  artifact: unknown;
  derivedSource: unknown;
  consumerObservation?: unknown;
  relatedArtifacts: readonly unknown[];
  nativeMaterials?: unknown;
  /** Private registry-original and module-source material handles; never approval JSON. */
  legalOriginals?: readonly unknown[];
  legalSourceMaterials?: unknown;
}

/** The publisher supplies opaque handles only. This central entry derives
 * product coordinates and producer evidence; no guessed result.json or fake
 * empty archive is accepted from the publication orchestrator. */
export function verifyCollectedPublicationAdmission(gate: Gate, input: CollectedPublicationAdmissionInput): AdmissionResult {
  if (!Object.prototype.hasOwnProperty.call(adapters, gate)) throw new Error('Unknown independent admission gate');
  const artifact = collectedArtifactView(input.artifact), material = publicationMaterialView(input.artifact);
  if (!artifact || !material) return { status: 'pending', reason: 'Controlled publication material capability required' };
  const source = derivedSourceView(input.derivedSource), identity = artifact.identity;
  if (source && source.sourceSha !== identity.sourceSha) reject('publication source capability identity mismatch');
  const context: CollectedAdmissionContext = {
    sourceSha: identity.sourceSha, runHeadSha: material.producer.runHeadSha,
    package: identity.package, version: identity.version, target: identity.target,
    collectedArtifact: input.artifact, derivedSource: input.derivedSource, relatedArtifacts: input.relatedArtifacts,
    githubOrigin: material.origin, consumerObservation: input.consumerObservation, nativeMaterials: input.nativeMaterials,
    legalOriginals: input.legalOriginals, legalSourceMaterials: input.legalSourceMaterials,
    trackedPaths: source?.trackedPaths,
    readTracked: name => source ? source.readTracked(name) : reject('Immutable publication source capability required'),
    readOriginal: reference => {
      const bytes = material.readOriginal(reference.path, 8 * 1024 ** 2);
      if (digest(bytes) !== reference.sha256) reject('publication original digest mismatch');
      return bytes;
    },
  };
  if (gate === 'legal' && identity.target !== undefined) {
    const sourceReport = inspectCollectedModuleSource(context);
    if (sourceReport.status === 'verified') context.legalSourceMaterials = sourceReport.materials;
  }
  const evidence = gate === 'source'
    ? JSON.parse(material.readOriginal(material.producerReceipt.path, 4*1024 ** 2).toString()) : undefined;
  return verifyCollectedAdmission(gate, evidence, context);
}
