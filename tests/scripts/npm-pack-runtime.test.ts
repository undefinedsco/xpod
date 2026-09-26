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
it('declares private bundles as package-local files so publish normalization cannot invent registry edges', () => {
  const f = fixture();
  // npm publication fills missing bundle edges with "*". File edges retain
  // the bundled copy without asking Bun to resolve an unpublished registry version.
  const dependencies = f.dependencies.map(({ patchedRuntime: _patched, ...entry }) => entry);
  bundleLocalDependenciesIntoTarball(f.tarball, dependencies);
  const manifest = JSON.parse(readFileSync(path.join(unpack(f), 'package.json'), 'utf8'));
  expect(manifest.dependencies.auth).toBe('file:./node_modules/auth');
  expect(manifest.bundledDependencies).toContain('auth');
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
it('omits compiler diagnostics from direct and nested bundles while preserving runtime assets and types', () => {
  const f = fixture(true);
  const direct = path.join(f.source, 'dist');
  const nested = path.join(f.source, 'node_modules/external/dist');
  for (const directory of [direct, nested]) {
    mkdirSync(directory, { recursive: true });
    for (const name of ['index.js', 'index.d.ts', 'LICENSE', 'routes.map', 'index.js.map', 'index.d.ts.map', 'tsconfig.tsbuildinfo']) {
      writeFileSync(path.join(directory, name), name);
    }
  }
  bundleLocalDependenciesIntoTarball(f.tarball, f.dependencies);
  const packaged = unpack(f);
  for (const relative of ['node_modules/auth/dist', 'node_modules/auth/node_modules/external/dist']) {
    for (const name of ['index.js', 'index.d.ts', 'LICENSE', 'routes.map']) {
      expect(existsSync(path.join(packaged, relative, name))).toBe(true);
    }
    for (const name of ['index.js.map', 'index.d.ts.map', 'tsconfig.tsbuildinfo']) {
      expect(existsSync(path.join(packaged, relative, name))).toBe(false);
    }
  }
});
it('omits authored, browser and test trees from bundled dependencies while keeping runtime entries', () => {
  const f = fixture(true);
  const directRoot = f.source;
  const nestedRoot = path.join(f.source, 'node_modules/external');
  for (const [ packageRoot, relativePaths ] of [
    [ directRoot, [
      'dist/index.js', 'dist/index.d.ts', 'dist/vendor/chunk.js',
      'src/index.ts', 'browser/n3.min.js', 'dist/browser/web.js',
      'dist/tests/units.test.ts', 'dist/benchmarks/scale.js', 'docs/guide.md',
    ] ],
    [ nestedRoot, [
      'dist/index.js', 'src/index.ts', 'src/v4/tests/parse.test.ts',
      'browser/n3.min.js', 'test/fixture.js', 'index.d.ts',
    ] ],
  ] as const) {
    for (const relative of relativePaths) {
      const target = path.join(packageRoot, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, relative);
    }
  }
  bundleLocalDependenciesIntoTarball(f.tarball, f.dependencies);
  const packaged = unpack(f);
  for (const relative of [
    'node_modules/auth/dist/index.js',
    'node_modules/auth/dist/index.d.ts',
    'node_modules/auth/dist/vendor/chunk.js',
    'node_modules/auth/node_modules/external/dist/index.js',
    'node_modules/auth/node_modules/external/index.js',
    'node_modules/auth/node_modules/external/index.d.ts',
  ]) {
    expect(existsSync(path.join(packaged, relative)), `${relative} must stay`).toBe(true);
  }
  for (const relative of [
    'node_modules/auth/src/index.ts',
    'node_modules/auth/browser/n3.min.js',
    'node_modules/auth/dist/browser/web.js',
    'node_modules/auth/dist/tests/units.test.ts',
    'node_modules/auth/dist/benchmarks/scale.js',
    'node_modules/auth/docs/guide.md',
    'node_modules/auth/node_modules/external/src/index.ts',
    'node_modules/auth/node_modules/external/src/v4/tests/parse.test.ts',
    'node_modules/auth/node_modules/external/browser/n3.min.js',
    'node_modules/auth/node_modules/external/test/fixture.js',
  ]) {
    expect(existsSync(path.join(packaged, relative)), `${relative} must be dropped`).toBe(false);
  }
});
it('keeps dependencies whose declared entry point points into src or a browser build', () => {
  const f = fixture(true);
  const nestedRoot = path.join(f.source, 'node_modules/external');
  json(path.join(nestedRoot, 'package.json'), {
    name: 'external', version: '2.0.0',
    main: 'src/index.js',
    exports: { '.': { bun: './dist/browser/index.js', default: './src/index.js' } },
    dependencies: { leaf: '^1.0.0' },
  });
  for (const relative of [ 'src/index.js', 'src/helper.js', 'src/ignored.test.js', 'dist/browser/index.js', 'dist/node/index.js' ]) {
    const target = path.join(nestedRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, relative);
  }
  bundleLocalDependenciesIntoTarball(f.tarball, f.dependencies);
  const packaged = unpack(f);
  for (const relative of [
    'src/index.js', 'src/helper.js', 'dist/browser/index.js', 'dist/node/index.js',
  ]) {
    expect(existsSync(path.join(packaged, 'node_modules/auth/node_modules/external', relative)), relative).toBe(true);
  }
  expect(existsSync(path.join(packaged, 'node_modules/auth/node_modules/external/src/ignored.test.js'))).toBe(false);
});
it('does not let custom or browser-only export conditions keep a source tree alive', () => {
  const f = fixture(true);
  const directRoot = f.source;
  // zod maps `@zod/source` into `src/` and `browser` into a browser build, but
  // no runtime resolver selects either condition.
  json(path.join(directRoot, 'package.json'), {
    name: 'auth', version: '1.0.0',
    main: 'dist/index.js',
    exports: { '.': { '@zod/source': './src/index.ts', browser: './browser/index.js', default: './dist/index.js' } },
    dependencies: { external: '^2.0.0' },
    optionalDependencies: { 'other-platform': '^1.0.0' },
  });
  for (const relative of [ 'dist/index.js', 'src/index.ts', 'src/nested/impl.ts', 'browser/index.js' ]) {
    const target = path.join(directRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, relative);
  }
  bundleLocalDependenciesIntoTarball(f.tarball, f.dependencies);
  const packaged = unpack(f);
  expect(existsSync(path.join(packaged, 'node_modules/auth/dist/index.js'))).toBe(true);
  for (const relative of [ 'src/index.ts', 'src/nested/impl.ts', 'browser/index.js' ]) {
    expect(existsSync(path.join(packaged, 'node_modules/auth', relative)), relative).toBe(false);
  }
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
