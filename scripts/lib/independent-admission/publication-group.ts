import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { GroupPreparationDispatcher, PublicationProductSelector } from '../../run-independent-publication';
import { acquireIndependentProductInput, type ArtifactAcquisitionInput } from '../../acquire-independent-product-input';
import { observeCliGitHubOrigin } from './github-origin';
import { collectAdmissionArtifact, collectRelatedAdmissionArtifact, collectRegistryPeerArtifact, collectedArtifactView } from './artifact-collector';
import { deriveAdmissionSource } from './source-context';
import { collectPublicationPeerInputPlan, publicationPeerInputPlanView, type PublicationPeerInputPlanCapability } from './peer-input-plan';
import { observeClientConsumer, observeCliConsumer } from './consumer-context';
import { observeRegistryArtifactIfPublished } from './registry-context';
import type { CollectedArtifactCapability } from './artifact-contract';
const fail = (message: string): never => { throw Error('Central publication group: ' + message); };

/** Selectors identify immutable products only. Versions, approval flags, local
 * source paths, tags and caller-picked policy never enter the acquisition plan. */
export function validatePublicationGroupSelectors(selectors: readonly PublicationProductSelector[]): void {
  if (!Array.isArray(selectors) || selectors.length < 1 || selectors.length > 14) fail('bounded immutable product selectors required');
  const selected = new Set<string>(); let sourceSha: string | undefined;
  for (const selector of selectors) {
    if (!selector || typeof selector !== 'object' || Object.keys(selector).some(key => !['module', 'target', 'sourceSha', 'runHeadSha', 'runId', 'runAttempt', 'artifactId', 'artifactSha256'].includes(key))) fail('unknown product selector field');
    if (!['client', 'cli', 'api', 'css', 'afs'].includes(selector.module) || !/^[a-f0-9]{40}$/u.test(selector.sourceSha)
      || !/^[a-f0-9]{40}$/u.test(selector.runHeadSha) || !/^[a-f0-9]{64}$/u.test(selector.artifactSha256)
      || ![selector.runId, selector.runAttempt, selector.artifactId].every(value => Number.isSafeInteger(value) && value > 0)) fail('exact immutable product coordinates required');
    if (['client', 'cli'].includes(selector.module) ? selector.target !== undefined : !/^(?:linux|darwin)-(?:x64|arm64)$/u.test(selector.target ?? '')) fail('canonical product target required');
    if (sourceSha !== undefined && sourceSha !== selector.sourceSha) fail('one immutable source per publication group required');
    sourceSha = selector.sourceSha;
    const key = selector.module + ':' + (selector.target ?? 'portable');
    if (selected.has(key)) fail('duplicate product selector'); selected.add(key);
  }
}

/** The first implemented family uses the normal CLI producer and the existing
 * private source/peer/consumer issuers. Unsupported material axes remain explicit
 * pending before network acquisition; a report never becomes a capability. */
export const preparePublicationGroup: NonNullable<GroupPreparationDispatcher['preparePublicationGroup']> = async input => {
  validatePublicationGroupSelectors(input.selectors);
  if (!path.isAbsolute(input.checkout) || !path.isAbsolute(input.output) || fs.existsSync(input.output)) fail('canonical checkout and new absolute output required');
  const checkout = fs.realpathSync(input.checkout), sourceSha = input.selectors[0]!.sourceSha;
  const git = (args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
  if (git(['rev-parse', 'HEAD']) !== sourceSha || git(['status', '--porcelain', '--untracked-files=all'])) fail('clean exact source checkout required');
  const unsupported = input.selectors.filter(selector => selector.module !== 'client' && selector.module !== 'cli');
  if (unsupported.length) return { status: 'pending', pending: unsupported.map(selector =>
    `${selector.module}/${selector.target}: complete controlled normal-product, source, prepublish-consumer and native-material factory binding required`) };
  const tuple = (selector: PublicationProductSelector): ArtifactAcquisitionInput => ({ schemaVersion: 1,
    sourceSha: selector.sourceSha, runHeadSha: selector.runHeadSha, runId: selector.runId, runAttempt: selector.runAttempt,
    artifactId: selector.artifactId, artifactSha256: selector.artifactSha256 });
  const rows = input.selectors.map(tuple);
  if (rows.some(row => JSON.stringify(row) !== JSON.stringify(rows[0]))) fail('portable pair must use the same normal producer artifact');
  fs.mkdirSync(input.output, { mode: 0o700 });
  // Originals and fixed-consumer roots stay outside denied source checkouts.
  // Retain this locator for the lifetime of the returned process-local handles.
  const custody = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-central-publication-group-')); fs.chmodSync(custody, 0o700);
  fs.writeFileSync(path.join(input.output, 'custody-locator.json'), JSON.stringify({ directory: custody, sourceSha }) + '\n', { flag: 'wx', mode: 0o600 });
  const origin = await observeCliGitHubOrigin(rows[0]!, { token: input.token });
  const acquisitionRoot = path.join(custody, 'acquired'), projectionOutput = path.join(custody, 'projected');
  await acquireIndependentProductInput(rows[0]!, acquisitionRoot, { token: input.token });
  const cli = await collectAdmissionArtifact({ githubOrigin: origin, acquisitionRoot, projectionOutput, product: 'cli' });
  const client = collectRelatedAdmissionArtifact(cli, 'client');
  const sources = { cli: deriveAdmissionSource(cli, checkout), client: deriveAdmissionSource(client, checkout) };
  const peerPlan = collectPublicationPeerInputPlan({ cli, client, source: sources.cli });
  const plan = publicationPeerInputPlanView(peerPlan)!;
  const requests = new Map<string, CollectedArtifactCapability>();
  for (const request of plan.requests) requests.set(request.requestKey, await collectRegistryPeerArtifact({ plan: peerPlan, requestKey: request.requestKey }));
  const peerRequests = new Set(plan.edges.filter(edge => edge.kind === 'peer' && ['cli', 'client'].includes(edge.from))
    .map(edge => edge.package + '@' + edge.version));
  const peers = [...requests].filter(([key]) => peerRequests.has(key)).map(([, artifact]) => artifact);
  const dependencies = [...requests].filter(([key]) => !peerRequests.has(key)).map(([, artifact]) => artifact);
  const selected = new Set(input.selectors.map(selector => selector.module));
  const products = [];
  for (const role of ['client', 'cli'] as const) {
    if (!selected.has(role)) continue;
    const artifact = role === 'cli' ? cli : client;
    const manifest = JSON.parse(collectedArtifactView(artifact)!.readMember('package.json', 1024 * 1024).toString());
    const chosenPeers = peers.filter(value => role === 'cli' || Object.prototype.hasOwnProperty.call(manifest.peerDependencies ?? {}, collectedArtifactView(value)!.identity.package));
    const selectedPeerSet = new Set(chosenPeers);
    const allDependencies = [...dependencies, ...peers.filter(value => !selectedPeerSet.has(value))];
    const { bindPublicationConsumerPeerPlan } = await import('./consumer-context');
    bindPublicationConsumerPeerPlan(artifact, peerPlan);
    const evidenceDirectory = path.join(custody, role + '-prepublish-consumer');
    const prepublishConsumer = role === 'cli'
      ? await observeCliConsumer({ artifact, client, peers: chosenPeers, dependencies: allDependencies, peerPlan, stage: 'prepublish', evidenceDirectory })
      : await observeClientConsumer({ artifact, peers: chosenPeers, dependencies: allDependencies, peerPlan, stage: 'prepublish', evidenceDirectory });
    products.push(Object.freeze({ artifact, source: sources[role], prepublishConsumer,
      peerPlan, peers: Object.freeze(chosenPeers), dependencies: Object.freeze(allDependencies) }));
  }
  const registryDependencies = [];
  if (selected.has('cli') && !selected.has('client')) {
    const registry = await observeRegistryArtifactIfPublished(client);
    if (!registry) return { status: 'pending', pending: ['Exact collected client dependency must be selected for publication or already present in the fixed registry'] };
    registryDependencies.push(Object.freeze({ artifact: client, registry }));
  }
  for (const artifact of requests.values()) {
    const registry = await observeRegistryArtifactIfPublished(artifact);
    if (!registry) return { status: 'pending', pending: ['Exact immutable-lock peer disappeared from registry: ' + collectedArtifactView(artifact)!.identity.package] };
    registryDependencies.push(Object.freeze({ artifact, registry }));
  }
  return Object.freeze({ status: 'material-ready', products: Object.freeze(products), registryDependencies: Object.freeze(registryDependencies) });
};

export interface RegistryConsumerProductPreparationInput {
  readonly selectors: readonly PublicationProductSelector[];
  readonly module: 'client' | 'cli' | 'api' | 'css' | 'afs';
  readonly target?: string;
  readonly checkout: string;
  readonly output: string;
  readonly token?: string;
}
export interface RegistryConsumerProductMaterials {
  readonly status: 'material-ready';
  readonly peerPlan: PublicationPeerInputPlanCapability;
  readonly artifact: CollectedArtifactCapability;
  readonly client?: CollectedArtifactCapability;
  readonly peers: readonly CollectedArtifactCapability[];
  readonly dependencies: readonly CollectedArtifactCapability[];
}
export type RegistryConsumerProductPreparationResult = RegistryConsumerProductMaterials | { readonly status: 'pending'; readonly pending: readonly string[] };
/** Material-only bootstrap for a single matching-host registry worker. It does
 * not execute any consumer, native probe, publisher or gate and issues no permit. */
export async function prepareRegistryConsumerProduct(input: RegistryConsumerProductPreparationInput): Promise<RegistryConsumerProductPreparationResult> {
  validatePublicationGroupSelectors(input.selectors);
  const selector = input.selectors.find(row => row.module === input.module && row.target === input.target);
  if (!selector) return { status: 'pending', pending: ['Selected consumer product is absent from immutable group'] };
  if (!path.isAbsolute(input.checkout) || !path.isAbsolute(input.output) || fs.existsSync(input.output)) fail('absolute clean checkout and new material output required');
  const checkout = fs.realpathSync(input.checkout);
  const git = (args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
  if (git(['rev-parse', 'HEAD']) !== selector.sourceSha || git(['status', '--porcelain', '--untracked-files=all'])) fail('clean exact source checkout required');
  const portable = input.selectors.find(row => row.module === 'cli') ?? input.selectors.find(row => row.module === 'client');
  if (!portable) return { status: 'pending', pending: ['Normal CLI/client producer selector required for fixed registry consumer'] };
  const tuple = (row: PublicationProductSelector): ArtifactAcquisitionInput => ({ schemaVersion: 1, sourceSha: row.sourceSha,
    runHeadSha: row.runHeadSha, runId: row.runId, runAttempt: row.runAttempt, artifactId: row.artifactId, artifactSha256: row.artifactSha256 });
  const portablePair = input.selectors.filter(row => ['cli', 'client'].includes(row.module));
  if (portablePair.some(row => JSON.stringify(tuple(row)) !== JSON.stringify(tuple(portable)))) fail('normal CLI/client selectors must bind one real producer artifact');
  fs.mkdirSync(input.output, { mode: 0o700 });
  const custody = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-central-consumer-materials-')); fs.chmodSync(custody, 0o700);
  fs.writeFileSync(path.join(input.output, 'custody-locator.json'), JSON.stringify({ directory: custody, sourceSha: selector.sourceSha }) + '\n', { flag: 'wx', mode: 0o600 });
  const origin = await observeCliGitHubOrigin(tuple(portable), { token: input.token });
  const acquisitionRoot = path.join(custody, 'portable-acquired'), projectionOutput = path.join(custody, 'portable-projected');
  await acquireIndependentProductInput(tuple(portable), acquisitionRoot, { token: input.token });
  const cli = await collectAdmissionArtifact({ githubOrigin: origin, acquisitionRoot, projectionOutput, product: 'cli' });
  const client = collectRelatedAdmissionArtifact(cli, 'client');
  const source = deriveAdmissionSource(cli, checkout); deriveAdmissionSource(client, checkout);
  let artifact = input.module === 'client' ? client : cli;
  if (input.module === 'api' || input.module === 'css' || input.module === 'afs') {
    const { observeModuleProductGitHubOrigin, observeAfsModuleProductGitHubOrigin } = await import('./github-origin');
    const { collectModuleAdmissionArtifact } = await import('./artifact-collector');
    const moduleOrigin = input.module === 'afs'
      ? await observeAfsModuleProductGitHubOrigin(tuple(selector), input.target!, { token: input.token })
      : await observeModuleProductGitHubOrigin(tuple(selector), input.module, input.target!, { token: input.token });
    const acquired = path.join(custody, 'module-acquired');
    await acquireIndependentProductInput(tuple(selector), acquired, { token: input.token });
    artifact = await collectModuleAdmissionArtifact({ module: input.module, githubOrigin: moduleOrigin,
      acquisitionRoot: acquired, projectionOutput: path.join(custody, 'module-projected') });
    deriveAdmissionSource(artifact, checkout);
  }
  const peerPlan = collectPublicationPeerInputPlan({ cli, client, source }), plan = publicationPeerInputPlanView(peerPlan)!;
  const reachable = new Set(input.module === 'client' ? ['client'] : ['cli', 'client']);
  const requestKeys = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of plan.edges) if (reachable.has(edge.from) && edge.version) {
      requestKeys.add(edge.package + '@' + edge.version);
      if (edge.lockKey && !reachable.has(edge.lockKey)) { reachable.add(edge.lockKey); changed = true; }
    }
  }
  const selectedRequests = plan.requests.filter(request => requestKeys.has(request.requestKey));
  const handles = new Map<string, CollectedArtifactCapability>();
  for (const request of selectedRequests) handles.set(request.requestKey, await collectRegistryPeerArtifact({ plan: peerPlan, requestKey: request.requestKey }));
  const rootRoles = input.module === 'client' ? ['client'] : ['cli', 'client'];
  const peerKeys = new Set(plan.edges.filter(edge => edge.kind === 'peer' && rootRoles.includes(edge.from))
    .map(edge => edge.package + '@' + edge.version));
  const peers = [...handles].filter(([key]) => peerKeys.has(key)).map(([, handle]) => handle);
  const dependencies = [...handles].filter(([key]) => !peerKeys.has(key)).map(([, handle]) => handle);
  const { bindPublicationConsumerPeerPlan } = await import('./consumer-context');
  bindPublicationConsumerPeerPlan(artifact, peerPlan);
  return Object.freeze({ status: 'material-ready', peerPlan, artifact, ...(input.module === 'client' ? {} : { client }), peers: Object.freeze(peers),
    dependencies: Object.freeze(input.module === 'api' || input.module === 'css' || input.module === 'afs' ? [cli, client, ...dependencies] : dependencies) });
}
