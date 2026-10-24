/** Keep the legal fixture's process-wide module mocks inside a bounded child. */
import { test, expect } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS } from '../../scripts/lib/independent-admission/github-origin';

test('legal private-issuer cases run without replacing parent module exports', () => {
  const result = spawnSync(process.execPath, ['test', '--timeout', '30000',
    './tests/scripts/legal-private-fixture-isolated_spec_.ts'], {
    cwd: path.resolve(import.meta.dir, '../..'), encoding: 'utf8',
    timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.error, undefined, output);
  assert.equal(result.signal, null, output);
  assert.equal(result.status, 0, output);
  assert.match(output, /\b1 pass\b/u);
  expect(output).toContain('genuine native/source handles bridge');
  expect(API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS.length).toBeGreaterThan(0);
  for (const group of API_CONTROLLED_DESCRIPTOR_SOURCE_GROUPS) {
    expect(group.sourceBindings.length).toBeGreaterThan(0);
  }
});
