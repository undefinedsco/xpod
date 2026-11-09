import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { collectPublishedRuntimeClient } from '../../packages/xpod-cli/scripts/producer-materials';
import { preparePublication, type PublicationInput } from '../../scripts/prepare-cli-publication';

const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const archiveReference = (file: string) => ({ path: file, sha256: digest(file), integrity: `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}` });
function normalPack(directory: string, archive: string) {
  const packed = spawnSync('bun', ['pm', 'pack', '--ignore-scripts', '--filename', archive], { cwd: directory, encoding: 'utf8' });
  if (packed.status !== 0) throw new Error(packed.stderr);
  return archiveReference(archive);
}

function fixture(run: (input: PublicationInput, root: string) => void, alter?: (cli: any, client: any) => void) {
  const base = path.resolve(import.meta.dir, '../../.test-data/cli-publication/fixtures');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'case-'));
  try {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'] }));
    const cli: any = { name: '@undefineds.co/xpod-cli', version: '1.2.3', files: ['dist'], exports: { './producer-materials': './dist/producer-materials/index.json' }, dependencies: { '@undefineds.co/xpod-client': 'workspace:*' } };
    const client: any = { name: '@undefineds.co/xpod-client', version: '4.5.6', files: ['dist'], devDependencies: { '@undefineds.co/xpod-cli': 'workspace:*' } };
    const inputs: any = { schemaVersion: 1, sourceManifests: {} };
    for (const [id, manifest] of [['client', client], ['cli', cli]] as const) {
      const directory = path.join(root, 'packages', id);
      mkdirSync(path.join(directory, 'dist'), { recursive: true });
      const source = path.join(directory, 'package.json');
      writeFileSync(source, JSON.stringify(manifest));
      writeFileSync(path.join(directory, 'dist/index.mjs'), 'export const fixture = true;');
      inputs.sourceManifests[id] = { path: source, sha256: digest(source) };
    }
    // Tiny offline workspace initialization, using only the two local fixture packages.
    const installed = spawnSync('bun', ['install', '--offline', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
    if (installed.status !== 0) throw new Error(installed.stderr);
    // Negative cases declare invalid source inputs after the workspace fixture is linked.
    alter?.(cli, client);
    for (const [id, manifest] of [['client', client], ['cli', cli]] as const) {
      const source = inputs.sourceManifests[id].path;
      writeFileSync(source, JSON.stringify(manifest));
      inputs.sourceManifests[id].sha256 = digest(source);
    }
    // Reuse the actual client publication collector used by normal producer-materials.
    const material = path.join(root, 'packages/cli/dist/producer-materials');
    const published = collectPublishedRuntimeClient(path.join(root, 'packages/client'), path.join(material, 'runtime-clients/client'));
    const relative = (file: string) => path.relative(material, file).split(path.sep).join('/');
    writeFileSync(path.join(material, 'index.json'), JSON.stringify({ schemaVersion: 1,
      producer: { name: cli.name, version: cli.version },
      runtimeClients: [{ name: client.name, version: client.version, files: published.files,
        publication: { archive: relative(published.archive), inventory: relative(published.inventory), sourceManifest: 'workspace/client/package.json' } }],
      files: [published.archive, published.inventory].map(file => ({ path: relative(file), sha256: digest(file), bytes: readFileSync(file).length })),
    }));
    const clientArchive = path.join(root, 'client.tgz');
    copyFileSync(published.archive, clientArchive);
    inputs.client = archiveReference(clientArchive);
    const cliArchive = path.join(root, 'cli.tgz');
    inputs.cli = normalPack(path.join(root, 'packages/cli'), cliArchive);
    run(inputs, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('normal workspace tarballs bind exact client edge and preserve raw source manifest originals', () => fixture(input => {
  const receipt = preparePublication(input);
  expect(receipt.cli.runtimeClient.version).toBe('4.5.6');
  expect(receipt.embeddedClientIdentityVerified).toBe(true);
  expect(receipt.cli.embeddedClient.archive.sha256).toBe(input.client.sha256);
  expect(receipt.cli.runtimeClient.archiveSha256).toBe(input.client.sha256);
  expect(receipt.cli.runtimeClient.integrity).toBe(input.client.integrity);
  expect(receipt.sourceManifests.cli.original.dependencies['@undefineds.co/xpod-client']).toBe('workspace:*');
  expect(receipt.sourceManifests.client.original.devDependencies['@undefineds.co/xpod-cli']).toBe('workspace:*');
  for (const reference of [input.cli, input.client, input.sourceManifests.cli, input.sourceManifests.client]) expect(digest(reference.path)).toBe(reference.sha256);
  expect(Buffer.from(receipt.sourceManifests.cli.originalBytesBase64, 'base64')).toEqual(readFileSync(input.sourceManifests.cli.path));
  expect(Buffer.from(receipt.sourceManifests.client.originalBytesBase64, 'base64')).toEqual(readFileSync(input.sourceManifests.client.path));
  expect(receipt.releaseQualified).toBe(false); expect(receipt.published).toBe(false);
  expect(receipt.legalQualified).toBe(false); expect(receipt.nativeQualified).toBe(false);
}));

for (const version of ['^4.5.6', '4.5.7']) {
  test(`rejects CLI client edge ${version} instead of the supplied exact client`, () => fixture(input => {
    expect(() => preparePublication(input)).toThrow('exact supplied');
  }, cli => { cli.dependencies['@undefineds.co/xpod-client'] = version; }));
}
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  test(`rejects local installation edge in final ${field}`, () => fixture(input => {
    expect(() => preparePublication(input)).toThrow('not publishable');
  }, cli => { cli[field] = { ...cli[field], fixture: 'file:./unpublished.tgz' }; }));
}
for (const field of ['overrides', 'resolutions']) {
  test(`rejects nested local installation edge in final ${field}`, () => fixture(input => {
    expect(() => preparePublication(input)).toThrow('not publishable');
  }, cli => { cli[field] = { fixture: { '.': 'link:../local' } }; }));
}
test('rejects missing inputs, changed archive/source and SRI drift', () => fixture(input => {
  expect(() => preparePublication({ ...input, client: undefined } as any)).toThrow('reference');
  expect(() => preparePublication({ ...input, cli: { ...input.cli, integrity: 'sha512-bad' } })).toThrow('SRI');
  expect(() => preparePublication({ ...input, client: { ...input.client, sha256: '0'.repeat(64) } })).toThrow('digest');
  expect(() => preparePublication({ ...input, sourceManifests: { ...input.sourceManifests, cli: { ...input.sourceManifests.cli, sha256: '0'.repeat(64) } } })).toThrow('digest');
}));
test('command emits only a preparation receipt and preserves all originals', () => fixture((input, root) => {
  const file = path.join(root, 'input.json');writeFileSync(file, JSON.stringify(input));
  const result = spawnSync('bun', [path.resolve(import.meta.dir, '../../scripts/prepare-cli-publication.ts'), file], { encoding: 'utf8' });
  expect(result.status).toBe(0); expect(JSON.parse(result.stdout).status).toBe('prepared-not-published');
  expect(JSON.parse(result.stdout).toolScope).toBe('repository-only; not an installed npm CLI command');
  for (const reference of [input.cli, input.client, input.sourceManifests.cli, input.sourceManifests.client]) expect(digest(reference.path)).toBe(reference.sha256);
}));

test('rejects source identity drift even when the new original hash is supplied', () => fixture(input => {
  const source = JSON.parse(readFileSync(input.sourceManifests.client.path, 'utf8'));
  source.version = '4.5.7';
  writeFileSync(input.sourceManifests.client.path, JSON.stringify(source));
  input.sourceManifests.client.sha256 = digest(input.sourceManifests.client.path);
  expect(() => preparePublication(input)).toThrow('identity mismatch');
}));

test('repository publication tooling is outside the installed CLI and minimal package gate', () => {
  const cliRoot = path.resolve(import.meta.dir, '../../packages/xpod-cli');
  const manifest = JSON.parse(readFileSync(path.join(cliRoot, 'package.json'), 'utf8'));
  expect(manifest.scripts['prepare:publication']).toBeUndefined();
  expect(manifest.scripts['test:publication']).toBeUndefined();
  expect(Object.values(manifest.scripts).some(value => /prepare-cli-publication|pack-publication/.test(String(value)))).toBe(false);
  expect(manifest.files).not.toContain('scripts');
});

test('same version client with different normally packed bytes cannot replace embedded publication', () => fixture((input, root) => {
  writeFileSync(path.join(root, 'packages/client/dist/index.mjs'), 'export const differentBytes = true;');
  const archive = path.join(root, 'different-client.tgz');
  const changed = normalPack(path.join(root, 'packages/client'), archive);
  expect(changed.sha256).not.toBe(input.client.sha256);
  expect(() => preparePublication({ ...input, client: changed })).toThrow('embedded client bytes differ');
}));

test('missing public producer index cannot produce a prepared success receipt', () => fixture(input => {
  expect(() => preparePublication(input)).toThrow('publication index missing');
}, cli => { delete cli.exports; }));

test('producer inventory must bind the embedded publication original', () => fixture((input, root) => {
  const indexFile = path.join(root, 'packages/cli/dist/producer-materials/index.json');
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  index.files[0].sha256 = '0'.repeat(64);
  writeFileSync(indexFile, JSON.stringify(index));
  const changed = normalPack(path.join(root, 'packages/cli'), path.join(root, 'bad-index-cli.tgz'));
  expect(() => preparePublication({ ...input, cli: changed })).toThrow('producer inventory binding');
}));
