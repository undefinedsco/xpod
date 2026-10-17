import { collectedArtifactView } from './artifact-collector';
import { derivedSourceView } from './source-context';
import { registryArtifactView } from './registry-context';
import { consumerObservationView } from './consumer-context';
import { isDeepStrictEqual } from 'node:util';
import { verifyAdmission, type AdmissionContext } from './index';
import { MODULE_CATALOG, MODULE_TARGETS, modulePackageName } from '../../../packages/xpod-cli/src/module-catalog';
import type { CollectedArtifactIdentity, CollectedArtifactCapability, DerivedSourceCapability, CollectedArtifactView } from './artifact-contract';
import { createRequire } from 'node:module';
const { valid: exactVersion } = createRequire(import.meta.url)('semver');
const { MANIFEST_MAX_BYTES } = createRequire(import.meta.url)('../../workspace-package-payload.cjs');

const CLIENT = '@undefineds.co/xpod-client';
const CLI = '@undefineds.co/xpod-cli';
const fail = (message: string): never => { throw new Error('Independent publication: ' + message); };

/** Report classification only, never a capability or publication permit. The
 * caller below first obtains this observation from the private central issuer. */
export function describeRegistryConsumerStatus(observation: {
  readonly allProfilesVerified: boolean; readonly registryInstallVerified?: boolean; readonly scope: string;
} | undefined): { status: 'pending' | 'verified'; reason: string } {
  return observation?.allProfilesVerified && observation.registryInstallVerified === true
    ? { status: 'verified', reason: observation.scope }
    : { status: 'pending', reason: 'Actual isolated registry installation and complete public export profiles remain pending; local archive smoke is separate' };
}

export interface IndependentPublicationInput {
  client: unknown;
  cli: unknown;
  /** Each product owns its source revision. Independently released client SHA
   * need not equal CLI SHA; CLI must depend on its exact admitted version. */
  clientSource: unknown;
  cliSource: unknown;
  clientRegistry?: unknown;
  cliRegistry?: unknown;
  clientConsumer?: unknown;
  cliConsumer?: unknown;
  clientRegistryConsumer?: unknown;
  cliRegistryConsumer?: unknown;
}

/** Byte parsing only, not an artifact issuer. Operational callers first obtain
 * this reader from collectedArtifactView; no caller reader can grant admission. */
export function readPublicationManifest(view: Pick<CollectedArtifactView, 'readMember'>): Readonly<Record<string, any>> {
  const bytes = view.readMember('package.json', MANIFEST_MAX_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length > MANIFEST_MAX_BYTES) return fail('manifest exceeds central reader budget');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return fail('package manifest object required');
  return manifest;
}

/** Types and JSON never issue publication authority. All opaque inputs are re-read centrally. */
export interface PublicationProductBinding {
  readonly artifact: CollectedArtifactCapability;
  readonly source: DerivedSourceCapability;
  readonly prepublishConsumer?: unknown;
  readonly registry?: unknown;
  readonly postpublishConsumer?: unknown;
  readonly peers?: readonly CollectedArtifactCapability[];
  readonly dependencies?: readonly CollectedArtifactCapability[];
}
export interface ProductGroupPublicationInput {
  readonly schemaVersion: 2;
  readonly products: readonly PublicationProductBinding[];
  readonly registryDependencies?: readonly { readonly artifact: CollectedArtifactCapability; readonly registry: unknown }[];
}
export type IndependentPublicationRequest = IndependentPublicationInput | ProductGroupPublicationInput;
export interface PublicationProductDescriptor {
  readonly identity: CollectedArtifactIdentity;
  readonly manifest: Readonly<Record<string, any>>;
}

/** Structural manifest validation only, deliberately usable without capabilities.
 * This result always has mutationAllowed:false; the real planner re-reads central views. */
export function validatePublicationCohort(products: readonly PublicationProductDescriptor[], registryDependencies: readonly PublicationProductDescriptor[] = []) {
  if (!Array.isArray(products) || !products.length || products.length > 128 || registryDependencies.length > 128) fail('publication cohort size invalid');
  const nodes = new Map<string, PublicationProductDescriptor>();
  const families = new Map<string, PublicationProductDescriptor[]>();
  for (const product of products) {
    const { identity, manifest } = product;
    if (!identity || manifest?.name !== identity.package || manifest.version !== identity.version
      || exactVersion(identity.version) !== identity.version || !/^[a-f0-9]{40}$/u.test(identity.sourceSha)
      || nodes.has(identity.package)) fail('duplicate or mismatched manifest identity');
    const module = MODULE_CATALOG.find(row => identity.package.startsWith(row.packagePrefix + '-'));
    if (module) {
      const target = MODULE_TARGETS.find(row => `${row.platform}-${row.arch}` === identity.target);
      if (!target || modulePackageName(module.id, target.platform, target.arch) !== identity.package
        || manifest.xpodModule?.id !== module.id || manifest.xpodModule.platform !== target.platform
        || manifest.xpodModule.arch !== target.arch) fail('module manifest/target mismatch');
      const family = families.get(module.id) ?? []; family.push(product); families.set(module.id, family);
    } else if (![CLIENT, CLI].includes(identity.package) || identity.target !== undefined || manifest.xpodModule !== undefined) {
      fail('unregistered publication family');
    }
    nodes.set(identity.package, product);
  }
  for (const [family, rows] of families) {
    if (rows.length !== MODULE_TARGETS.length || new Set(rows.map(row => row.identity.target)).size !== MODULE_TARGETS.length)
      fail(family + ' requires every canonical target');
    if (new Set(rows.map(row => row.identity.version)).size !== 1 || new Set(rows.map(row => row.identity.sourceSha)).size !== 1)
      fail(family + ' targets must share exact version and source');
  }
  const external = new Map<string, PublicationProductDescriptor>();
  for (const row of registryDependencies) {
    if (!row.identity || row.manifest?.name !== row.identity.package || row.manifest.version !== row.identity.version
      || exactVersion(row.identity.version) !== row.identity.version || nodes.has(row.identity.package) || external.has(row.identity.package))
      fail('duplicate or invalid admitted registry dependency');
    external.set(row.identity.package, row);
  }
  const edges = new Map<string, Set<string>>();
  for (const [name, { manifest }] of nodes) {
    const dependencies = new Map<string, string>();
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const rows = manifest[field] ?? {};
      if (!rows || typeof rows !== 'object' || Array.isArray(rows)) fail('invalid manifest dependencies');
      for (const [dependency, version] of Object.entries(rows)) {
        if (field === 'peerDependencies' && manifest.peerDependenciesMeta?.[dependency]?.optional === true) continue;
        const spec = typeof version === 'string' ? version : fail('invalid manifest dependency version');
        if (!dependency.startsWith('@undefineds.co/')) continue;
        if (dependencies.has(dependency) && dependencies.get(dependency) !== spec) fail('conflicting manifest dependency pins');
        dependencies.set(dependency, spec);
      }
    }
    const required = new Set<string>();
    for (const [dependency, version] of dependencies) {
      const row = nodes.get(dependency) ?? external.get(dependency);
      if (!row || version !== row.identity.version || exactVersion(version) !== version) fail('missing or incompatible exact dependency: ' + dependency);
      if (nodes.has(dependency)) required.add(dependency);
    }
    edges.set(name, required);
  }
  const order: string[] = []; const visiting = new Set<string>(); const visited = new Set<string>();
  function visit(name: string): void {
    if (visiting.has(name)) fail('publication dependency cycle');
    if (visited.has(name)) return;
    visiting.add(name); for (const dependency of [...edges.get(name)!].sort()) visit(dependency);
    visiting.delete(name); visited.add(name); order.push(name);
  }
  for (const name of [...nodes.keys()].sort()) visit(name);
  return Object.freeze({ mutationAllowed: false as const, order: Object.freeze(order),
    groups: Object.freeze([...families].sort(([a], [b]) => a.localeCompare(b)).map(([family, rows]) => Object.freeze({ family,
      version: rows[0].identity.version, sourceSha: rows[0].identity.sourceSha,
      channel: rows[0].identity.version.includes('-') ? 'next' as const : 'latest' as const,
      targets: Object.freeze(rows.map(row => row.identity.target!).sort()) }))),
    dependencies: Object.freeze(Object.fromEntries([...edges].map(([name, dependencies]) => [name, Object.freeze([...dependencies].sort())]))) });
}

/** Snapshot every array before any asynchronous work. No caller's assertion is an issuer. */
export function normalizePublicationInput(input: IndependentPublicationRequest) {
  const group = 'schemaVersion' in input;
  if (group && (input.schemaVersion !== 2 || !Array.isArray(input.products)
    || Object.keys(input).some(key => !['schemaVersion', 'products', 'registryDependencies'].includes(key)))) fail('invalid product group input');
  const products = group ? input.products : [
    { artifact: input.client, source: input.clientSource, prepublishConsumer: input.clientConsumer, registry: input.clientRegistry, postpublishConsumer: input.clientRegistryConsumer },
    { artifact: input.cli, source: input.cliSource, prepublishConsumer: input.cliConsumer, registry: input.cliRegistry, postpublishConsumer: input.cliRegistryConsumer },
  ];
  const bindings = Object.freeze(products.map(row => Object.freeze({ artifact: row.artifact, source: row.source,
    prepublishConsumer: row.prepublishConsumer, registry: row.registry, postpublishConsumer: row.postpublishConsumer,
    peers: Object.freeze([...('peers' in row ? row.peers ?? [] : [])]),
    dependencies: Object.freeze([...('dependencies' in row ? row.dependencies ?? [] : [])]) })));
  const describe = (artifact: unknown): PublicationProductDescriptor => {
    const view = collectedArtifactView(artifact); if (!view) return fail('real central artifact capability required');
    return { identity: view.identity, manifest: readPublicationManifest(view) };
  };
  const registryDependencies = Object.freeze((group ? input.registryDependencies ?? [] : []).map(row => {
    const descriptor = describe(row.artifact); const registry = registryArtifactView(row.registry);
    if (!registry || !isDeepStrictEqual(registry.identity, descriptor.identity)) fail('real matching registry dependency capability required');
    return Object.freeze({ artifact: row.artifact, registry: row.registry });
  }));
  const descriptors = bindings.map(row => {
    const descriptor = describe(row.artifact); const source = derivedSourceView(row.source);
    if (!source || source.sourceSha !== descriptor.identity.sourceSha) fail('each product requires its own derived source capability');
    for (const peer of [...row.peers, ...row.dependencies]) describe(peer);
    return descriptor;
  });
  const cohort = validatePublicationCohort(descriptors, registryDependencies.map(row => describe(row.artifact)));
  return Object.freeze({ bindings, registryDependencies, cohort, legacy: !group });
}

/** Read-only dependency ordering. This is deliberately not a publication permit:
 * Complete consumer profiles and legal clearance remain required centrally.
 * No injected transport, callback, serialized status, or test fixture can advance
 * the registry-consumer/tag boundary. A controlled observer/consumer issuer must
 * be connected to that registry before a mutating publisher can use this plan. */
export function planIndependentPublication(request: IndependentPublicationRequest) {
  const normalized = normalizePublicationInput(request);
  if (!normalized.legacy) {
    // No generic archive reader or registry-installed module consumer can be invented here.
    // Until the shared interfaces are connected, even structurally complete groups stay pending.
    const gaps = ['group-publication: central product material/axis and fixed registry-consumer integration pending'];
    return { status: 'blocked' as const, prepublishEligible: false, products: [], order: normalized.cohort.order,
      cohort: normalized.cohort, mutationAllowed: false as const, gaps,
      tagPromotion: { status: 'pending' as const, mutationAllowed: false as const } };
  }
  const input = request as IndependentPublicationInput;
  const client = collectedArtifactView(input.client);
  const cli = collectedArtifactView(input.cli);
  if (!client || !cli) return fail('real central CLI and client artifact capabilities required');
  if (client.identity.package !== CLIENT || cli.identity.package !== CLI
    || client.identity.target !== undefined || cli.identity.target !== undefined) fail('unexpected product identity');
  const manifest = readPublicationManifest(cli);
  if (manifest.name !== CLI || manifest.version !== cli.identity.version
    || manifest.dependencies?.[CLIENT] !== client.identity.version) fail('CLI must bind the exact admitted client version');
  const rows = [
    { role: 'client', view: client, capability: input.client, source: input.clientSource },
    { role: 'cli', view: cli, capability: input.cli, source: input.cliSource },
  ].map(({ role, view, capability, source }) => {
    const derived = derivedSourceView(source);
    if (!derived || derived.sourceSha !== view.identity.sourceSha) fail(role + ' requires its own derived source capability');
    const producer = JSON.parse(view.readProducerOriginal('result.json', 1024 * 1024).toString());
    if (!/^[a-f0-9]{40}$/u.test(producer.context?.eventHeadSha ?? '')) fail('missing original producer event head SHA');
    const product = producer.products?.[role];
    if (typeof product?.archive?.path !== 'string') fail('missing original product archive');
    const context: AdmissionContext = {
      ...view.identity, runHeadSha: producer.context?.eventHeadSha,
      archive: view.readProducerOriginal(product.archive.path, 8 * 1024 * 1024),
      collectedArtifact: capability, relatedArtifacts: [input.client, input.cli], derivedSource: source,
      consumerObservation: role === 'client' ? input.clientConsumer : input.cliConsumer,
      readOriginal: reference => view.readProducerOriginal(reference.path, 8 * 1024 * 1024),
      readTracked: derived!.readTracked, trackedPaths: derived!.trackedPaths,
    };
    const runtimeMaterials = { schemaVersion: 1, kind: 'independent-runtime-closure-materials', runtime: 'node',
      product: { sourceSha: view.identity.sourceSha, runHeadSha: context.runHeadSha,
        package: view.identity.package, version: view.identity.version,
        archive: { sha256: view.identity.archiveSha256, bytes: view.identity.archiveBytes, integrity: view.identity.integrity } }, metafiles: [] };
    const gates = (['source', 'runtime-closure', 'legal', 'consumer'] as const).map(gate => ({
      gate, result: verifyAdmission(gate, gate === 'source' ? producer : gate === 'runtime-closure' ? runtimeMaterials : undefined, context),
    }));
    const observationInput = role === 'client' ? input.clientRegistry : input.cliRegistry;
    const registry = registryArtifactView(observationInput);
    if (observationInput !== undefined && !registry) fail(role + ' registry observation must be a real central capability');
    if (registry && (registry.identity.package !== view.identity.package
      || registry.identity.version !== view.identity.version
      || registry.identity.sourceSha !== view.identity.sourceSha
      || registry.identity.integrity !== view.identity.integrity
      || registry.identity.archiveSha256 !== view.identity.archiveSha256
      || registry.identity.archiveBytes !== view.identity.archiveBytes)) fail(role + ' registry observation identity mismatch');
    const prepublishEligible = gates.every(({ result }) => result.status === 'verified');
    const postpublishInput = role === 'client' ? input.clientRegistryConsumer : input.cliRegistryConsumer;
    const consumer = consumerObservationView(postpublishInput);
    if (postpublishInput !== undefined && (!consumer || consumer.stage !== 'postpublish'
      || !isDeepStrictEqual(consumer.identity, view.identity))) fail(role + ' requires a matching postpublish consumer capability');
    if (consumer && !registry) fail(role + ' postpublish consumer requires its registry observation');
    // Local archive import smoke remains separate from registry installation.
    // A postpublish stage label plus matching bytes cannot upgrade that scope.
    const postpublishConsumer = describeRegistryConsumerStatus(consumer);
    return { role, identity: { ...view.identity }, gates, prepublishEligible,
      prepublishStatus: prepublishEligible ? 'eligible' as const : 'blocked' as const,
      registryReadback: registry ? 'verified' as const : 'pending' as const,
      postpublishConsumer };


  });
  const prepublishEligible = rows.every(row => row.prepublishEligible);
  const postpublishVerified = rows.every(row => row.registryReadback === 'verified'
    && row.postpublishConsumer.status === 'verified');
  const tagEligible = prepublishEligible && postpublishVerified;
  const gaps = rows.flatMap(row => [
    ...row.gates.filter(({ result }) => result.status !== 'verified')
      .map(({ gate, result }) => `${row.role}:${gate}: ${result.reason}`),
    ...(row.registryReadback === 'pending' ? [`${row.role}:registry-readback: observation pending`] : []),
    ...(row.postpublishConsumer.status !== 'verified'
      ? [`${row.role}:postpublish-consumer: ${row.postpublishConsumer.reason}`] : []),
  ]);
  return {
    status: prepublishEligible ? 'eligible-for-publication' as const : 'blocked' as const,
    prepublishEligible,
    products: rows,
    order: ['client-prepublish', 'client-staging', 'client-registry-consumer',
      'cli-prepublish', 'cli-staging', 'cli-registry-consumer', 'tag-promotion'] as const,
    // Neither this returned JSON nor a saved copy confers authority.
    mutationAllowed: false as const,
    gaps,
    tagPromotion: { status: tagEligible ? 'eligible' as const : 'pending' as const, mutationAllowed: false as const },
  };
}
