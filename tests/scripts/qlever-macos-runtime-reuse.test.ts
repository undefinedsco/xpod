import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
  name?: string;
  if?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  run?: string;
}

describe('macOS QLever runtime reuse', () => {
  it('skips compilation only on an exact native-input cache hit and rechecks that runtime', async () => {
    const workflow = parseDocument(await readFile(path.resolve(__dirname,
      '../../.github/workflows/build-qlever-macos-runtime.yml'), 'utf8')).toJSON();
    const steps = workflow.jobs.build.steps as WorkflowStep[];
    const named = (name: string) => {
      const step = steps.find(value => value.name === name);
      expect(step, name).toBeDefined();
      return step!;
    };
    const cache = named('Restore verified native runtime');
    expect(cache.with?.key).toContain("hashFiles('qlever/**'");
    expect(cache.with?.key).toContain('.github/workflows/build-qlever-macos-runtime.yml');
    expect(cache.with?.key).toContain('steps.toolchain.outputs.identity');
    expect(cache.with?.key).not.toMatch(/github.sha|SOURCE_SHA|package.json/u);
    expect(cache.with?.['restore-keys']).toBeUndefined();
    for (const name of ['Install the upstream native toolchain', 'Cache the compiler cache',
      'Resolve build parallelism', 'Build, bundle, sign, and smoke the native runtime']) {
      expect(named(name).if).toBe("steps.runtime_cache.outputs.cache-hit != 'true'");
    }
    const reuse = named('Verify and smoke the reused native runtime');
    expect(reuse.if).toBe("steps.runtime_cache.outputs.cache-hit == 'true'");
    expect(reuse.run).toContain('verify-qlever-local');
    expect(reuse.run).toContain('--expected-archive');
    expect(reuse.run).toContain('verify-local-runtime-artifacts.py');
    expect(reuse.run).toContain('--lock qlever/qlever.lock.json');
    const evidence = named('Bind the qlever-local acceptance evidence');
    expect(evidence.if).toBeUndefined();
    expect(evidence.env?.SOURCE_SHA).toBe('${{ github.sha }}');
    expect(evidence.run).toContain('create-qlever-local');
    expect(steps.indexOf(evidence)).toBeGreaterThan(steps.indexOf(reuse));
    expect(named('Upload the exact native runtime').if).toBeUndefined();
  });
});
