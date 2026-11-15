import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';

it('preserves retained accounting, counted-path exceptions and hardlink multiplicity without walking unbilled forests', () => {
  const result = spawnSync('python3', ['-B', path.resolve('tests/scripts/inngest_total_check_scope_test.py')], { encoding: 'utf8', timeout: 30_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ passed: 10 });
}, 35_000);
