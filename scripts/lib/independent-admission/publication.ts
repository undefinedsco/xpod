import { collectedArtifactView } from './artifact-collector';
import { derivedSourceView } from './source-context';
import { registryArtifactView } from './registry-context';
import { consumerObservationView } from './consumer-context';
import { isDeepStrictEqual } from 'node:util';
import { verifyAdmission, type AdmissionContext } from './index';

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

/** Read-only dependency ordering. This is deliberately not a publication permit:
 * Complete consumer profiles and legal clearance remain required centrally.
 * No injected transport, callback, serialized status, or test fixture can advance
 * the registry-consumer/tag boundary. A controlled observer/consumer issuer must
 * be connected to that registry before a mutating publisher can use this plan. */
export function planIndependentPublication(input: IndependentPublicationInput) {
  const client = collectedArtifactView(input.client);
  const cli = collectedArtifactView(input.cli);
  if (!client || !cli) return fail('real central CLI and client artifact capabilities required');
  if (client.identity.package !== CLIENT || cli.identity.package !== CLI
    || client.identity.target !== undefined || cli.identity.target !== undefined) fail('unexpected product identity');
  const manifest = JSON.parse(cli.readMember('package.json', 1024 * 1024).toString());
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
