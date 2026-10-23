import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';

it('streams physical archive readback while preserving member checks and validating the gzip trailer', () => {
  const result = spawnSync('python3', ['-B', path.resolve('tests/scripts/physical_module_readback_test.py')], { encoding: 'utf8', timeout: 30_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ passed: 20 });
}, 35_000);
