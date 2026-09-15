import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { bundleLocalDependenciesIntoTarball, packWithManifestRestoration } = require('../../scripts/run-npm-pack.cjs');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function json(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}
function fixture(conflict = false, native = false) {
  mkdirSync('.test-data', { recursive: true });
  const root = mkdtempSync(path.resolve('.test-data/npm-pack-runtime-'));
  roots.push(root);
  const source = path.join(root, 'node_modules/auth');
  json(path.join(source, 'package.json'), { name: 'auth', version: '1.0.0', dependencies: { external: '^2.0.0' }, optionalDependencies: { 'other-platform': '^1.0.0' } });
  for (const dir of ['lib', 'config', 'templates', 'bin']) {
    mkdirSync(path.join(source, dir), { recursive: true });
    writeFileSync(path.join(source, dir, 'runtime.js'), 'module.exports = 42;');
  }
  json(path.join(root, 'node_modules/external/package.json'), { name: 'external', version: conflict ? '1.0.0' : '2.0.0' });
  if (conflict) {
    const nested = path.join(source, 'node_modules/external');
    json(path.join(nested, 'package.json'), { name: 'external', version: '2.0.0', main: 'index.js', ...(native ? { os: ['darwin'] } : {}), dependencies: { leaf: '^1.0.0' } });
    writeFileSync(path.join(nested, 'index.js'), 'module.exports = "nested-two";');
    json(path.join(root, 'node_modules/leaf/package.json'), { name: 'leaf', version: '1.0.0' });
  }
  json(path.join(root, 'seed/package/package.json'), { name: 'consumer-package', version: '1.0.0', ...(conflict ? { dependencies: { external: '^1.0.0' } } : {}) });
  const tarball = path.join(root, 'package.tgz');
  execFileSync('tar', ['czf', tarball, '-C', path.join(root, 'seed'), 'package']);
  return { root, source, tarball, dependencies: [{ name: 'auth', sourcePackageRoot: source, repoRoot: root, patchedRuntime: true }] };
}
function unpack(f: ReturnType<typeof fixture>) {
  const out = path.join(f.root, 'out');
  mkdirSync(out);
  execFileSync('tar', ['xf', f.tarball, '-C', out]);
  return path.join(out, 'package');
}
it('ships runtime assets and declares external and uninstalled optional dependencies at the install boundary', () => {
  const f = fixture();
  bundleLocalDependenciesIntoTarball(f.tarball, f.dependencies);
  const packaged = unpack(f);
  const manifest = JSON.parse(readFileSync(path.join(packaged, 'package.json'), 'utf8'));
  expect(manifest).toMatchObject({ dependencies: { auth: '1.0.0', external: '^2.0.0' }, optionalDependencies: { 'other-platform': '^1.0.0' }, bundledDependencies: ['auth'] });
  expect(require(path.join(packaged, 'node_modules/auth/lib/runtime.js'))).toBe(42);
  for (const dir of ['config', 'templates', 'bin']) expect(readFileSync(path.join(packaged, `node_modules/auth/${dir}/runtime.js`), 'utf8')).toContain('42');
});
it('preserves the root version and nests conflicting pure-JS dependencies without losing their external edges', () => {
  const f = fixture(true);
  bundleLocalDependenciesIntoTarball(f.tarball, f.dependencies);
  const packaged = unpack(f);
  const manifest = JSON.parse(readFileSync(path.join(packaged, 'package.json'), 'utf8'));
  expect(manifest.dependencies).toMatchObject({ external: '^1.0.0', leaf: '^1.0.0' });
  expect(require(path.join(packaged, 'node_modules/auth/node_modules/external'))).toBe('nested-two');
});
it('refuses to vendor a host-specific conflicting dependency', () => {
  const f = fixture(true, true);
  expect(() => bundleLocalDependenciesIntoTarball(f.tarball, f.dependencies)).toThrow('Cannot bundle platform-specific dependency conflict: external');
});
it('promotes a root optional dependency when a bundled package requires it', () => {
  const f = fixture();
  json(path.join(f.root, 'seed/package/package.json'), { name: 'consumer-package', version: '1.0.0', optionalDependencies: { external: '^2.0.0' } });
  execFileSync('tar', ['czf', f.tarball, '-C', path.join(f.root, 'seed'), 'package']);
  bundleLocalDependenciesIntoTarball(f.tarball, f.dependencies);
  const manifest = JSON.parse(readFileSync(path.join(unpack(f), 'package.json'), 'utf8'));
  expect(manifest.dependencies.external).toBe('^2.0.0');
  expect(manifest.optionalDependencies).not.toHaveProperty('external');
});

it('restores the source manifest when packing fails after prepack', () => {
  const f = fixture();
  const original = { name: 'original', scripts: { postinstall: 'preserved-hook' } };
  json(path.join(f.root, 'package.json'), original);
  mkdirSync(path.join(f.root, 'scripts'));
  for (const name of ['prepare-package-manifest.cjs', 'platform-binaries.cjs']) {
    cpSync(path.resolve('scripts', name), path.join(f.root, 'scripts', name));
  }
  const command = `require('node:child_process').execFileSync(process.execPath, ['scripts/prepare-package-manifest.cjs', 'pack']); process.exit(7);`;
  expect(() => packWithManifestRestoration(f.root, { command: process.execPath, args: ['-e', command] }, process.env)).toThrow();
  expect(JSON.parse(readFileSync(path.join(f.root, 'package.json'), 'utf8'))).toEqual(original);
  expect(existsSync(path.join(f.root, '.test-data/package.json.pack.backup'))).toBe(false);
});
it('does not overwrite a pre-existing manifest recovery backup', () => {
  const f = fixture();
  json(path.join(f.root, '.test-data/package.json.pack.backup'), { preserved: true });
  expect(() => packWithManifestRestoration(f.root, { command: process.execPath, args: [] }, process.env)).toThrow('backup already exists');
  expect(JSON.parse(readFileSync(path.join(f.root, '.test-data/package.json.pack.backup'), 'utf8'))).toEqual({ preserved: true });
});
