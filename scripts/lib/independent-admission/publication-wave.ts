import fs from 'node:fs';
import { modulePackageName } from '../../../packages/xpod-cli/src/module-catalog';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseIndependentPublicationRequest, verifyPublicationSelectorBindings,
  type PublicationGroupSelectorRequest, type PublicationProductSelector, type GroupPreparationDispatcher } from '../../run-independent-publication';
import { validatePublicationConsumerRuns, type PublicationConsumerRunLocator } from './consumer-run-locators';
import * as collector from './artifact-collector';
import { normalizePublicationInput, planIndependentPublication, type ProductGroupPublicationInput } from './publication';
import { planIndependentPublicationFrontier, planPublicationStageBatch, stageIndependentPublication,
  authorizeIndependentPromotion, promoteIndependentPublication, independentPublicationEvidence } from './publication-executor';
import { archiveConsumerArtifactName } from './archive-consumer-originals';
import { registryConsumerArtifactName } from './registry-consumer-originals';
const fail = (message: string): never => { throw Error('Publication wave: ' + message); };
interface WaveFactory {
  preparePublicationGroup?: (input: Parameters<NonNullable<GroupPreparationDispatcher['preparePublicationGroup']>>[0]
    & { readonly consumerRuns: readonly PublicationConsumerRunLocator[] }) => ReturnType<NonNullable<GroupPreparationDispatcher['preparePublicationGroup']>>;
}
function context() {
  const request = parseIndependentPublicationRequest(process.env.INDEPENDENT_PUBLICATION_INPUT ?? '');
  if (request.schemaVersion !== 2) return fail('complete product group selectors required');
  const root = path.resolve(import.meta.dir, '../../..');
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1024 ** 2 }).trim();
  if (git(['rev-parse', 'HEAD']) !== request.sourceSha || git(['status', '--porcelain', '--untracked-files=all'])
    || process.env.GITHUB_SHA !== request.sourceSha || process.env.GITHUB_REF !== 'refs/heads/staging') return fail('clean matching staging source required');
  git(['merge-base', '--is-ancestor', request.sourceSha, 'origin/staging']);
  const runId = Number(process.env.GITHUB_RUN_ID), runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (![runId, runAttempt].every(value => Number.isSafeInteger(value) && value > 0)) return fail('actual workflow run coordinates required');
  return { request, root, runId, runAttempt };
}
function output(values: Record<string, unknown>): void {
  const destination = process.env.GITHUB_OUTPUT;
  if (!destination) return fail('controlled workflow output required');
  const lines = Object.entries(values).map(([key, value]) => key + '=' + (typeof value === 'string' ? value : JSON.stringify(value)));
  if (lines.some(line => /[\r\n]/u.test(line)) || Buffer.byteLength(lines.join('\n')) > 32 * 1024) return fail('bounded flat workflow outputs required');
  fs.appendFileSync(destination, lines.join('\n') + '\n');
}
export function publicationConsumerMatrix(request: PublicationGroupSelectorRequest) {
  return request.products.map(selector => ({ module: selector.module, target: selector.target ?? 'portable' }));
}
/** GitHub run metadata is a locator source only; digest/name never grants a cap. */
async function discoverConsumerRuns(request: PublicationGroupSelectorRequest, runId: number, runAttempt: number) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? '')) return fail('canonical GitHub repository required');
  const response = await fetch('https://api.github.com/repos/' + repository + '/actions/runs/' + runId + '/artifacts?per_page=100', {
    headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + (process.env.GH_TOKEN ?? '') }, signal: AbortSignal.timeout(30_000), redirect: 'error',
  });
  if (!response.ok) return fail('original consumer artifact metadata unavailable');
  const reader = response.body?.getReader(); if (!reader) return fail('artifact metadata body required');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
    if (size > 1024 ** 2) { await reader.cancel(); return fail('artifact metadata budget exceeded'); } chunks.push(next.value); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Number.isSafeInteger(data.total_count) || data.total_count > 100 || !Array.isArray(data.artifacts)
    || data.artifacts.length !== data.total_count) return fail('complete bounded artifact metadata required');
  const locators: PublicationConsumerRunLocator[] = [];
  for (const selector of request.products) for (const stage of ['prepublish', 'postpublish'] as const) {
    const name = (stage === 'prepublish' ? archiveConsumerArtifactName : registryConsumerArtifactName)({ module: selector.module,
      target: selector.target, sourceSha: selector.sourceSha, runId, runAttempt });
    const matches = data.artifacts.filter((row: { name?: string }) => row.name === name);
    if (matches.length > 1) return fail('ambiguous consumer originals');
    if (!matches.length) { if (stage === 'prepublish') return fail('all matching-host archive originals required'); continue; }
    const artifact = matches[0];
    if (artifact.expired !== false || !Number.isSafeInteger(artifact.id) || artifact.id < 1
      || !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? '')) return fail('immutable consumer original digest required');
    locators.push(Object.freeze({ module: selector.module, ...(selector.target ? { target: selector.target } : {}), stage,
      consumerRun: Object.freeze({ schemaVersion: 1, sourceSha: selector.sourceSha, runHeadSha: request.sourceSha,
        runId, runAttempt, artifactId: artifact.id, artifactSha256: artifact.digest.slice(7) }) }));
  }
  validatePublicationConsumerRuns(locators, request.sourceSha);
  return Object.freeze(locators);
}
/** Copy only closed publisher-owned originals into the uploaded evidence root. */
function retainPublisherAudit(source: string, destination: string): void {
  if (!path.isAbsolute(source) || !path.basename(source).startsWith('xpod-independent-publish-')) return fail('owned publication audit root required');
  fs.mkdirSync(destination, { mode: 0o700 }); let bytes = 0, count = 0;
  const visit = (from: string, to: string): void => {
    for (const name of fs.readdirSync(from).sort()) {
      if (['.npmrc', 'home', 'tmp', 'package.json'].includes(name)) continue;
      const file = path.join(from, name), target = path.join(to, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return fail('regular publisher audit originals required');
      if (stat.isDirectory()) { fs.mkdirSync(target, { mode: 0o700 }); visit(file, target); continue; }
      bytes += stat.size; count++;
      if (bytes > 16 * 1024 ** 2 || count > 2000) return fail('publisher audit copy budget exceeded');
      fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o400);
    }
  }; visit(source, destination);
}
export async function runPublicationWavePhase(phase: string): Promise<void> {
  const { request, root, runId, runAttempt } = context();
  if (phase === 'consumer-matrix') { output({ consumers: { include: publicationConsumerMatrix(request) } }); return; }
  const prepare = (collector as unknown as WaveFactory).preparePublicationGroup;
  if (!prepare) return fail('central group factory unavailable');
  const consumerRuns = await discoverConsumerRuns(request, runId, runAttempt);
  const directory = path.join(root, '.test-data', 'publication-wave');
  fs.mkdirSync(directory, { mode: 0o700 });
  const prepared = await prepare({ selectors: request.products, checkout: root, output: path.join(directory, 'central'),
    consumerRuns, token: process.env.GH_TOKEN });
  if (prepared.status !== 'material-ready') return fail('central complete cohort pending: ' + prepared.pending.join('; '));
  const normalized = normalizePublicationInput({ schemaVersion: 2, products: prepared.products, registryDependencies: prepared.registryDependencies });
  verifyPublicationSelectorBindings(request.products, normalized);
  const group: ProductGroupPublicationInput = Object.freeze({ schemaVersion: 2, products: normalized.bindings, registryDependencies: normalized.registryDependencies });
  const plan = planIndependentPublication(group);
  fs.writeFileSync(path.join(directory, 'plan.json'), JSON.stringify(plan) + '\n', { flag: 'wx', mode: 0o600 });
  if (!plan.prepublishEligible) return fail('whole cohort prepublish gates pending');
  if (phase === 'final-promotion') {
    const permit = await authorizeIndependentPromotion(group);
    await promoteIndependentPublication(permit, process.env.NPM_TOKEN ?? '');
    const evidence = independentPublicationEvidence(permit); if (!evidence) return fail('actual promotion audit locator missing');
    retainPublisherAudit(evidence, path.join(directory, 'promotion-originals')); return;
  }
  if (phase === 'family-stage') {
    const family = process.env.PUBLICATION_FAMILY;
    if (!['client', 'cli', 'api', 'css', 'afs'].includes(family ?? '')) return fail('fixed stage family required');
    const result = await stageIndependentPublication({ ...group, token: process.env.NPM_TOKEN ?? '' }, family as PublicationProductSelector['module']);
    fs.writeFileSync(path.join(directory, 'stage.json'), JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
    retainPublisherAudit(result.evidenceDirectory, path.join(directory, 'stage-originals')); return;
  }
  if (phase !== 'wave-plan') return fail('unknown controlled wave phase');
  const frontier = planIndependentPublicationFrontier(group);
  const identities = normalized.bindings.map(binding => collector.collectedArtifactView(binding.artifact)!.identity);
  const dependencies = normalized.registryDependencies.map(binding => collector.collectedArtifactView(binding.artifact)!.identity);
  const stages: { family: string }[] = [], consumers: { module: string; target: string }[] = [];
  for (const family of ['client', 'cli', 'api', 'css', 'afs']) {
    const selectors = request.products.filter(selector => selector.module === family);
    const ready = selectors.map(selector => ({ selector, identity: identities.find(identity => identity.target === selector.target
      && identity.package === (selector.target ? modulePackageName(selector.module as 'api' | 'css' | 'afs', selector.target.split('-')[0], selector.target.split('-')[1]) : '@undefineds.co/xpod-' + family))! }))
      .filter(row => row.identity && frontier.frontier.includes(row.identity.package))
      .sort((left, right) => normalized.cohort.order.indexOf(left.identity.package) - normalized.cohort.order.indexOf(right.identity.package));
    if (!ready.length) continue;
    const batch = planPublicationStageBatch(identities, ready.map(row => row.identity), dependencies);
    stages.push({ family }); consumers.push(...ready.slice(0, batch.count).map(row => ({ module: row.selector.module, target: row.selector.target ?? 'portable' })));
  }
  if (!frontier.complete && !consumers.length) return fail('remaining cohort has no admissible wave');
  output({ has_work: consumers.length ? 'true' : 'false', complete: frontier.complete ? 'true' : 'false', stages: { include: stages }, consumers: { include: consumers } });
}
