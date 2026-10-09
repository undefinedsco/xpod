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
    ['ai-connections', 'extension-sdk', 'shared-ui', 'solid-sdk', 'xpod-cli', 'xpod-afs'].some((name) => entry.name === `@undefineds.co/${name}`));
  bundleLocalDependenciesIntoTarball(tarball, dependencies);
  const extracted = path.join(root, 'installed'); mkdirSync(extracted);
  execFileSync('tar', ['xzf', tarball, '-C', extracted]);
  const client = createRequire(path.join(extracted, 'package/package.json'))('@undefineds.co/xpod-cli/client');
  expect(typeof client.authFetch).toBe('function');
  const installedRequire = createRequire(path.join(extracted, 'package/package.json'));
  const afsRoot = path.join(extracted, 'package/node_modules/@undefineds.co/xpod-afs');
  const afsManifest = JSON.parse(readFileSync(path.join(afsRoot, 'package.json'), 'utf8'));
  // Installed server DI resolves these files from the bundled package, without
  // the producer workspace's declarations or generated component directory.
  expect(readFileSync(path.join(afsRoot, afsManifest.types), 'utf8')).toContain('workcopy/types');
  const afsComponents = JSON.parse(readFileSync(path.join(afsRoot, afsManifest['lsd:components']), 'utf8'));
  expect(afsComponents.import.some((iri: string) => iri.endsWith('/workcopy/SolidFsSyncJournal.jsonld'))).toBe(true);
  for (const relative of Object.values(afsManifest['lsd:contexts']) as string[]) {
    expect(JSON.parse(readFileSync(path.join(afsRoot, relative), 'utf8'))['@context']).toBeTruthy();
  }
  const workcopy = installedRequire('@undefineds.co/xpod-afs/workcopy');
  const diContracts = installedRequire('@undefineds.co/xpod-afs');
  expect(typeof diContracts.RootedSolidFsSyncJournal).toBe('function');
  expect(diContracts.RootedSolidFsSyncJournal).toBe(
    installedRequire('@undefineds.co/xpod-afs/workcopy/SolidFsSyncJournal').RootedSolidFsSyncJournal);
  expect(typeof workcopy.LocalSolidFS).toBe('function');
  expect(workcopy.LocalSolidFS).toBe(installedRequire('@undefineds.co/xpod-afs/workcopy/LocalSolidFS').LocalSolidFS);
  const entries = execFileSync('tar', ['tzf', tarball], { encoding: 'utf8' }).split('\n');
  expect(entries.filter((entry) => entry.includes('/node_modules/lucide-react/'))).toEqual([]);
  const readManifest = (entry: string) => JSON.parse(execFileSync('tar', ['xOf', tarball, entry], { encoding: 'utf8' }));
  expect(readManifest('package/package.json').dependencies['lucide-react']).toBe(manifests[0].dependencies['lucide-react']);
  const rootManifest = readManifest('package/package.json');
  expect(entries.some((entry) => entry.endsWith('/helper/agentfs-pod'))).toBe(false);
  for (const dependency of dependencies) {
    expect(rootManifest.dependencies[dependency.name]).toBe(`file:./node_modules/${dependency.name}`);
    expect(rootManifest.bundledDependencies).toContain(dependency.name);
  }
  for (const [index, name] of names.entries()) {
    expect(readManifest(`package/node_modules/@undefineds.co/${name}/package.json`).exports).toEqual(manifests[index].exports);
  }
});
