import { githubOriginFacts } from './github-origin';
import { collectedArtifactView } from './artifact-collector';
import { derivedSourceView } from './source-context';
import { verifyCliInputSet } from './source-rules';
import { verifyCliBuildExecution, type CliExecutionFacts } from './source-execution';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

export type Gate = 'source' | 'native' | 'legal' | 'consumer';
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
}
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
export interface AdmissionResult { status: 'pending' | 'verified'; reason: string; pending?: string[]; facts?: SourceMaterialFacts }
interface Adapter { verify(evidence: any, context: AdmissionContext): AdmissionResult }
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
    const originals = new Map<string, Buffer>();
    for (const row of inventory.files) {
      if (!row || typeof row.path !== 'string' || !row.path || row.path.includes('\\')
        || row.path.startsWith('/') || row.path.split('/').some((part: string) => !part || part === '.' || part === '..')
        || originals.has(row.path) || !Number.isSafeInteger(row.bytes) || row.bytes < 0) reject('invalid producer inventory');
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
      ? verifyCliBuildExecution({ producer: evidence, readProducerOriginal: collected.readProducerOriginal,
        readTracked: derived.readTracked, trackedPaths: derived.trackedPaths,
        archiveMembers: role => products.get(role)!.members.map(row => ({ path: 'package/' + row.path,
          type: 'file', size: row.bytes, mode: row.mode, sha256: row.sha256 })),
        readArchiveMember: (role, name, maximum) => {
          if (!name.startsWith('package/')) return reject('unexpected collected archive member root');
          return products.get(role)!.readMember(name.slice('package/'.length), maximum);
        } })
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

/** One gate registry. Product identities remain in the existing module catalog.
 * Unimplemented adapters must stay fail closed; arbitrary approval booleans have
 * no meaning here. No public token constructor or caller transport grants trust. */
const adapters: Readonly<Record<Gate, Adapter>> = Object.freeze<Record<Gate, Adapter>>({
  source,
  native: { verify: evidence => ({ status: 'pending', reason: evidence?.status === 'material-integrity-verified' && evidence.externalAdmission === 'pending'
    ? 'Native materials are internally bound; external admission remains pending'
    : 'No authoritative independent release admission verifier exists for this evidence format' }) },
  legal: { verify: evidence => ({ status: 'pending', reason: evidence?.schemaVersion === 1 && evidence.status === 'original-material-collection' && evidence.legalClearance === false
    ? 'Original terms inventory explicitly does not confer legal clearance'
    : 'No authoritative independent release admission verifier exists for this evidence format' }) },
  consumer: { verify: () => ({ status: 'pending', reason: 'No authoritative independent release admission verifier exists for this evidence format' }) },
});
export function verifyAdmission(gate: Gate, evidence: unknown, context: AdmissionContext): AdmissionResult {
  if (!Object.prototype.hasOwnProperty.call(adapters, gate)) throw new Error('Unknown independent admission gate');
  return adapters[gate].verify(evidence, context);
}
