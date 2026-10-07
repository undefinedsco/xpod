import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';

// Keep the real-runtime checks in the default Vitest gate; node:test runs in its own process.
const fixture = './tests/scripts/browser-external-rp-close.node-test.cjs';

it.each([
  ['Bun', 'bun', ['--no-env-file', 'test', fixture]],
  ['Node', 'node', ['--experimental-strip-types', '--test', fixture]],
] as const)('closes the external RP without losing primary errors under %s', (_runtime, executable, args) => {
  const result = spawnSync(executable, [...args], {
    cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 20_000);
