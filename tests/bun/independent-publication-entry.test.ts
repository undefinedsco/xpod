import { expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { runIndependentPublication, parseIndependentPublicationRequest } from '../../scripts/run-independent-publication';

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
