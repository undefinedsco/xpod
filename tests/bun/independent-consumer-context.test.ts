import { expect, test } from 'bun:test';
import { clientConsumerProbeSource, cliConsumerExportModes, consumerObservationView, observeClientConsumer, observeCliConsumer, observeRegistryInstalledClientConsumer, observeRegistryInstalledCliConsumer, preflightRegistryInstalledClientConsumer, preflightRegistryInstalledCliConsumer } from '../../scripts/lib/independent-admission/consumer-context';
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
      const { resolutions, ...reported } = JSON.parse(result.stdout);
      expect(reported).toEqual({ schemaVersion: 1, name: 'fixture', version: '1.0.0', exports: ['.', './data'] });
      expect(resolutions.length).toBe(2);
      expect(resolutions.every((row: any) => row.path.startsWith(fs.realpathSync(pkg) + path.sep) && /^[a-f0-9]{64}$/u.test(row.sha256))).toBe(true);
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

test('actual registry installers reject serialized artifact/readback approval before network', async () => {
  const input = { artifact: { status: 'verified' }, peers: [], stage: 'postpublish' as const,
    registryObservation: { registryInstallVerified: true }, evidenceDirectory: '/unused' };
  await expect(observeRegistryInstalledClientConsumer(input)).rejects.toThrow('real collected');
  await expect(observeRegistryInstalledCliConsumer({ ...input, client: {} })).rejects.toThrow('real collected');
});

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { registryConsumerInstallArguments, verifyInstalledConsumerInventory, estimateConsumerWriteBudget } from '../../scripts/lib/independent-admission/consumer-context';
test('fixed install flags consume exact loopback registry bytes without running scripts or auto peers', async () => {
  // Test-only loopback substitution is confined here. No production observer,
  // collector or issuer accepts this registry or manufactures a capability.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-registry-install-test-'));
  let server: Server | undefined;
  let port = 0;
  try {
    const name = 'xpod-consumer-loopback-fixture';
    const source = path.join(root, 'source'); fs.mkdirSync(path.join(source, 'package'), { recursive: true });
    const manifest = { name, version: '1.0.0', exports: './index.cjs', bin: { 'loopback-bin': './bin.cjs' }, peerDependencies: { 'never-fetch-auto-peer': '^1.0.0' }, peerDependenciesMeta: { 'never-fetch-auto-peer': { optional: true } },
      scripts: { postinstall: "echo forbidden > lifecycle-executed" } };
    fs.writeFileSync(path.join(source, 'package', 'package.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(source, 'package', 'index.cjs'), 'exports.ok = true;');
    fs.writeFileSync(path.join(source, 'package', 'bin.cjs'), '#!/usr/bin/env bun\nexports.ok = true;\n', { mode: 0o755 });
    const require = createRequire(import.meta.url);
    const archive = path.join(root, 'fixture.tgz');
    require('tar').c({ gzip: true, sync: true, cwd: source, file: archive }, ['package']);
    const tarball = fs.readFileSync(archive), integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64');
    const requests: string[] = [];
    server = createServer((request, response) => {
      const pathname = new URL(request.url!, 'http://127.0.0.1').pathname; requests.push(pathname);
      if (pathname === '/fixture.tgz') { response.end(tarball); return; }
      if (pathname !== '/' + name) { response.statusCode = 404; response.end('not found'); return; }
      const version = { ...manifest, dist: { tarball: `http://127.0.0.1:${port}/fixture.tgz`, integrity } };
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': version } }));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('loopback fixture unavailable');
    port = address.port;
    const cwd = path.join(root, 'installed'); fs.mkdirSync(cwd);
    const evidence = path.join(root, 'evidence'); fs.mkdirSync(evidence);
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ private: true, dependencies: { [name]: '1.0.0' } }));
    const fixed = registryConsumerInstallArguments(path.join(root, 'cache'));
    expect(fixed.includes('https://registry.npmjs.org/')).toBe(true);
    const loopback = fixed.map(argument => argument === 'https://registry.npmjs.org/' ? `http://127.0.0.1:${port}/` : argument);
    const { runPublicationCommand } = require('../../scripts/lib/afs-publication-command.cjs');
    const outcome = await runPublicationCommand(process.execPath, loopback, { cwd, evidence, label: 'loopback-install', timeoutMs: 5000,
      rawLimit: 262144, env: { PATH: path.dirname(process.execPath), HOME: root, TMPDIR: root } }).catch((error: Error) => { throw new Error(error.message + ': ' + fs.readFileSync(path.join(evidence, 'loopback-install.stderr.raw.log'), 'utf8')); });
    expect(outcome.actualWait && outcome.actualClose && outcome.groupAbsent && outcome.rawComplete).toBe(true);
    expect(fs.readFileSync(path.join(cwd, 'node_modules', name, 'index.cjs'), 'utf8')).toBe('exports.ok = true;');
    expect(fs.existsSync(path.join(cwd, 'node_modules', name, 'lifecycle-executed'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, 'node_modules', 'never-fetch-auto-peer'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, 'bun.lock'))).toBe(true);
    // Synthetic expected payloads exercise only the pure integrity checker;
    // they cannot enter the private production collector/consumer capability map.
    const fixtureFiles = ['package.json', 'index.cjs', 'bin.cjs'];
    const readMember = (name: string) => fs.readFileSync(path.join(source, 'package', name));
    const expected = { identity: { sourceSha: 'a'.repeat(40), package: name, version: '1.0.0', integrity,
      archiveSha256: createHash('sha256').update(tarball).digest('hex'), archiveBytes: tarball.length },
      members: fixtureFiles.map(file => { const bytes = readMember(file); return { path: file, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), mode: fs.statSync(path.join(source, 'package', file)).mode & 0o777 }; }), readMember };
    const inventory = verifyInstalledConsumerInventory(cwd, [expected]);
    expect(inventory.inventories[0]!.files.length).toBe(3);
    expect(inventory.generatedBinLinks[0]!.name).toBe('loopback-bin');
    expect(inventory.generatedBinLinks[0]!.memberSha256).toBe(expected.members.find(row => row.path === 'bin.cjs')!.sha256);
    expect(fs.lstatSync(path.join(cwd, 'node_modules', '.bin', 'loopback-bin')).isSymbolicLink()).toBe(true);
    fs.writeFileSync(path.join(cwd, 'probe-input.json'), JSON.stringify({ name, version: '1.0.0',
      packageRoot: path.join(cwd, 'node_modules', name), absentPeers: ['never-fetch-auto-peer'], exports: ['.'] }));
    for (const mode of ['esm', 'cjs'] as const) {
      const script = 'probe.' + (mode === 'esm' ? 'mjs' : 'cjs');
      fs.writeFileSync(path.join(cwd, script), clientConsumerProbeSource(mode));
      for (const runtime of ['node', 'bun']) {
        const executable = (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, runtime))
          .find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
        expect(Boolean(executable)).toBe(true);
        const resolved = spawnSync(executable!, [script], { cwd, env: {}, encoding: 'utf8', timeout: 2000 });
        expect(resolved.status).toBe(0);
        expect(JSON.parse(resolved.stdout).resolutions[0].sha256).toBe(expected.members.find(row => row.path === 'index.cjs')!.sha256);
      }
    }
    fs.writeFileSync(path.join(cwd, 'node_modules', name, 'index.cjs'), 'altered');
    expect(() => verifyInstalledConsumerInventory(cwd, [expected])).toThrow('inventory or mode mismatch');

  } finally { server?.closeAllConnections(); server?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 10000);

test('registry material preflight is read-only and rejects fake artifacts', () => {
  expect(() => preflightRegistryInstalledClientConsumer({ artifact: {} })).toThrow('real collected');
  expect(() => preflightRegistryInstalledCliConsumer({ artifact: {}, client: {} })).toThrow('real collected');
});

test('registry estimate supports the actual CLI/client expansion while preserving fixed limits', () => {
  const actual = estimateConsumerWriteBudget({ preparation: 'registry', payloadBytes: (7942773 + 223723) * 4,
    evidenceBytes: 4 * 1024 ** 2, capabilityCount: 2, profileCount: 4 });
  expect(actual.estimatedWriteBytes).toBe(134858240);
  expect(actual.maxEstimatedWriteBytes).toBe(256 * 1024 ** 2);
  expect(actual.writeBudgetScope).toBe('estimate-not-filesystem-quota');
  expect(() => estimateConsumerWriteBudget({ preparation: 'registry', payloadBytes: 256 * 1024 ** 2,
    evidenceBytes: 0, capabilityCount: 2, profileCount: 4 })).toThrow('fixed budget');
  expect(() => estimateConsumerWriteBudget({ preparation: 'registry', payloadBytes: 0,
    evidenceBytes: 0, capabilityCount: 129, profileCount: 4 })).toThrow('fixed limits');
  expect(estimateConsumerWriteBudget({ preparation: 'archive', payloadBytes: 1, evidenceBytes: 0,
    capabilityCount: 2, profileCount: 2 }).maxEstimatedWriteBytes).toBe(64 * 1024 ** 2);
});

test('archive full CLI and dependency closure can fit its separate fixed estimate', () => {
  const archive = estimateConsumerWriteBudget({ preparation: 'archive', payloadBytes: (7942773 + 223723) * 2,
    evidenceBytes: 2 * 1024 ** 2, capabilityCount: 2, profileCount: 2 });
  expect(archive.estimatedWriteBytes).toBe(18430144);
  expect(archive.maxEstimatedWriteBytes).toBe(64 * 1024 ** 2);
  expect(archive.writeBudgetScope).toBe('estimate-not-filesystem-quota');
  expect(() => estimateConsumerWriteBudget({ preparation: 'archive', payloadBytes: 65 * 1024 ** 2,
    evidenceBytes: 0, capabilityCount: 2, profileCount: 2 })).toThrow('fixed budget');
});
