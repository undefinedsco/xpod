import { expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { parseIndependentPublicationRequest } from '../../scripts/run-independent-publication';

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
