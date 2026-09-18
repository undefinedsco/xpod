import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { getBundledLocalDependencies, bundleLocalDependenciesIntoTarball } = require('../../scripts/run-npm-pack.cjs');
const repoRoot = path.resolve(__dirname, '../..');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('keeps workspace icon consumers on one external runtime while preserving their public exports', () => {
  const names = ['ai-connections', 'shared-ui'];
  const manifests = names.map((name) => JSON.parse(readFileSync(path.join(repoRoot, 'packages', name, 'package.json'), 'utf8')));
  expect(manifests[0].dependencies['lucide-react']).toBe(manifests[1].dependencies['lucide-react']);
  const resolved = names.map((name) => realpathSync(createRequire(path.join(repoRoot, 'packages', name, 'package.json')).resolve('lucide-react')));
  expect(resolved[0]).toBe(resolved[1]);

  mkdirSync(path.join(repoRoot, '.test-data'), { recursive: true });
  const root = mkdtempSync(path.join(repoRoot, '.test-data/npm-pack-workspace-icons-'));
  roots.push(root);
  mkdirSync(path.join(root, 'seed/package'), { recursive: true });
  writeFileSync(path.join(root, 'seed/package/package.json'), JSON.stringify({ name: 'workspace-consumer', version: '1.0.0' }));
  const tarball = path.join(root, 'package.tgz');
  execFileSync('tar', ['czf', tarball, '-C', path.join(root, 'seed'), 'package']);
  const dependencies = getBundledLocalDependencies(repoRoot).filter((entry: { name: string }) =>
    ['ai-connections', 'extension-sdk', 'shared-ui', 'solid-sdk'].some((name) => entry.name === `@undefineds.co/${name}`));
  bundleLocalDependenciesIntoTarball(tarball, dependencies);
  const entries = execFileSync('tar', ['tzf', tarball], { encoding: 'utf8' }).split('\n');
  expect(entries.filter((entry) => entry.includes('/node_modules/lucide-react/'))).toEqual([]);
  const readManifest = (entry: string) => JSON.parse(execFileSync('tar', ['xOf', tarball, entry], { encoding: 'utf8' }));
  expect(readManifest('package/package.json').dependencies['lucide-react']).toBe(manifests[0].dependencies['lucide-react']);
  const rootManifest = readManifest('package/package.json');
  for (const dependency of dependencies) {
    expect(rootManifest.dependencies[dependency.name]).toBe(`file:./node_modules/${dependency.name}`);
    expect(rootManifest.bundledDependencies).toContain(dependency.name);
  }
  for (const [index, name] of names.entries()) {
    expect(readManifest(`package/node_modules/@undefineds.co/${name}/package.json`).exports).toEqual(manifests[index].exports);
  }
});
