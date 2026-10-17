import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { acquireIndependentProductInput, assertNewAcquisitionOutput, type ArtifactAcquisitionInput } from './acquire-independent-product-input';
import { githubOriginOriginals, observeCliGitHubOrigin } from './lib/independent-admission/github-origin';
import { collectAdmissionArtifact, collectRelatedAdmissionArtifact, collectedArtifactView } from './lib/independent-admission/artifact-collector';
import { deriveAdmissionSource } from './lib/independent-admission/source-context';
import { observeClientConsumer, observeCliConsumer } from './lib/independent-admission/consumer-context';
import { planIndependentPublication, normalizePublicationInput, type ProductGroupPublicationInput, type IndependentPublicationRequest } from './lib/independent-admission/publication';
import * as centralCollector from './lib/independent-admission/artifact-collector';
import { MODULE_CATALOG, MODULE_TARGETS, modulePackageName, type ModuleId, type ModuleTarget } from '../packages/xpod-cli/src/module-catalog';
import { executeIndependentPublication, promoteIndependentPublication } from './lib/independent-admission/publication-executor';

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
    const materialView = (centralCollector as unknown as { publicationMaterialView?: (artifact: unknown) => {
      identity: { package: string; sourceSha: string; target?: string }; producer: { runId: number; runAttempt: number; artifactId: number; artifactSha256: string; runHeadSha: string };
    } | undefined }).publicationMaterialView;
    if (!materialView || normalized.bindings.length !== input.products.length) throw Error('Central selector/product binding incomplete');
    for (const selector of input.products) {
      const name = selector.module === 'cli' || selector.module === 'client' ? '@undefineds.co/xpod-' + selector.module
        : modulePackageName(selector.module, selector.target!.split('-')[0], selector.target!.split('-')[1]);
      const binding = normalized.bindings.find(row => collectedArtifactView(row.artifact)!.identity.package === name);
      const material = binding && materialView(binding.artifact);
      if (!material || material.identity.sourceSha !== selector.sourceSha || material.identity.target !== selector.target
        || material.producer.runHeadSha !== selector.runHeadSha || material.producer.runId !== selector.runId
        || material.producer.runAttempt !== selector.runAttempt || material.producer.artifactId !== selector.artifactId
        || material.producer.artifactSha256 !== selector.artifactSha256) throw Error('Central material differs from exact group selector');
    }
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

if (import.meta.main) {
  runIndependentPublication(process.env.INDEPENDENT_PUBLICATION_INPUT ?? '', process.env.INDEPENDENT_PUBLICATION_MODE ?? 'prepare',
    path.resolve('.test-data/independent-publication', process.env.GITHUB_RUN_ID ?? 'local', process.env.GITHUB_RUN_ATTEMPT ?? '1'))
    .catch(() => { process.stderr.write('Independent publication stopped; inspect private evidence and plan.\n'); process.exitCode = 1; });
}
