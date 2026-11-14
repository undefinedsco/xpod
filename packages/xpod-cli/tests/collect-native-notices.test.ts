import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { collectNativeNotices, generateNativeNotices, type Inventory, type RuntimeNoticeEvidence } from '../scripts/collect-native-notices';
import { sha256File } from '../src/manifest';
import { copyNativeNotices } from '../src/native-notices';

test('four targets generate from independently bound Cargo and runtime files, without a pre-existing index', () => {
  const parent = path.resolve('.test-data/native-notice-collector'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-'));
  try {
    for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
      const notice = path.join(root, target + '.txt'); writeFileSync(notice, `original ${target}\r\n`);
      const hash = sha256File(notice);
      const inventory: Inventory = { target: target.replace('darwin-', 'macos-'), packages: [{ name: 'fixture-crate', version: '1.0.0', source: 'registry+https://github.com/rust-lang/crates.io-index', licenseResolved: null, activeFeatures: [], rolesFromMetadataNotBuildUnits: ['normal'], licenseFiles: [{ path: notice, relativePath: 'LICENSE', sha256: hash }] }] };
      const runtime: RuntimeNoticeEvidence = { target, runtimeNotices: { toolchain: 'nightly-2026-09-30', compilerCommit: 'a'.repeat(40), scope: 'synthetic fixture, not release evidence', files: [{ path: notice, sourcePath: 'LICENSE', source: 'fixture:actual-file', sha256: hash }] } };
      const out = path.join(root, target);
      collectNativeNotices(target, inventory, runtime, out);
      const index = JSON.parse(readFileSync(path.join(out, target + '.json'), 'utf8'));
      expect(index.target).toBe(target); expect(index.packages[0].licenseExpression).toBeNull();
      expect(JSON.stringify(index)).not.toContain(root);
      expect(sha256File(path.join(out, 'objects', hash + '.txt'))).toBe(hash);
      expect(copyNativeNotices(out, path.join(root, target + '-copy'), target, { toolchain: runtime.runtimeNotices.toolchain, commit: runtime.runtimeNotices.compilerCommit })).toHaveLength(2);
      for (const invalid of [ { ...runtime, target: 'other' }, { ...runtime, runtimeNotices: { ...runtime.runtimeNotices, compilerCommit: 'unknown' } }, { ...runtime, runtimeNotices: { ...runtime.runtimeNotices, files: [] } } ]) {
        const refused = path.join(root, target + '-refused');
        expect(() => collectNativeNotices(target, inventory, invalid, refused)).toThrow(); expect(existsSync(refused)).toBe(false);
      }
      expect(() => collectNativeNotices(target, { ...inventory, target: 'other' }, runtime, path.join(root, 'wrong'))).toThrow('Inventory target mismatch');
      const external = path.join(root, target + '-external'); writeFileSync(external, 'controlled-outside-marker');
      const linked = path.join(root, target + '-link'); symlinkSync(external, linked);
      const linkedRuntime = { ...runtime, runtimeNotices: { ...runtime.runtimeNotices, files: [{ ...runtime.runtimeNotices.files[0], path: linked, sha256: sha256File(external) }] } };
      expect(() => collectNativeNotices(target, inventory, linkedRuntime, path.join(root, 'linked-output'))).toThrow('regular file');
      expect(existsSync(path.join(root, 'linked-output'))).toBe(false);
      writeFileSync(notice, 'changed bytes');
      expect(() => collectNativeNotices(target, inventory, runtime, path.join(root, 'drift'))).toThrow('Runtime notice drift'); expect(existsSync(path.join(root, 'drift'))).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('actual producer protocol uses filtered metadata and sysroot bytes, excludes dev-only and binds output provenance', () => {
  const parent = path.resolve('.test-data/native-notice-collector'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'producer-'));
  try {
    const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
    const doc = path.join(root, 'sysroot/share/doc/rust'); mkdirSync(path.join(doc, 'licenses'), { recursive: true });
    writeFileSync(path.join(doc, 'COPYRIGHT-library.html'), 'original synthetic runtime copyright\r\n');
    writeFileSync(path.join(doc, 'licenses/MIT.txt'), 'original synthetic fixture terms\n');
    const packages = ['fixture-root', 'fixture-build', 'fixture-dev'].map(name => {
      const dir = path.join(root, name); mkdirSync(dir); writeFileSync(path.join(dir, 'LICENSE'), `original ${name}\n`);
      return { id: name, name, version: '1.0.0', source: 'registry+fixture', license: null, license_file: null, manifest_path: path.join(dir, 'Cargo.toml') };
    });
    const metadataFile = path.join(root, 'metadata.json');
    writeFileSync(metadataFile, JSON.stringify({ packages, resolve: { root: 'fixture-root', nodes: [
      { id: 'fixture-root', features: ['actual-feature'], deps: [{ pkg: 'fixture-build', dep_kinds: [{ kind: 'build' }] }, { pkg: 'fixture-dev', dep_kinds: [{ kind: 'dev' }] }] },
      { id: 'fixture-build', features: [], deps: [] }, { id: 'fixture-dev', features: [], deps: [] },
    ] } }));
    const cargo = path.join(root, 'cargo'); const rustc = path.join(root, 'rustc');
    writeFileSync(cargo, `#!/bin/sh\nprintf '%s\\n' "$@" > '${root}/cargo-args'\n/bin/cat '${metadataFile}'\n`); chmodSync(cargo, 0o700);
    writeFileSync(rustc, `#!/bin/sh\nprintf '%s\\n' '${root}/sysroot'\n`); chmodSync(rustc, 0o700);
    for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
      const triple = `${target.endsWith('arm64') ? 'aarch64' : 'x86_64'}-${target.startsWith('darwin') ? 'apple-darwin' : 'unknown-linux-gnu'}`;
      const destination = path.join(root, target);
      const compiler = { toolchain: 'nightly-2026-09-30', rustcVersion: `commit-hash: ${'a'.repeat(40)}\nhost: ${triple}\n` };
      const result = generateNativeNotices({ target, workspace, cargo, rustc, env: {}, compiler, sourceKitSHA256: 'b'.repeat(64), destination });
      const index = JSON.parse(readFileSync(path.join(destination, target + '.json'), 'utf8'));
      expect(index.packages.map((entry: { name: string }) => entry.name)).toEqual(['fixture-root', 'fixture-build']);
      expect(index.runtimeNotices.files).toHaveLength(2); expect(index.packages[1].rolesAdvisory).toEqual(['build']);
      expect(readFileSync(path.join(root, 'cargo-args'), 'utf8')).toContain(`--filter-platform\n${triple}\n`);
      expect(result.indexSHA256).toBe(sha256File(path.join(destination, target + '.json')));
      expect(result.provenanceSHA256).toBe(sha256File(path.join(destination, 'provenance.json')));
      expect(readFileSync(path.join(destination, 'provenance.json'), 'utf8')).not.toContain(root);
      expect(() => generateNativeNotices({ target, workspace, cargo, rustc, env: {}, compiler: { ...compiler, rustcVersion: 'host: unknown' }, sourceKitSHA256: 'b'.repeat(64), destination: path.join(root, 'refused') })).toThrow('compiler target mismatch');
    }
    const target = 'linux-x64'; const compiler = { toolchain: 'nightly-2026-09-30', rustcVersion: `commit-hash: ${'a'.repeat(40)}\nhost: x86_64-unknown-linux-gnu\n` };
    const outside = path.join(root, 'outside'); mkdirSync(outside); writeFileSync(path.join(outside, 'terms'), 'controlled-outside-secret-marker');
    const packageRoot = path.dirname(packages[0].manifest_path);
    symlinkSync(path.join(outside, 'terms'), path.join(packageRoot, 'linked-license'));
    symlinkSync(outside, path.join(packageRoot, 'linked-dir'));
    for (const license_file of ['linked-license', 'linked-dir/terms', '../outside/terms']) {
      const metadata = JSON.parse(readFileSync(metadataFile, 'utf8')); metadata.packages[0].license_file = license_file; writeFileSync(metadataFile, JSON.stringify(metadata));
      const destination = path.join(root, 'escaped-' + license_file.replace(/\W/g, '_'));
      expect(() => generateNativeNotices({ target, workspace, cargo, rustc, env: {}, compiler, sourceKitSHA256: 'b'.repeat(64), destination })).toThrow();
      expect(existsSync(destination)).toBe(false);
    }
    const metadata = JSON.parse(readFileSync(metadataFile, 'utf8')); metadata.packages[0].license_file = null; writeFileSync(metadataFile, JSON.stringify(metadata));
    unlinkSync(path.join(doc, 'licenses/MIT.txt')); symlinkSync(path.join(outside, 'terms'), path.join(doc, 'licenses/MIT.txt'));
    const destination = path.join(root, 'escaped-runtime');
    expect(() => generateNativeNotices({ target, workspace, cargo, rustc, env: {}, compiler, sourceKitSHA256: 'b'.repeat(64), destination })).toThrow('symbolic link');
    expect(existsSync(destination)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
