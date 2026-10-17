import { expect, test } from 'bun:test';
import { clientConsumerProbeSource, consumerObservationView, observeClientConsumer } from '../../scripts/lib/independent-admission/consumer-context';
test('serialized consumer facts never issue a capability', () => {
  expect(consumerObservationView({ allProfilesVerified: true })).toBeUndefined();
  expect(consumerObservationView(null)).toBeUndefined();
});
test('runner rejects forged artifacts before creating evidence or running code', async () => {
  await expect(observeClientConsumer({ artifact: { status: 'verified' }, stage: 'prepublish', evidenceDirectory: '/unused' })).rejects.toThrow('real collected');
});

// Synthetic package tests only the fixed probe program; it never issues an artifact
// or consumer observation capability.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
test('fixed probes resolve both module modes inside their isolated fixture', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-consumer-probe-test-'));
  try {
    const pkg = path.join(root, 'node_modules', 'fixture');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', exports: { '.': { import: './index.mjs', require: './index.cjs' } } }));
    fs.writeFileSync(path.join(pkg, 'index.mjs'), 'export const ok = true;');
    fs.writeFileSync(path.join(pkg, 'index.cjs'), 'exports.ok = true;');
    const spec = { name: 'fixture', version: '1.0.0', packageRoot: pkg, exports: ['.'], absentPeers: ['absent-fixture-peer'] };
    fs.writeFileSync(path.join(root, 'probe-input.json'), JSON.stringify(spec));
    for (const mode of ['esm', 'cjs'] as const) {
      const script = path.join(root, 'probe.' + (mode === 'esm' ? 'mjs' : 'cjs'));
      fs.writeFileSync(script, clientConsumerProbeSource(mode));
      const result = spawnSync(process.execPath, [script], { cwd: root, env: {}, encoding: 'utf8', timeout: 2000 });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 1, name: 'fixture', version: '1.0.0', exports: ['.'] });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
