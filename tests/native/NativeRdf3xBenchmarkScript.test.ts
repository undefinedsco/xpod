import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('native SPARQL/RDF3X product benchmark script', () => {
  it('documents and dry-runs a same-dataset product comparison', () => {
    const help = spawnSync('bun', [
      'scripts/native-rdf3x-benchmark.ts',
      '--help',
    ], { encoding: 'utf8' });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('--scale=N');
    expect(help.stdout).toContain('--iterations=N');
    expect(help.stdout).toContain('--image=NAME');

    const dryRun = spawnSync('bun', [
      'scripts/native-rdf3x-benchmark.ts',
      '--dry-run',
      '--scale=20000',
      '--iterations=5',
    ], { encoding: 'utf8' });
    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({
      scale: 20000,
      iterations: 5,
      engines: [ 'direct-sql', 'rdf3x', 'native-sparql' ],
      measurements: [ 'firstRunMs', 'warmMedianMs' ],
    });
  });

  it('waits for the vendor-neutral native SPARQL ABI', () => {
    const source = readFileSync('scripts/native-rdf3x-benchmark.ts', 'utf8');
    expect(source).toContain('xpod_rdf.native_sparql_capabilities()');
    expect(source).not.toContain('xpod_native_version()');
  });
});
