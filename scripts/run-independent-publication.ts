import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, copyFileSync, chmodSync, appendFileSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { acquireIndependentProductInput, assertNewAcquisitionOutput, type ArtifactAcquisitionInput } from './acquire-independent-product-input';
import { githubOriginOriginals, observeCliGitHubOrigin } from './lib/independent-admission/github-origin';
import { collectAdmissionArtifact, collectRelatedAdmissionArtifact, collectedArtifactView } from './lib/independent-admission/artifact-collector';
import { deriveAdmissionSource } from './lib/independent-admission/source-context';
import { observeClientConsumer, observeCliConsumer } from './lib/independent-admission/consumer-context';
import { planIndependentPublication, normalizePublicationInput, type ProductGroupPublicationInput, type IndependentPublicationRequest } from './lib/independent-admission/publication';
import { registryConsumerArtifactName, type RegistryConsumerOriginalManifest } from './lib/independent-admission/registry-consumer-originals';
import { archiveConsumerArtifactName, type ArchiveProductConsumerOriginalManifest, type ArchiveProductConsumerObservers } from './lib/independent-admission/archive-consumer-originals';
import { moduleProductRunner } from './module-product-targets';
import * as centralConsumers from './lib/independent-admission/consumer-context';
import { observeRegistryArtifact } from './lib/independent-admission/registry-context';
import type { PublicationPeerInputPlanCapability } from './lib/independent-admission/peer-input-plan';
import type { CollectedArtifactCapability, CollectedArtifactIdentity, CollectedArtifactMember } from './lib/independent-admission/artifact-contract';
import * as centralCollector from './lib/independent-admission/artifact-collector';
import { MODULE_CATALOG, MODULE_TARGETS, modulePackageName, type ModuleId, type ModuleTarget } from '../packages/xpod-cli/src/module-catalog';
import { executeIndependentPublication, promoteIndependentPublication, buildPublicationConsumerMaterials, type FixedRegistryConsumers } from './lib/independent-admission/publication-executor';

/** Data-only locators. Versions, tags, paths, status flags and capabilities are never JSON inputs. */
export type PublicationProductSelector = Readonly<Omit<ArtifactAcquisitionInput, 'schemaVersion'>> & (
  { readonly module: 'client' | 'cli'; readonly target?: never }
  | { readonly module: ModuleId; readonly target: `${ModuleTarget['platform']}-${ModuleTarget['arch']}` }
);
export interface PublicationGroupSelectorRequest {
  readonly schemaVersion: 2;
  readonly sourceSha: string;
  readonly products: readonly PublicationProductSelector[];
}
export type GroupPreparationResult = { readonly status: 'material-ready'; readonly products: ProductGroupPublicationInput['products'];
  readonly registryDependencies?: ProductGroupPublicationInput['registryDependencies'] }
  | { readonly status: 'pending'; readonly pending: readonly string[] };
export interface GroupPreparationDispatcher {
  preparePublicationGroup?: (input: { readonly selectors: readonly PublicationProductSelector[]; readonly checkout: string;
    readonly output: string; readonly token?: string }) => Promise<GroupPreparationResult>;
}
const hash40 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
const positive = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) > 0;
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)));
}
function parseGroupSelectors(value: unknown): PublicationGroupSelectorRequest {
  if (!exactKeys(value, ['schemaVersion', 'sourceSha', 'products']) || value.schemaVersion !== 2 || !hash40(value.sourceSha)
    || !Array.isArray(value.products) || !value.products.length || value.products.length > 128) throw Error('Bounded exact publication group selectors required');
  const seen = new Set<string>(); const families = new Map<string, PublicationProductSelector[]>();
  const products = value.products.map((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('Exact product selector required');
    const hint = row as Record<string, unknown>;
    const portable = hint.module === 'client' || hint.module === 'cli';
    const module = MODULE_CATALOG.find(item => item.id === hint.module);
    const keys = ['module', 'sourceSha', 'runHeadSha', 'runId', 'runAttempt', 'artifactId', 'artifactSha256', ...(portable ? [] : ['target'])];
    if ((!portable && !module) || !exactKeys(row, keys) || !hash40(row.sourceSha) || row.runHeadSha !== row.sourceSha
      || typeof row.artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.artifactSha256)
      || ![row.runId, row.runAttempt, row.artifactId].every(positive)
      || (!portable && !MODULE_TARGETS.some(target => `${target.platform}-${target.arch}` === row.target))) throw Error('Exact registered product/target coordinates required');
    const key = `${row.module}:${portable ? 'portable' : row.target}`;
    if (seen.has(key)) throw Error('Duplicate publication product selector');
    seen.add(key);
    const selector = Object.freeze({ module: row.module, ...(portable ? {} : { target: row.target }),
      sourceSha: row.sourceSha, runHeadSha: row.runHeadSha, runId: row.runId, runAttempt: row.runAttempt,
      artifactId: row.artifactId, artifactSha256: row.artifactSha256 }) as PublicationProductSelector;
    if (!portable) { const rows = families.get(selector.module) ?? []; rows.push(selector); families.set(selector.module, rows); }
    return selector;
  });
  for (const rows of families.values()) {
    if (rows.length !== MODULE_TARGETS.length || new Set(rows.map(row => row.sourceSha)).size !== 1)
      throw Error('Selector family requires every canonical target on one source; manifests remain authoritative');
  }
  return Object.freeze({ schemaVersion: 2, sourceSha: value.sourceSha, products: Object.freeze(products) });
}
export function parseIndependentPublicationRequest(raw: string): ArtifactAcquisitionInput | PublicationGroupSelectorRequest {
  const bytes = Buffer.byteLength(raw);
  if (bytes > 16 * 1024) throw new Error('Publication request exceeds budget');
  let value: any;
  try { value = JSON.parse(raw); } catch (error) { if (bytes > 4096) throw Error('Publication request exceeds budget'); throw error; }
  if (value?.schemaVersion === 2) return parseGroupSelectors(value);
  if (bytes > 4096) throw new Error('Publication request exceeds legacy budget');
  const keys = ['schemaVersion', 'sourceSha', 'runHeadSha', 'runId', 'runAttempt', 'artifactId', 'artifactSha256'];
  if (!exactKeys(value, keys) || value.schemaVersion !== 1 || !hash40(value.sourceSha)
    || value.runHeadSha !== value.sourceSha || !/^[a-f0-9]{64}$/u.test(value.artifactSha256)
    || ![value.runId, value.runAttempt, value.artifactId].every(positive)) {
    throw new Error('Exact staging producer coordinates required; input JSON grants no admission');
  }
  return Object.freeze(value) as ArtifactAcquisitionInput;
}

/** One process retains the central capabilities throughout preparation and promotion.
 * It never restores source/consumer/promotion authority from a saved JSON report. */
export async function runIndependentPublication(raw: string | ProductGroupPublicationInput, mode: string, destination: string) {
  if (!['prepare', 'publish'].includes(mode)) throw new Error('Unknown independent publication mode');
  if (typeof raw !== 'string') {
    // In-process callers retain opaque central capabilities. JSON coordinates continue
    // through the legacy central acquisition below; no saved JSON restores authority.
    const normalized = normalizePublicationInput(raw);
    const publication: ProductGroupPublicationInput = Object.freeze({ schemaVersion: 2,
      products: normalized.bindings, registryDependencies: normalized.registryDependencies });
    const plan = planIndependentPublication(publication);
    if (mode === 'publish' && !plan.prepublishEligible) throw new Error('Independent publication gates pending');
    const output = assertNewAcquisitionOutput(destination);
    mkdirSync(output, { mode: 0o700 });
    writeFileSync(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (mode === 'prepare') return { published: false, promoted: false, plan };
    return finishPublication(publication, plan, output);
  }
  const input = parseIndependentPublicationRequest(raw);
  const root = path.resolve(import.meta.dir, '..');
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (git(['rev-parse', 'HEAD']).trim() !== input.sourceSha || git(['status', '--porcelain']).trim()) {
    throw new Error('Clean exact producer checkout required');
  }
  git(['merge-base', '--is-ancestor', input.sourceSha, 'origin/staging']);
  if (input.schemaVersion === 2) {
    const prepare = (centralCollector as unknown as GroupPreparationDispatcher).preparePublicationGroup;
    const output = assertNewAcquisitionOutput(destination);
    mkdirSync(output, { mode: 0o700 });
    if (!prepare) {
      const plan = { status: 'blocked' as const, prepublishEligible: false, mutationAllowed: false as const,
        gaps: ['Central publication group acquisition/source/fixed-consumer factory unavailable'],
        tagPromotion: { status: 'pending' as const, mutationAllowed: false as const } };
      writeFileSync(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      if (mode === 'publish') throw Error('Central group preparation pending');
      return { published: false, promoted: false, plan };
    }
    const prepared = await prepare({ selectors: input.products, checkout: root,
      output: path.join(output, 'central-group'), token: process.env.GH_TOKEN });
    if (prepared.status === 'pending') {
      if (!Array.isArray(prepared.pending) || !prepared.pending.length || prepared.pending.length > 128
        || prepared.pending.some(reason => typeof reason !== 'string' || reason.length > 4096)) throw Error('Bounded central pending reasons required');
      const plan = { status: 'blocked' as const, prepublishEligible: false, mutationAllowed: false as const,
        gaps: [...prepared.pending], tagPromotion: { status: 'pending' as const, mutationAllowed: false as const } };
      writeFileSync(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      if (mode === 'publish') throw Error('Central group preparation pending');
      return { published: false, promoted: false, plan };
    }
    if (prepared.status !== 'material-ready') throw Error('Unknown central group preparation state');
    const normalized = normalizePublicationInput({ schemaVersion: 2, products: prepared.products, registryDependencies: prepared.registryDependencies });
    verifyPublicationSelectorBindings(input.products, normalized);
    const publication: ProductGroupPublicationInput = Object.freeze({ schemaVersion: 2, products: normalized.bindings,
      registryDependencies: normalized.registryDependencies });
    const plan = planIndependentPublication(publication);
    writeFileSync(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (mode === 'prepare') return { published: false, promoted: false, plan };
    if (!plan.prepublishEligible) throw Error('Independent publication gates pending');
    return finishPublication(publication, plan, output);
  }
  const origin = await observeCliGitHubOrigin(input, { token: process.env.GH_TOKEN });
  const originalRun = githubOriginOriginals(origin).find(row => row.name === 'run.original.json');
  const run = originalRun && JSON.parse(originalRun.data.toString('utf8'));
  if (!run || run.head_branch !== 'staging' || !['push', 'workflow_dispatch'].includes(run.event)) {
    throw new Error('Publication requires a staging producer event');
  }
  const output = assertNewAcquisitionOutput(destination);
  mkdirSync(output, { mode: 0o700 });
  await acquireIndependentProductInput(input, path.join(output, 'acquired'), {
    token: process.env.GH_TOKEN, limits: { packedBytes: 8 * 1024 ** 2, expandedBytes: 16 * 1024 ** 2, members: 1000 },
  });
  const cli = await collectAdmissionArtifact({ githubOrigin: origin, acquisitionRoot: path.join(output, 'acquired'),
    projectionOutput: path.join(output, 'projected'), product: 'cli' });
  const client = collectRelatedAdmissionArtifact(cli, 'client');
  const clientSource = deriveAdmissionSource(client, root), cliSource = deriveAdmissionSource(cli, root);
  const clientConsumer = await observeClientConsumer({ artifact: client, stage: 'prepublish', evidenceDirectory: path.join(output, 'client-consumer') });
  const cliConsumer = await observeCliConsumer({ artifact: cli, client, stage: 'prepublish', evidenceDirectory: path.join(output, 'cli-consumer') });
  const publication = { client, cli, clientSource, cliSource, clientConsumer, cliConsumer };
  const plan = planIndependentPublication(publication);
  writeFileSync(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  if (mode === 'prepare') return { published: false, promoted: false, plan };
  if (!plan.prepublishEligible) throw new Error('Independent publication gates pending; inspect plan.json');
  return finishPublication(publication, plan, output);
}

/** Both input adapters share one staging executor and single-use promotion path. */
async function finishPublication(publication: IndependentPublicationRequest,
  plan: ReturnType<typeof planIndependentPublication>, output: string) {
  const permit = await executeIndependentPublication({ ...publication, token: process.env.NPM_TOKEN ?? '' });
  await promoteIndependentPublication(permit, process.env.NPM_TOKEN ?? '');
  writeFileSync(path.join(output, 'promotion.json'), JSON.stringify({
    ...('schemaVersion' in publication ? {} : { sourceSha: collectedArtifactView(publication.cli)!.identity.sourceSha }),
    products: normalizePublicationInput(publication).bindings.map(row => {
      const view = collectedArtifactView(row.artifact)!; return { ...view.identity };
    }), published: true, promoted: true, gitReleaseTagsCreated: false }) + '\n', { flag: 'wx', mode: 0o600 });
  return { published: true, promoted: true, plan };
}

export function verifyPublicationSelectorBindings(selectors: readonly PublicationProductSelector[],
  normalized: ReturnType<typeof normalizePublicationInput>): void {
  const materialView = (centralCollector as unknown as { publicationMaterialView?: (artifact: unknown) => {
    identity: { package: string; sourceSha: string; target?: string }; producer: { runId: number; runAttempt: number; artifactId: number; artifactSha256: string; runHeadSha: string };
  } | undefined }).publicationMaterialView;
  if (!materialView || normalized.bindings.length !== selectors.length) throw Error('Central selector/product binding incomplete');
  for (const selector of selectors) {
    const name = selector.module === 'cli' || selector.module === 'client' ? '@undefineds.co/xpod-' + selector.module
    : modulePackageName(selector.module, selector.target!.split('-')[0], selector.target!.split('-')[1]);
    const binding = normalized.bindings.find(row => collectedArtifactView(row.artifact)!.identity.package === name);
    const material = binding && materialView(binding.artifact);
    if (!material || material.identity.sourceSha !== selector.sourceSha || material.identity.target !== selector.target
    || material.producer.runHeadSha !== selector.runHeadSha || material.producer.runId !== selector.runId
    || material.producer.runAttempt !== selector.runAttempt || material.producer.artifactId !== selector.artifactId
    || material.producer.artifactSha256 !== selector.artifactSha256) throw Error('Central material differs from exact group selector');
  }
}

export function resolveRegistryConsumerRoute(raw: string, module: string, target: string,
  run: { runId: number; runAttempt: number }, stage: 'prepublish' | 'postpublish' = 'postpublish') {
  if (stage !== 'prepublish' && stage !== 'postpublish') throw Error('Fixed consumer stage required');
  const parsed = parseIndependentPublicationRequest(raw);
  const { schemaVersion: _schema, ...legacy } = parsed as ArtifactAcquisitionInput;
  const selectors: readonly PublicationProductSelector[] = parsed.schemaVersion === 2 ? parsed.products
    : [{ ...legacy, module: 'client' }, { ...legacy, module: 'cli' }];
  const selector = selectors.find(row => row.module === module && (row.target ?? 'portable') === target);
  if (!selector) throw Error('Consumer route must select an exact admitted product locator');
  const runner = selector.target ? moduleProductRunner(selector.target.split('-')[0], selector.target.split('-')[1])
    : moduleProductRunner('linux', 'x64');
  return Object.freeze({ selector, selectors, runner, artifactName: (stage === 'prepublish' ? archiveConsumerArtifactName : registryConsumerArtifactName)({ module: selector.module,
    target: selector.target, sourceSha: selector.sourceSha, ...run }) });
}
interface RegistryConsumerPreparationDispatcher {
  prepareRegistryConsumerProduct?: (input: { selectors: readonly PublicationProductSelector[]; module: PublicationProductSelector['module'];
    target?: string; checkout: string; output: string; token?: string }) => Promise<
      { status: 'material-ready'; artifact: CollectedArtifactCapability; client?: CollectedArtifactCapability;
        peerPlan?: PublicationPeerInputPlanCapability; peers?: readonly CollectedArtifactCapability[]; dependencies?: readonly CollectedArtifactCapability[] }
      | { status: 'pending'; pending: readonly string[] }>;
}
export function productConsumerStage(value: string | undefined): 'prepublish' | 'postpublish' {
  if (value === undefined || value === 'postpublish') return 'postpublish';
  if (value === 'prepublish') return 'prepublish';
  throw Error('Fixed consumer stage required');
}
function registryConsumerContext() {
  const stage = productConsumerStage(process.env.PRODUCT_CONSUMER_STAGE);
  const route = resolveRegistryConsumerRoute(process.env.INDEPENDENT_PUBLICATION_INPUT ?? '',
    process.env.REGISTRY_CONSUMER_MODULE ?? '', process.env.REGISTRY_CONSUMER_TARGET ?? '',
    { runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) }, stage);
  const root = path.resolve(import.meta.dir, '..');
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (sourceSha !== route.selector.sourceSha || process.env.GITHUB_SHA !== sourceSha
    || process.env.GITHUB_REF !== 'refs/heads/staging') throw Error('Matching source staging registry consumer checkout required');
  const output = path.join(root, '.test-data', stage === 'prepublish' ? 'independent-archive-consumer' : 'independent-registry-consumer');
  return { route, root, sourceSha, output, stage };
}
async function runRegistryConsumerChild(): Promise<void> {
  const { route, root, sourceSha, output, stage } = registryConsumerContext();
  const prepare = (centralCollector as unknown as RegistryConsumerPreparationDispatcher).prepareRegistryConsumerProduct;
  const dispatch = centralConsumers as unknown as FixedRegistryConsumers & Partial<ArchiveProductConsumerObservers>;
  const check = stage === 'prepublish' ? dispatch.preflightArchiveInstalledProductConsumer : dispatch.preflightRegistryInstalledProductConsumer;
  const observeArchive = dispatch.observeArchiveInstalledProductConsumer;
  const observeRegistry = dispatch.observeRegistryInstalledProductConsumer;
  if (!prepare || !check || (stage === 'prepublish' ? !observeArchive : !observeRegistry)
    || !('publicationConsumerDependencyArtifacts' in centralConsumers)) throw Error('Central fixed registry consumer preparation/runner pending');
  const prepared = await prepare({ selectors: route.selectors, module: route.selector.module, target: route.selector.target,
    checkout: root, output: path.join(root, '.test-data', stage === 'prepublish' ? 'independent-archive-consumer-materials' : 'independent-registry-consumer-materials'), token: process.env.GH_TOKEN });
  if (prepared.status !== 'material-ready') throw Error('Controlled registry consumer materials pending');
  const view = collectedArtifactView(prepared.artifact);
  if (!view || view.identity.sourceSha !== sourceSha || view.identity.target !== route.selector.target) throw Error('Registry consumer product identity differs');
  const expectedName = route.selector.module === 'client' || route.selector.module === 'cli' ? '@undefineds.co/xpod-' + route.selector.module
    : modulePackageName(route.selector.module, route.selector.target!.split('-')[0], route.selector.target!.split('-')[1]);
  if (view.identity.package !== expectedName) throw Error('Registry consumer family differs');
  const candidates = [...new Set([prepared.artifact, prepared.client, ...prepared.dependencies ?? []].filter(Boolean))]
    .map(artifact => { const candidate = collectedArtifactView(artifact); if (!candidate) throw Error('Real consumer tool capability required'); return { artifact, identity: candidate.identity }; });
  const materials = buildPublicationConsumerMaterials({ artifact: prepared.artifact, package: view.identity.package, candidates,
    peerPlan: prepared.peerPlan, peers: prepared.peers, dependencies: prepared.dependencies });
  check(materials);
  const observation = stage === 'prepublish'
    ? await observeArchive!({ ...materials, stage: 'prepublish', evidenceDirectory: output })
    : await observeRegistry!({ ...materials, stage: 'postpublish', registryObservation: await observeRegistryArtifact(prepared.artifact), evidenceDirectory: output });
  const observed = centralConsumers.consumerObservationView(observation);
  if (!observed?.allProfilesVerified || observed.registryInstallVerified !== (stage === 'postpublish') || observed.stage !== stage
    || !isDeepStrictEqual(observed.identity, view.identity)) throw Error('Real fixed product consumer incomplete');
  const toolArtifacts = (centralConsumers as unknown as { publicationConsumerDependencyArtifacts(input: typeof materials): readonly unknown[] })
    .publicationConsumerDependencyArtifacts(materials);
  const tools = toolArtifacts.map(artifact => { const tool = collectedArtifactView(artifact); if (!tool) throw Error('Real tool original required'); return tool.identity; });
  if (!readdirSync(output).includes('result.json')) {
    // Preserve the actual portable observer original bytes, never synthesize passed flags.
    copyFileSync(path.join(output, 'consumer-observation.json'), path.join(output, 'result.json'));
    chmodSync(path.join(output, 'result.json'), 0o400);
  }
  writeFileSync(path.join(output, 'consumer-product-binding.json'), JSON.stringify({ product: view.identity, tools }) + '\n', { flag: 'wx', mode: 0o400 });
}
/** Reserve the supervisor sibling only; the fixed observer owns fresh output creation. */
export function reserveRegistryConsumerProducerDirectories(output: string) {
  const destination = assertNewAcquisitionOutput(output);
  const producer = assertNewAcquisitionOutput(destination + '-producer');
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  mkdirSync(producer, { mode: 0o700 });
  return Object.freeze({ output: destination, producer });
}
/** Closed supervisor bytes are copied without replacing observer originals.
 * This helper provides custody only and never issues a consumer capability. */
export function copyRegistryConsumerProducerOriginals(directories: { output: string; producer: string }, outcome: {
  code: number; actualWait: boolean; actualClose: boolean; groupAbsent: boolean;
  rawComplete: boolean; rawClosedBeforeHash: boolean; pipeEOF?: readonly boolean[];
}): void {
  if (outcome.code !== 0 || outcome.actualWait !== true || outcome.actualClose !== true || outcome.groupAbsent !== true
    || outcome.rawComplete !== true || outcome.rawClosedBeforeHash !== true || outcome.pipeEOF?.length !== 2
    || !outcome.pipeEOF.every(value => value === true)) throw Error('Registry consumer supervisor closure incomplete');
  for (const directory of [directories.output, directories.producer]) {
    const stat = lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Owned consumer directory required');
  }
  const target = path.join(directories.output, 'producer-supervision');
  mkdirSync(target, { mode: 0o700 });
  let bytes = 0;
  for (const name of readdirSync(directories.producer).sort()) {
    const source = path.join(directories.producer, name); const stat = lstatSync(source);
    bytes += stat.size;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || bytes > 3 * 1024 ** 2) throw Error('Bounded regular supervisor originals required');
    const destination = path.join(target, name);
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    chmodSync(destination, 0o400);
    if (!readFileSync(source).equals(readFileSync(destination))) throw Error('Supervisor original changed during copy');
  }
}
async function runRegistryConsumer(): Promise<void> {
  const { route, sourceSha, output, stage } = registryConsumerContext();
  const directories = reserveRegistryConsumerProducerDirectories(output);
  const supervision = directories.producer;
  const executable = process.execPath;
  if (!process.versions.bun) throw Error('Pinned Bun required for registry consumer producer');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined &&
    (['PATH', 'HOME', 'TMPDIR', 'LANG', 'GH_TOKEN', 'REGISTRY_CONSUMER_MODULE', 'REGISTRY_CONSUMER_TARGET', 'INDEPENDENT_PUBLICATION_INPUT', 'PRODUCT_CONSUMER_STAGE'].includes(key) || key.startsWith('GITHUB_'))) env[key] = value;
  env.INDEPENDENT_PUBLICATION_PHASE = 'registry-consumer-child';
  const { runPublicationCommand } = createRequire(import.meta.url)('./lib/afs-publication-command.cjs');
  const outcome = await runPublicationCommand(executable, [path.resolve(import.meta.dir, 'run-independent-publication.ts')], {
    cwd: path.resolve(import.meta.dir, '..'), env, evidence: supervision, label: 'registry-consumer', timeoutMs: 25 * 60_000, rawLimit: 1024 ** 2 });
  copyRegistryConsumerProducerOriginals(directories, outcome);
  const binding = JSON.parse(readFileSync(path.join(output, 'consumer-product-binding.json'), 'utf8')) as { product: CollectedArtifactIdentity; tools: CollectedArtifactIdentity[] };
  const originals: CollectedArtifactMember[] = []; let bytes = 0;
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name); const stat = lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw Error('Registry consumer originals must be regular');
      if (stat.isDirectory()) { visit(file); continue; }
      if (name === 'registry-consumer.manifest.json' || name === 'archive-consumer.manifest.json') throw Error('Registry consumer manifest must be fresh');
      bytes += stat.size; if (bytes > 64 * 1024 ** 2 || originals.length >= 2000) throw Error('Registry consumer originals exceed fixed budget');
      originals.push({ path: path.relative(output, file).replaceAll(path.sep, '/'), bytes: stat.size, mode: stat.mode & 0o777,
        sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
    }
  }; visit(output);
  const result = originals.find(row => row.path === 'result.json'); if (!result) throw Error('Original registry consumer result missing');
  const manifest: RegistryConsumerOriginalManifest | ArchiveProductConsumerOriginalManifest = { schemaVersion: 1,
    ...(stage === 'prepublish' ? { kind: 'archive-product-consumer-originals' as const, stage: 'prepublish' as const, transport: 'collected-product-archives' as const }
      : { kind: 'registry-installed-product-consumer-originals' as const }),
    product: binding.product, sourceSha, consumer: { runHeadSha: process.env.GITHUB_SHA!, runId: Number(process.env.GITHUB_RUN_ID),
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT), ...(route.selector.target ? { target: route.selector.target } : {}) },
    tools: binding.tools, result, originals };
  writeFileSync(path.join(output, stage === 'prepublish' ? 'archive-consumer.manifest.json' : 'registry-consumer.manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
}
async function dispatchPublicationEntry(): Promise<unknown> {
  const phase = process.env.INDEPENDENT_PUBLICATION_PHASE ?? 'publication';
  if (phase === 'registry-consumer-resolve') {
    const route = resolveRegistryConsumerRoute(process.env.INDEPENDENT_PUBLICATION_INPUT ?? '', process.env.REGISTRY_CONSUMER_MODULE ?? '',
      process.env.REGISTRY_CONSUMER_TARGET ?? '', { runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) }, productConsumerStage(process.env.PRODUCT_CONSUMER_STAGE));
    if (!process.env.GITHUB_OUTPUT) throw Error('Controlled workflow output required');
    appendFileSync(process.env.GITHUB_OUTPUT, `runner=${route.runner}\nartifact_name=${route.artifactName}\n`);
    return;
  }
  if (phase === 'registry-consumer') return runRegistryConsumer();
  if (phase === 'registry-consumer-child') return runRegistryConsumerChild();
  if (['consumer-matrix', 'wave-plan', 'family-stage', 'final-promotion'].includes(phase))
    return (await import('./lib/independent-admission/publication-wave')).runPublicationWavePhase(phase);
  if (phase !== 'publication') throw Error('Unknown fixed publication phase');
  return runIndependentPublication(process.env.INDEPENDENT_PUBLICATION_INPUT ?? '', process.env.INDEPENDENT_PUBLICATION_MODE ?? 'prepare',
    path.resolve('.test-data/independent-publication', process.env.GITHUB_RUN_ID ?? 'local', process.env.GITHUB_RUN_ATTEMPT ?? '1'));
}

if (import.meta.main) {
  dispatchPublicationEntry().catch(() => {
    process.stderr.write('Independent publication stopped; inspect private evidence and plan.\n'); process.exitCode = 1;
  });
}
