import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

/** Portable SDK70 executable-memory-remap policy wrapper.
 *
 * This runs the canonical pure-predicate and Observer-contract Python modules on
 * every platform, so a remap-policy regression fails fast even off Linux. It
 * re-implements none of their assertions: it launches the real modules and
 * requires a nonzero case count and a clean exit.
 *
 * The real native (ptrace/maps/ELF) end-to-end proof runs ONLY in the dedicated
 * Linux gate `qlever/tests/run_sdk70_mremap_gate.py`, which must never execute
 * as a default Mac/unit case.
 */
const ROOT = path.resolve(import.meta.dir, '../..');
const TESTS = path.join(ROOT, 'qlever/tests');

/** Canonical modules that are pure policy/contract and therefore portable. */
const MODULES = ['test_sdk70_mremap_predicate.py', 'test_sdk70_mremap_observer.py'] as const;

const python = (): string => {
  for (const candidate of ['/usr/bin/python3', 'python3']) {
    const probe = spawnSync(candidate, ['-c', 'import sys;print(sys.version_info[0])'], {
      encoding: 'utf8',
    });
    if (probe.status === 0 && probe.stdout.trim() === '3') return candidate;
  }
  throw new Error('python3 is required to run the SDK70 remap policy modules');
};

describe('SDK70 executable-memory remap policy', () => {
  it('runs the canonical remap policy suite with a nonzero count, no skips, clean exit', () => {
    const result = spawnSync(
      python(),
      ['-B', '-m', 'unittest', '-v', ...MODULES.map(name => name.replace(/\.py$/u, ''))],
      {
        cwd: TESTS,
        encoding: 'utf8',
        env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
        timeout: 120_000,
      },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    // A missing or emptied module makes this launch fail, so the assertion below
    // is not a filesystem check standing in for real coverage.
    if (result.status !== 0) throw new Error(`SDK70 remap policy modules failed:\n${output}`);
    expect(result.status).toBe(0);

    const ran = /Ran (\d+) tests?/u.exec(output);
    expect(ran, `runner must report a case count:\n${output}`).not.toBeNull();
    expect(Number(ran![1])).toBeGreaterThan(0);
    // A skip would mean the policy silently stopped being enforced.
    expect(/skipped=[1-9]/u.test(output), `no case may be skipped:\n${output}`).toBe(false);
  }, 130_000);
});
