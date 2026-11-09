import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';

it('verifies SDK chunk custody, shared budgets, cancellation and raw compatibility', () => {
  const result = spawnSync('python3', [
    '-B', path.resolve('qlever/tests/test_sdk_chunk_originals.py'),
  ], { encoding: 'utf8', timeout: 60_000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toMatch(/Ran [1-9][0-9]* tests/);
  expect(result.stderr).toContain('\nOK');
}, 65_000);
