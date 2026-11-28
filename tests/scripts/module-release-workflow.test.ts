import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { provenanceProblems } from '../../scripts/module-release/verify-published';

const root = path.resolve(import.meta.dir, '../..');
const workflow = parse(readFileSync(path.join(root, '.github/workflows/module-release.yml'), 'utf8'));
const expected = { repository: 'undefinedsco/xpod', sha: 'a'.repeat(40), run: '123' };
const digest = 'b'.repeat(128);

/** Same shape as the SLSA v1 statement npm attaches to a provenance publish. */
function statement(overrides: { ref?: string; repository?: string; path?: string; commit?: string; run?: string; digest?: string } = {}) {
  return {
    subject: [{ name: 'pkg:npm/%40undefineds.co/xpod-cli@1.2.3', digest: { sha512: overrides.digest ?? digest } }],
    predicate: {
      buildDefinition: {
        externalParameters: { workflow: { ref: overrides.ref ?? 'refs/heads/staging', repository: overrides.repository ?? 'https://github.com/undefinedsco/xpod',
          path: overrides.path ?? '.github/workflows/module-release.yml' } },
        resolvedDependencies: [{ uri: 'git+https://github.com/undefinedsco/xpod@refs/heads/staging', digest: { gitCommit: overrides.commit ?? expected.sha } }],
      },
      runDetails: { metadata: { invocationId: `https://github.com/undefinedsco/xpod/actions/runs/${overrides.run ?? expected.run}/attempts/1` } },
    },
  };
}

describe('module release provenance read-back', () => {
  it('accepts a statement binding this package digest to the repo, staging, commit and run', () => {
    expect(provenanceProblems(statement(), '@undefineds.co/xpod-cli', digest, expected)).toEqual([]);
  });

  it('rejects provenance from another branch, workflow, commit, run or package digest', () => {
    const problems = (overrides: Parameters<typeof statement>[0]) => provenanceProblems(statement(overrides), '@undefineds.co/xpod-cli', digest, expected);
    expect(problems({ ref: 'refs/heads/feature' })).toEqual(['provenance ref is refs/heads/feature']);
    expect(problems({ path: '.github/workflows/other.yml' })).toEqual(['provenance workflow is .github/workflows/other.yml']);
    expect(problems({ commit: 'c'.repeat(40) })).toEqual([`provenance commit is ${'c'.repeat(40)}`]);
    expect(problems({ run: '999' })[0]).toStartWith('provenance run is');
    expect(problems({ digest: 'd'.repeat(128) })).toEqual(['provenance subject does not match the package digest']);
  });
});

describe('module release workflow', () => {
  const jobs = workflow.jobs as Record<string, { permissions?: Record<string, string>; env?: Record<string, string>; if?: string; steps: { run?: string }[] }>;

  it('builds only from staging and is dispatched by hand', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(jobs.build.steps[0].run).toContain('refs/heads/staging');
  });

  it('gives the signing permission and the npm token only to the jobs that publish or promote', () => {
    for (const [name, job] of Object.entries(jobs)) {
      expect(job.permissions?.['id-token'] === 'write').toBe(name === 'publish');
      expect(Boolean(job.env?.NODE_AUTH_TOKEN)).toBe(name === 'publish' || name === 'promote');
      expect(job.permissions?.contents === 'write').toBe(name === 'promote');
    }
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('publishes with provenance to next only in publish mode and promotes only on request', () => {
    expect(jobs.publish.if).toContain("inputs.mode == 'publish'");
    expect(jobs.publish.steps.map(step => step.run ?? '').join('\n')).toContain('--provenance --access public --tag next');
    expect(jobs.promote.if).toContain('inputs.promote');
  });
});
