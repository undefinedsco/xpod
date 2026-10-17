import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { acquireIndependentProductInput, assertNewAcquisitionOutput, type ArtifactAcquisitionInput } from './acquire-independent-product-input';
import { githubOriginOriginals, observeCliGitHubOrigin } from './lib/independent-admission/github-origin';
import { collectAdmissionArtifact, collectRelatedAdmissionArtifact } from './lib/independent-admission/artifact-collector';
import { deriveAdmissionSource } from './lib/independent-admission/source-context';
import { observeClientConsumer, observeCliConsumer } from './lib/independent-admission/consumer-context';
import { planIndependentPublication } from './lib/independent-admission/publication';
import { executeIndependentPublication, promoteIndependentPublication } from './lib/independent-admission/publication-executor';

export function parseIndependentPublicationRequest(raw: string): ArtifactAcquisitionInput {
  if (Buffer.byteLength(raw) > 4096) throw new Error('Publication request exceeds budget');
  const value = JSON.parse(raw);
  const keys = ['schemaVersion', 'sourceSha', 'runHeadSha', 'runId', 'runAttempt', 'artifactId', 'artifactSha256'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
    || value.schemaVersion !== 1 || !/^[a-f0-9]{40}$/u.test(value.sourceSha)
    || value.runHeadSha !== value.sourceSha || !/^[a-f0-9]{64}$/u.test(value.artifactSha256)
    || ![value.runId, value.runAttempt, value.artifactId].every(row => Number.isSafeInteger(row) && row > 0)) {
    throw new Error('Exact staging producer coordinates required; input JSON grants no admission');
  }
  return value;
}

/** One process retains the central capabilities throughout preparation and promotion.
 * It never restores source/consumer/promotion authority from a saved JSON report. */
export async function runIndependentPublication(raw: string, mode: string, destination: string) {
  const input = parseIndependentPublicationRequest(raw);
  if (!['prepare', 'publish'].includes(mode)) throw new Error('Unknown independent publication mode');
  const root = path.resolve(import.meta.dir, '..');
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (git(['rev-parse', 'HEAD']).trim() !== input.sourceSha || git(['status', '--porcelain']).trim()) {
    throw new Error('Clean exact producer checkout required');
  }
  git(['merge-base', '--is-ancestor', input.sourceSha, 'origin/staging']);
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
  const permit = await executeIndependentPublication({ ...publication, token: process.env.NPM_TOKEN ?? '' });
  await promoteIndependentPublication(permit, process.env.NPM_TOKEN ?? '');
  writeFileSync(path.join(output, 'promotion.json'), JSON.stringify({ sourceSha: input.sourceSha,
    published: true, promoted: true, gitReleaseTagsCreated: false }) + '\n', { flag: 'wx', mode: 0o600 });
  return { published: true, promoted: true, plan };
}

if (import.meta.main) {
  runIndependentPublication(process.env.INDEPENDENT_PUBLICATION_INPUT ?? '', process.env.INDEPENDENT_PUBLICATION_MODE ?? 'prepare',
    path.resolve('.test-data/independent-publication', process.env.GITHUB_RUN_ID ?? 'local', process.env.GITHUB_RUN_ATTEMPT ?? '1'))
    .catch(() => { process.stderr.write('Independent publication stopped; inspect private evidence and plan.\n'); process.exitCode = 1; });
}
