import { expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { reserveRegistryConsumerProducerDirectories, copyRegistryConsumerProducerOriginals, resolveRegistryConsumerRoute, productConsumerStage, runIndependentPublication, parseIndependentPublicationRequest } from '../../scripts/run-independent-publication';

const coordinate = { schemaVersion: 1, sourceSha: 'a'.repeat(40), runHeadSha: 'a'.repeat(40),
  runId: 1, runAttempt: 1, artifactId: 2, artifactSha256: 'b'.repeat(64) };

it('accepts exact source coordinates without granting admission or serialized permits', () => {
  expect(parseIndependentPublicationRequest(JSON.stringify(coordinate))).toEqual(coordinate);
  for (const extra of [{ passed: true }, { promotionPermit: {} }, { registry: 'https://elsewhere.invalid' }]) {
    expect(() => parseIndependentPublicationRequest(JSON.stringify({ ...coordinate, ...extra }))).toThrow();
  }
});

it('rejects PR heads, malformed identifiers and oversized requests before any transport', () => {
  for (const value of [null, [], { ...coordinate, runHeadSha: 'c'.repeat(40) },
    { ...coordinate, runAttempt: 0 }, { ...coordinate, artifactId: '2' },
    { ...coordinate, sourceSha: 'staging' }, { ...coordinate, artifactSha256: 'b'.repeat(63) }]) {
    expect(() => parseIndependentPublicationRequest(JSON.stringify(value))).toThrow();
  }
  expect(() => parseIndependentPublicationRequest(' '.repeat(4097))).toThrow('budget');
});

it('keeps the publication workflow separate from service RC and defaults to preparation', () => {
  const workflow = JSON.parse(execFileSync(process.execPath, ['-e',
    'console.log(JSON.stringify(Bun.YAML.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))))',
    '.github/workflows/independent-publication.yml'], { encoding: 'utf8' }));
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.on.workflow_dispatch.inputs.mode.default).toBe('prepare');
  expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
  expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  const job = workflow.jobs.publication;
  expect(job.if).toContain("github.ref == 'refs/heads/staging'");
  const steps = job.steps as any[];
  const ancestry = steps.findIndex(step => step.run?.includes('git merge-base --is-ancestor'));
  const install = steps.findIndex(step => step.run === 'bun install --frozen-lockfile');
  const execute = steps.findIndex(step => step.run?.includes('bun scripts/run-independent-publication.ts'));
  expect(ancestry >= 0).toBe(true); expect(install > ancestry).toBe(true);
  expect(execute > install).toBe(true);
  expect(steps[execute].env.NPM_TOKEN).toContain("inputs.mode == 'publish'");
});


it('grouped entry accepts only live in-process capabilities, never serialized passed reports', async () => {
  const fake: any = { schemaVersion: 2, products: [{ artifact: { status: 'verified' }, source: { status: 'verified' } }] };
  expect(() => parseIndependentPublicationRequest(JSON.stringify(fake))).toThrow();
  await expect(runIndependentPublication(fake, 'prepare', '.test-data/grouped-entry-must-not-be-created')).rejects.toThrow('real central');
  expect(require('node:fs').existsSync('.test-data/grouped-entry-must-not-be-created')).toBe(false);
});


import { MODULE_CATALOG, MODULE_TARGETS } from '../../packages/xpod-cli/src/module-catalog';
function groupSelectors() {
  const { schemaVersion: _schema, ...position } = coordinate;
  return { schemaVersion: 2, sourceSha: coordinate.sourceSha, products: [
    { module: 'client', ...position, sourceSha: 'c'.repeat(40), runHeadSha: 'c'.repeat(40) },
    { module: 'cli', ...position },
    ...MODULE_CATALOG.flatMap(module => MODULE_TARGETS.map(target => ({ module: module.id,
      target: `${target.platform}-${target.arch}`, ...position }))),
  ] };
}
it('formal workflow JSON selects the complete CLI/API/CSS/AFS cohort by immutable coordinates only', () => {
  const input = groupSelectors();
  const parsed = parseIndependentPublicationRequest(JSON.stringify(input));
  expect(parsed).toEqual(input);
  if (parsed.schemaVersion !== 2) throw Error('group parser expected');
  expect(parsed.products).toHaveLength(14);
  expect(Object.isFrozen(parsed.products)).toBe(true);
  expect(Object.isFrozen(parsed.products[13])).toBe(true);
  expect(parsed.products[0].sourceSha).not.toBe(parsed.products[1].sourceSha);
  expect('mutationAllowed' in parsed).toBe(false);
});
it('rejects partial/duplicate/mixed-source selectors and publication claims before central acquisition', () => {
  const input = groupSelectors();
  for (const change of [
    { ...input, products: input.products.slice(0, -1) },
    { ...input, products: [...input.products, input.products[0]] },
    { ...input, published: true },
    { ...input, registry: 'https://elsewhere.invalid' },
    { ...input, products: input.products.map((row, index) => index ? row : { ...row, target: 'linux-x64' }) },
    { ...input, products: input.products.map((row, index) => index !== 2 ? row : { ...row, target: 'win32-x64' }) },
    { ...input, products: input.products.map((row, index) => index !== 2 ? row : { ...row, sourceSha: 'd'.repeat(40), runHeadSha: 'd'.repeat(40) }) },
  ]) expect(() => parseIndependentPublicationRequest(JSON.stringify(change))).toThrow();
  for (const extra of [{ version: '1.2.3' }, { tag: 'latest' }, { legalQualified: true }, { path: '/tmp/file' }, { archiveBytes: 1 }, { registryConsumer: { passed: true } }]) {
    expect(() => parseIndependentPublicationRequest(JSON.stringify({ ...input,
      products: input.products.map((row, index) => index ? row : { ...row, ...extra }) }))).toThrow();
  }
  expect(() => parseIndependentPublicationRequest(' '.repeat(16385))).toThrow('budget');
});


it('matching-host registry consumer route derives native runners and shared artifact names without publisher authority', () => {
  const input = JSON.stringify(groupSelectors());
  const darwin = resolveRegistryConsumerRoute(input, 'afs', 'darwin-x64', { runId: 42, runAttempt: 2 });
  expect(darwin.runner).toBe('macos-15-intel');
  expect(darwin.artifactName).toBe('xpod-registry-consumer-afs-darwin-x64-' + coordinate.sourceSha + '-42-2');
  expect(resolveRegistryConsumerRoute(input, 'api', 'linux-arm64', { runId: 42, runAttempt: 2 }).runner).toBe('ubuntu-24.04-arm');
  expect(resolveRegistryConsumerRoute(input, 'cli', 'portable', { runId: 42, runAttempt: 2 }).runner).toBe('ubuntu-24.04');
  expect(() => resolveRegistryConsumerRoute(input, 'cli', 'linux-x64', { runId: 42, runAttempt: 2 })).toThrow('exact admitted product locator');
  expect(() => resolveRegistryConsumerRoute(input, 'css', 'win32-x64', { runId: 42, runAttempt: 2 })).toThrow();
  expect('mutationAllowed' in darwin).toBe(false);
});

it('registry consumer reusable workflow defaults to prepare, fixes names and never receives publish credentials', () => {
  const workflow = JSON.parse(execFileSync(process.execPath, ['-e',
    'console.log(JSON.stringify(Bun.YAML.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))))',
    '.github/workflows/independent-registry-consumer.yml'], { encoding: 'utf8' }));
  expect(Object.keys(workflow.on)).toEqual(['workflow_call']);
  expect(workflow.on.workflow_call.inputs.mode.default).toBe('prepare');
  expect(workflow.on.workflow_call.inputs.runner).toBeUndefined();
  expect(workflow.on.workflow_call.inputs.profile).toBeUndefined();
  expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
  expect(workflow.jobs.consume.name).toBe('registry-consumer-${{ inputs.module }}-${{ inputs.target }}');
  expect(workflow.jobs.consume['runs-on']).toBe('${{ needs.resolve.outputs.runner }}');
  expect(workflow.jobs.consume.if).toContain("inputs.mode == 'publish'");
  expect(workflow.jobs.consume['timeout-minutes']).toBe(45);
  const command = workflow.jobs.consume.steps.find((row: any) => row.name === 'Run fixed registry-installed product consumer');
  expect(command.run).toBe('bun scripts/run-independent-publication.ts');
  expect(command.env.INDEPENDENT_PUBLICATION_PHASE).toBe('registry-consumer');
  expect(JSON.stringify(workflow).includes('NPM_TOKEN')).toBe(false);
  expect(workflow.jobs.consume.steps.find((row: any) => row.id === 'upload').with.name).toBe('${{ needs.resolve.outputs.artifact_name }}');
});


it('actual parent supervision leaves observer output fresh and preserves its own native supervision', async () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const { runPublicationCommand } = require('../../scripts/lib/afs-publication-command.cjs');
  const base = path.resolve('.test-data'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'consumer-parent-child-'));
  try {
    const directories = reserveRegistryConsumerProducerDirectories(path.join(root, 'consumer'));
    expect(fs.existsSync(directories.output)).toBe(false);
    const child = path.join(root, 'child.cjs');
    fs.writeFileSync(child, `const fs=require('node:fs'),path=require('node:path');const output=process.argv[2];
if(fs.existsSync(output))throw Error('observer requires fresh evidenceDirectory');
fs.mkdirSync(output);fs.mkdirSync(path.join(output,'central-supervision'));
fs.writeFileSync(path.join(output,'central-supervision','observer-original.txt'),'actual observer sentinel');
fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({fixture:'directory lifecycle only'}));
console.log('owned observer child closed');`);
    const outcome = await runPublicationCommand(process.execPath, [child, directories.output], { cwd: root,
      env: { PATH: path.dirname(process.execPath) }, evidence: directories.producer,
      label: 'registry-consumer', timeoutMs: 5000, rawLimit: 16384 });
    expect([outcome.code, outcome.actualWait, outcome.actualClose, outcome.groupAbsent]).toEqual([0,true,true,true]);
    copyRegistryConsumerProducerOriginals(directories, outcome);
    expect(fs.readFileSync(path.join(directories.output,'central-supervision','observer-original.txt'),'utf8')).toBe('actual observer sentinel');
    expect(fs.readdirSync(path.join(directories.output,'producer-supervision')).length).toBe(3);
    expect(() => copyRegistryConsumerProducerOriginals(directories, { ...outcome, groupAbsent:false })).toThrow('closure incomplete');
  } finally { fs.rmSync(root, { recursive:true, force:true }); }
}, 10000);


it('archive preconsumer has distinct fixed artifact/job/transport and shares supervised producer', () => {
  const selectors = { schemaVersion: 2, sourceSha: coordinate.sourceSha, products: [
    { ...coordinate, schemaVersion: undefined, module: 'client' },
  ] };
  const pre = resolveRegistryConsumerRoute(JSON.stringify(selectors), 'client', 'portable', { runId: 12, runAttempt: 2 }, 'prepublish');
  const post = resolveRegistryConsumerRoute(JSON.stringify(selectors), 'client', 'portable', { runId: 12, runAttempt: 2 });
  expect(pre.runner).toBe(post.runner);
  expect(pre.artifactName).toBe('xpod-archive-consumer-client-portable-' + coordinate.sourceSha + '-12-2');
  expect(pre.artifactName === post.artifactName).toBe(false);
  expect(productConsumerStage('prepublish')).toBe('prepublish');
  expect(() => productConsumerStage('verified')).toThrow('Fixed consumer stage');
  const workflow = JSON.parse(execFileSync(process.execPath, ['-e',
    'console.log(JSON.stringify(Bun.YAML.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))))',
    '.github/workflows/independent-archive-consumer.yml'], { encoding: 'utf8' }));
  expect(workflow.jobs.consume.name).toBe('archive-consumer-${{ inputs.module }}-${{ inputs.target }}');
  const step = workflow.jobs.consume.steps.find((value: { name?: string }) => value.name === 'Run fixed archive-installed product consumer');
  expect(step.env.PRODUCT_CONSUMER_STAGE).toBe('prepublish');
  expect(step.env.INDEPENDENT_PUBLICATION_PHASE).toBe('registry-consumer');
  expect(Object.keys(step.env).includes('NPM_TOKEN')).toBe(false);
  expect(workflow.jobs.consume.steps.find((value: { id?: string }) => value.id === 'upload').with.path)
    .toBe('.test-data/independent-archive-consumer/');
});


it('main workflow preserves14 dependency waves and isolates registry credentials to candidate/tag writers', () => {
  const read = (file: string) => JSON.parse(execFileSync(process.execPath, ['-e',
    'console.log(JSON.stringify(Bun.YAML.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))))', file], { encoding: 'utf8' }));
  const main = read('.github/workflows/independent-publication.yml');
  for (let wave = 1; wave <= 14; wave++) {
    const id = 'wave-' + String(wave).padStart(2, '0');
    expect(main.jobs[id].needs).toBe(wave === 1 ? 'archive' : 'wave-' + String(wave - 1).padStart(2, '0'));
    expect(main.jobs[id].uses).toBe('./.github/workflows/independent-publication-wave.yml');
    expect(main.jobs[id].with.wave).toBe(String(wave).padStart(2, '0'));
  }
  expect(main.jobs.archive.name).toBe('pre-${{ matrix.module }}-${{ matrix.target }}');
  expect(main.jobs.promotion.needs).toBe('wave-14');
  expect(main.jobs.promotion['timeout-minutes']).toBe(135);
  const wave = read('.github/workflows/independent-publication-wave.yml');
  expect(wave.jobs.registry.name).toBe('registry-${{ matrix.module }}-${{ matrix.target }}');
  expect(wave.jobs.registry.needs).toEqual(['plan', 'stage']);
  expect(wave.jobs.stage.strategy['max-parallel']).toBe(1);
  expect(wave.jobs.stage['timeout-minutes']).toBe(120);
  expect(wave.jobs.plan.steps.some((step: { env?: Record<string, unknown> }) => step.env && 'NPM_TOKEN' in step.env)).toBe(false);
  expect(wave.jobs.registry.secrets).toBe(undefined);
});


it('reviewed phase workflow command/install/upload windows exactly match the executable planner policies', async () => {
  const { publicationPhaseTimePolicy } = await import('../../scripts/lib/independent-admission/publication-executor');
  for (const phase of ['stage', 'promotion'] as const) {
    const file = phase === 'stage' ? 'independent-publication-wave.yml' : 'independent-publication.yml';
    const workflow = JSON.parse(execFileSync(process.execPath, ['-e',
      'console.log(JSON.stringify(Bun.YAML.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))))',
      '.github/workflows/' + file], { encoding: 'utf8' }));
    const job = workflow.jobs[phase];
    const command = phase === 'stage' ? 'Stage admitted family candidates without promotion' : 'Reobserve complete cohort and authorize single-use promotion';
    const upload = phase === 'stage' ? 'Upload family stage originals' : 'Upload final admission and promotion originals';
    const policy = publicationPhaseTimePolicy[phase];
    expect(job['timeout-minutes']).toBe(policy.jobMinutes);
    expect(job.steps.find((step: { name?: string }) => step.name === command)['timeout-minutes']).toBe(policy.executionMinutes);
    expect(job.steps.find((step: { name?: string }) => step.name === upload)['timeout-minutes']).toBe(policy.uploadMinutes);
    expect(job.steps.find((step: { name?: string }) => step.name === 'Install reviewed publication toolchain')['timeout-minutes']).toBe(policy.installationMinutes);
  }
});
