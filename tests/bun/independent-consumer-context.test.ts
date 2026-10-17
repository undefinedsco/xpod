import { expect, test } from 'bun:test';
import { clientConsumerProbeSource, cliConsumerExportModes, consumerObservationView, observeClientConsumer, observeCliConsumer } from '../../scripts/lib/independent-admission/consumer-context';
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
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', exports: { '.': { import: './index.mjs', require: './index.cjs' }, './data': './data.json' } }));
    fs.writeFileSync(path.join(pkg, 'index.mjs'), 'export const ok = true;');
    fs.writeFileSync(path.join(pkg, 'index.cjs'), 'exports.ok = true;');
    fs.writeFileSync(path.join(pkg, 'data.json'), JSON.stringify({ ok: true }));
    const spec = { name: 'fixture', version: '1.0.0', packageRoot: pkg, exports: ['.', './data'], absentPeers: ['absent-fixture-peer'] };
    fs.writeFileSync(path.join(root, 'probe-input.json'), JSON.stringify(spec));
    for (const mode of ['esm', 'cjs'] as const) {
      const script = path.join(root, 'probe.' + (mode === 'esm' ? 'mjs' : 'cjs'));
      fs.writeFileSync(script, clientConsumerProbeSource(mode));
      const result = spawnSync(process.execPath, [script], { cwd: root, env: {}, encoding: 'utf8', timeout: 2000 });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 1, name: 'fixture', version: '1.0.0', exports: ['.', './data'] });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('CLI export modes follow declarations and retain JSON without invented require conditions', () => {
  const modes = cliConsumerExportModes({ './client': { import: './client.mjs', require: './client.cjs' },
    './output': { import: './output.mjs' }, './producer-materials': './index.json' });
  expect(modes.esm).toEqual(['./client', './output', './producer-materials']);
  expect(modes.cjs).toEqual(['./client', './producer-materials']);
  expect(modes.pending).toEqual([]);
  expect(cliConsumerExportModes({ './*': './dist/*.mjs', './types': { types: './types.d.ts' } }).pending.length).toBe(3);
});
test('CLI runner does not accept serialized artifact/client authority', async () => {
  await expect(observeCliConsumer({ artifact: { status: 'verified' }, client: {}, stage: 'prepublish', evidenceDirectory: '/unused' })).rejects.toThrow('real collected');
});
test('fixed bin probe executes the shell wrapper under isolated Node and Bun paths', () => {
  // Execute the exact fixed launcher program retained in the implementation,
  // without constructing either artifact or consumer capabilities.
  const source = fs.readFileSync(new URL('../../scripts/lib/independent-admission/consumer-context.ts', import.meta.url), 'utf8');
  const launcher = source.match(/const launcher = String.raw`([\s\S]*?)`;/u)?.[1];
  expect(typeof launcher).toBe('string');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-consumer-shell-test-'));
  try {
    const pkg = path.join(root, 'package'); fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    const bin = path.join(pkg, 'xpod');
    fs.writeFileSync(bin, '#!/bin/sh\nDIR="$(dirname "$0")"\nif command -v bun >/dev/null 2>&1; then exec bun "$DIR/main.cjs" "$@"; else exec node "$DIR/main.cjs" "$@"; fi\n');
    fs.writeFileSync(path.join(pkg, 'main.cjs'), "process.stdout.write(process.argv[2] === '--version' ? '1.0.0\\n' : 'Usage: xpod commands\\n');");
    fs.writeFileSync(path.join(root, 'bin-probe.cjs'), launcher!);
    fs.writeFileSync(path.join(root, 'bin-input.json'), JSON.stringify({ root: pkg, name: 'fixture', version: '1.0.0', bin, absent: ['absent-fixture-peer'] }));
    for (const runtime of ['node', 'bun']) {
      const executable = (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, runtime))
        .find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
      expect(Boolean(executable)).toBe(true);
      const runtimeBin = path.join(root, runtime); fs.mkdirSync(runtimeBin);
      fs.symlinkSync(fs.realpathSync(executable!), path.join(runtimeBin, runtime));
      for (const tool of ['dirname', 'readlink']) fs.symlinkSync(fs.realpathSync('/usr/bin/' + tool), path.join(runtimeBin, tool));
      for (const arg of ['--version', '--help']) {
        const result = spawnSync(executable!, ['bin-probe.cjs', arg], { cwd: root, env: { PATH: runtimeBin, HOME: root }, encoding: 'utf8', timeout: 2000 });
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe(arg === '--version' ? '1.0.0' : 'Usage: xpod commands');
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
