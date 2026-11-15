import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

/** The actor must reach the INSTALLED undici package, not Bun's builtin shim, because
 * the shim exposes fetch but never cacheStores. Nested installs are the real shape. */
it('rewrites the bare undici require to the explicit installed entry, nested and idempotently', () => {
  const base = path.resolve('.test-data/patch-comunica-undici-entry');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'case-'));
  roots.push(root);
  mkdirSync(path.join(root, 'patches'), { recursive: true });
  copyFileSync('patches/comunica-undici-entry.cjs', path.join(root, 'patches/comunica-undici-entry.cjs'));

  const actor = path.join(
    root,
    'node_modules/componentsjs/node_modules/rdf-parse/node_modules/@comunica/actor-http-fetch',
  );
  mkdirSync(path.join(actor, 'lib'), { recursive: true });
  const source = [
    'const undici_1 = require("undici");',
    "const cacheStores = require('undici').cacheStores;",
    "const other = require('node:http');",
  ].join('\n');
  const target = path.join(actor, 'lib/FetchInitPreprocessor.js');
  writeFileSync(target, source);

  const run = () =>
    spawnSync(process.execPath, [path.join(root, 'patches/comunica-undici-entry.cjs')], { encoding: 'utf8' });
  expect(run().status).toBe(0);

  const patched = readFileSync(target, 'utf8');
  expect(patched).toContain('require("undici/index.js")');
  expect(patched).toContain("require('undici/index.js').cacheStores");
  // unrelated requires keep their bare form
  expect(patched).toContain("require('node:http')");
  expect(patched).not.toMatch(/require\((['"])undici\1\)/);

  // second run is a no-op
  expect(run().status).toBe(0);
  expect(readFileSync(target, 'utf8')).toBe(patched);
});

it('leaves an actor without undici usage byte-identical', () => {
  const base = path.resolve('.test-data/patch-comunica-undici-entry');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'case-'));
  roots.push(root);
  mkdirSync(path.join(root, 'patches'), { recursive: true });
  copyFileSync('patches/comunica-undici-entry.cjs', path.join(root, 'patches/comunica-undici-entry.cjs'));

  const actor = path.join(root, 'node_modules/@comunica/actor-http-fetch');
  mkdirSync(path.join(actor, 'lib'), { recursive: true });
  const target = path.join(actor, 'lib/FetchInitPreprocessor.js');
  const plain = 'const http = require("node:http");\n';
  writeFileSync(target, plain);

  const run = () =>
    spawnSync(process.execPath, [path.join(root, 'patches/comunica-undici-entry.cjs')], { encoding: 'utf8' });
  expect(run().status).toBe(0);
  expect(readFileSync(target, 'utf8')).toBe(plain);
});

it('actually yields a constructible MemoryCacheStore from the explicit entry under Bun', () => {
  const base = path.resolve('.test-data/patch-comunica-undici-entry');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'bun-'));
  roots.push(root);
  mkdirSync(path.join(root, 'patches'), { recursive: true });
  copyFileSync('patches/comunica-undici-entry.cjs', path.join(root, 'patches/comunica-undici-entry.cjs'));
  const actor = path.join(root, 'node_modules/@comunica/actor-http-fetch');
  mkdirSync(path.join(actor, 'lib'), { recursive: true });
  const undici = path.join(actor, 'node_modules/undici');
  mkdirSync(undici, { recursive: true });
  writeFileSync(path.join(undici, 'package.json'), JSON.stringify({ name: 'undici', main: 'index.js' }));
  writeFileSync(path.join(undici, 'index.js'),
    'exports.cacheStores = { MemoryCacheStore: class { constructor() { this.kind = "installed"; } } };');
  const target = path.join(actor, 'lib/FetchInitPreprocessor.js');
  writeFileSync(target,
    'const cacheStores = require("undici").cacheStores; module.exports = new cacheStores.MemoryCacheStore();');
  const patched = spawnSync(process.execPath,
    [path.join(root, 'patches/comunica-undici-entry.cjs')], { encoding: 'utf8' });
  expect(patched.status).toBe(0);
  const probe = spawnSync(
    'bun',
    ['-e', 'const store = require(' + JSON.stringify(target) + '); process.stdout.write(JSON.stringify({kind:store.kind}));'],
    { encoding: 'utf8' },
  );
  expect(probe.status).toBe(0);
  expect(JSON.parse(probe.stdout)).toEqual({ kind: 'installed' });
});

/** The dependency-state checker must SEE an unpatched actor and accept a patched one.
 * It reuses this module's own discovery/predicate, so this test pins that contract. */
it('reports an unpatched actor as invalid and a patched actor as valid (checker contract)', () => {
  const base = path.resolve('.test-data/patch-comunica-undici-entry');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'inspect-'));
  roots.push(root);
  const actor = path.join(
    root,
    'node_modules/componentsjs/node_modules/rdf-parse/node_modules/@comunica/actor-http-fetch',
  );
  mkdirSync(path.join(actor, 'lib'), { recursive: true });
  const target = path.join(actor, 'lib/FetchInitPreprocessor.js');
  writeFileSync(target, "const cacheStores = require('undici').cacheStores;\n");

  const mod = require('../../patches/comunica-undici-entry.cjs');
  const unpatched = mod.inspectInstalledPackage(root);
  expect(unpatched).toHaveLength(1);
  expect(unpatched[0].bareUndici).toBe(true);
  expect(unpatched[0].valid).toBe(false);

  expect(mod.patchInstalledPackage(root).patched).toBe(1);
  const patched = mod.inspectInstalledPackage(root);
  expect(patched[0].bareUndici).toBe(false);
  expect(patched[0].explicitEntry).toBe(true);
  expect(patched[0].valid).toBe(true);
});
