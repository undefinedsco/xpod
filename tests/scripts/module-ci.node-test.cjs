const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { classify, changedPaths, checkRequired, CLI_ONLY } = require('../../scripts/module-ci.cjs');
test('isolated CLI host changes select CLI without services, mixed auth changes select services', () => {
  assert.equal(classify(['packages/xpod-cli/src/module-store.ts']).service, false);
  assert.equal(classify(['packages/xpod-cli/src/module-store.ts']).cli, true);
  for (const path of ['packages/xpod-cli/src/lib/auth-context.ts', 'packages/xpod-cli/src/client.ts', 'packages/xpod-cli/scripts/build-package.ts', 'bun.lock', 'src/api/main.ts', 'unknown/file']) assert.equal(classify([path]).service, true, path);
  assert.equal(classify(['packages/xpod-cli/src/core.ts', 'src/storage/accessor.ts']).service, true);
});
test('documentation skips runtime jobs but release and repository contracts remain checked', () => {
  assert.equal(classify(['docs/module-distribution.md']).service, false);
  assert.equal(classify(['docs/RELEASE.md']).service, true);
  assert.equal(classify(['AGENTS.md']).service, true);
});
test('first push, missing refs and diff errors fail conservatively; renames retain both boundaries', () => {
  assert.equal(classify([], changedPaths('0'.repeat(40), 'a'.repeat(40)).fallback).service, true);
  assert.equal(changedPaths('b'.repeat(40), 'a'.repeat(40), () => { throw Error('missing object'); }).fallback, true);
  const changed = changedPaths('b'.repeat(40), 'a'.repeat(40), (_, args) => { assert.ok(args.includes('--no-renames')); return 'packages/xpod-cli/src/core.ts\0src/api/new.ts\0'; });
  assert.equal(classify(changed.paths).service, true);
});
test('required gate rejects skipped or cancelled selected jobs and missing classification', () => {
  const n = { impact: { result: 'success', outputs: { cli: 'true', service: 'false' } }, contracts: { result: 'success' }, cli: { result: 'success' } };
  checkRequired(n);
  for (const status of ['skipped', 'cancelled', 'failure']) assert.throws(() => checkRequired({ ...n, cli: { result: status } }));
  assert.throws(() => checkRequired({ ...n, impact: { result: 'failure' } }));
  assert.throws(() => checkRequired({ ...n, impact: { result: 'success', outputs: {} } }));
  assert.throws(() => checkRequired({ ...n, impact: { result: 'success', outputs: { cli: 'true', service: 'true' } } }));
});
test('candidate workflow excludes precisely the independent CLI paths before acquiring the RC queue', () => {
  const candidate = fs.readFileSync('.github/workflows/candidate.yml', 'utf8');
  const exclusions = candidate.split('paths-ignore:\n')[1].split('\n  workflow_dispatch:')[0];
  const paths = [...exclusions.matchAll(/- '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(paths.sort(), [...CLI_ONLY].sort());
  assert.ok(candidate.includes("needs.impact.outputs.service == 'true'"));
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  for (const name of ['test', 'integration-lite', 'integration-full', 'bun-runtime', 'package-smoke', 'package-smoke-bun']) assert.match(ci, new RegExp(`  ${name}:\\n    needs: impact\\n    if:`));
});
