import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

const repoRoot = path.resolve(__dirname, '../..');
const script = path.join(repoRoot, 'qlever/scripts/check-rdf-default-graph-cache.cjs');

describe('sqlite backend default graph key', () => {
  it('observes external default graphs and drops rolled-back ones using the production schema and hashes', () => {
    const result = spawnSync('node', [script], { cwd: repoRoot, env: process.env, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0) throw new Error(output || result.error?.message || `Native regression exited ${result.status}`);
    expect(output).toContain('COMPILE strict=1');
    expect(output).toContain('SCHEMA production=1 hashes=production');
    expect(output).toMatch(/REGRESSION1[^\n]*ok=1/u);
    expect(output).toMatch(/REGRESSION2[^\n]*ok=1/u);
    expect(output).not.toContain('ok=0');
  }, 120_000);
});
