import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { c as createTar } from 'tar';
import { assertPublicationCommand, exportProducerMaterials } from '../scripts/producer-materials';
import { verifyProducerSourceArchive } from '../src/producer-source';

test('preserves failed tar status, native path, signal/error and original stderr without relaxing failure', () => {
  const archive = 'D:\\a\\output\\client.tgz';
  const outcome = { status: 2, signal: null, error: undefined, stderr: 'tar: Cannot connect to D: resolve failed\n' } as const;
  let caught: Error | undefined;
  try { assertPublicationCommand('tar', ['-tf', archive], outcome, 'cannot be listed'); } catch (error) { caught = error as Error; }
  expect(caught instanceof Error).toBe(true);
  const details = JSON.parse(caught!.message.slice('cannot be listed: '.length));
  expect(details.status).toBe(2); expect(details.args).toEqual(['-tf', archive]); expect(details.stderr).toBe(outcome.stderr);
  expect(() => assertPublicationCommand('tar', ['-tf', archive], { ...outcome, status: null, signal: 'SIGTERM' }, 'cannot be listed')).toThrow('SIGTERM');
  expect(() => assertPublicationCommand('tar', ['-tf', archive], { ...outcome, status: null, error: Object.assign(new Error('spawn tar ENOENT'), { code: 'ENOENT' }) }, 'cannot be listed')).toThrow('ENOENT');
  expect(() => assertPublicationCommand('tar', ['-tf', archive], { ...outcome, status: 0, stderr: '' }, 'cannot be listed')).not.toThrow();
});

test('rebuilds a closed producer inventory without stale source or a previous index', async () => {
  const parent = path.resolve('.test-data/xpod-cli/producer-materials');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-'));
  try {
    for (const [file, value] of Object.entries({
      'package.json': JSON.stringify({ name: '@fixture/client', version: '1' }),
      'licenses/javascript/index.json': '{"schemaVersion":1,"entries":[]}',
      '.test-data/build/npm-entry-inputs.canonical.json': '{"inputs":{}}',
      'dist/xpod.mjs': 'export {};',
      '.test-data/build/client-inputs.canonical.json': '{"inputs":{}}',
      'dist/client.cjs': 'module.exports = {};', 'dist/client.mjs': 'export {};',
      'src/current.ts': 'export {};', 'src/removed.ts': 'old source',
    })) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), value);
    }
    await exportProducerMaterials(root);
    rmSync(path.join(root, 'src/removed.ts'));
    await exportProducerMaterials(root);
    const materials = path.join(root, 'dist/producer-materials');
    const firstArchive = readFileSync(path.join(materials, 'client-source.tar.gz'));
    await exportProducerMaterials(root);
    expect(readFileSync(path.join(materials, 'client-source.tar.gz')).equals(firstArchive)).toBe(true);
    expect(existsSync(path.join(materials, 'source/src/removed.ts'))).toBe(false);
    const index = JSON.parse(readFileSync(path.join(materials, 'index.json'), 'utf8'));
    expect(index.files.some((file: { path: string }) => file.path === 'index.json')).toBe(false);
    expect(index.producer).toMatchObject({ name: '@fixture/client', version: '1' });
    expect(index.status).toBe('producer-materials-only');
    expect(index.coreMetafile).toBe('npm-entry-inputs.json');
    expect(readFileSync(path.join(materials, index.coreMetafile), 'utf8')).toBe(readFileSync(path.join(root, '.test-data/build/npm-entry-inputs.canonical.json'), 'utf8'));
    expect(index.corePayloads.esmSHA256).toBe(createHash('sha256').update(readFileSync(path.join(root, 'dist/xpod.mjs'))).digest('hex'));
    expect(typeof index.sourceAuthority.snapshotSHA256).toBe('string');
    expect(/^[a-f0-9]{64}$/.test(index.sourceAuthority.snapshotSHA256)).toBe(true);
    expect(index.sourceAuthority.sourceCommit).toBeNull();
    expect(index.sourceAuthority.dirty).toBeNull();
    for (const file of index.files) {
      const bytes = readFileSync(path.join(materials, file.path));
      expect(bytes.length).toBe(file.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    }
    expect(index.clientPayloads.cjsSHA256).toBe(createHash('sha256').update(readFileSync(path.join(root, 'dist/client.cjs'))).digest('hex'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects source omissions, substitutions, extra files, links and duplicate members even with a newly hashed tar', async () => {
  const parent = path.resolve('.test-data/xpod-cli/producer-archive');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-'));
  try {
    const source = path.join(root, 'source'); mkdirSync(source);
    const records = ['a', 'b'].map(name => {
      const bytes = Buffer.from(`original-${name}`); writeFileSync(path.join(source, name), bytes);
      return { path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    const inventory = path.join(root, 'inventory.json');
    writeFileSync(inventory, JSON.stringify({ schemaVersion: 1, files: records }));
    const archive = path.join(root, 'source.tar.gz');
    const pack = async (names: string[]): Promise<void> => { await createTar({ cwd: source, file: archive, gzip: true }, names); };
    await pack(['a', 'b']); await expect(verifyProducerSourceArchive({ archive, inventory })).resolves.toBeUndefined();
    await pack(['a']); await expect(verifyProducerSourceArchive({ archive, inventory })).rejects.toThrow('differs from inventory');
    await pack(['a', 'b', 'b']); await expect(verifyProducerSourceArchive({ archive, inventory })).rejects.toThrow('differs from inventory');
    writeFileSync(path.join(source, 'b'), 'replaced-b'); // Same size; outer archive hash can still be valid.
    await pack(['a', 'b']); await expect(verifyProducerSourceArchive({ archive, inventory })).rejects.toThrow('differs from inventory');
    for (const name of ['../escape', '/absolute', 'C:/drive', 'control\nname', 'nul\0name']) {
      writeFileSync(inventory, JSON.stringify({ schemaVersion: 1, files: [{ ...records[0], path: name }] }));
      await expect(verifyProducerSourceArchive({ archive, inventory })).rejects.toThrow('Invalid producer source inventory member');
    }
    writeFileSync(inventory, JSON.stringify({ schemaVersion: 1, files: records }));
    writeFileSync(path.join(source, 'b'), 'original-b'); writeFileSync(path.join(source, 'extra'), 'extra');
    await pack(['a', 'b', 'extra']); await expect(verifyProducerSourceArchive({ archive, inventory })).rejects.toThrow('differs from inventory');
    rmSync(path.join(source, 'b')); symlinkSync('a', path.join(source, 'b'));
    await pack(['a', 'b']); await expect(verifyProducerSourceArchive({ archive, inventory })).rejects.toThrow('differs from inventory');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preserves declared canonical workspace runtime source in the same verified archive', async () => {
  const parent = path.resolve('.test-data/xpod-cli/producer-workspace');
  mkdirSync(parent, { recursive: true });
  const scene = mkdtempSync(path.join(parent, 'case-'));
  const root = path.join(scene, 'xpod-cli');
  const client = path.join(scene, 'xpod-client');
  try {
    for (const [file, value] of Object.entries({
      'xpod-cli/package.json': JSON.stringify({ name: '@undefineds.co/xpod-cli', version: '1', dependencies: { '@undefineds.co/xpod-client': 'workspace:*' } }),
      'xpod-cli/licenses/javascript/index.json': '{"schemaVersion":1,"entries":[]}',
      'xpod-cli/.test-data/build/npm-entry-inputs.canonical.json': '{"inputs":{}}',
      'xpod-cli/dist/xpod.mjs': 'export {};',
      'xpod-cli/.test-data/build/client-inputs.canonical.json': '{"inputs":{}}',
      'xpod-cli/dist/client.cjs': 'module.exports = {};', 'xpod-cli/dist/client.mjs': 'export {};',
      'xpod-cli/src/client.ts': 'export {};',
      'xpod-client/package.json': JSON.stringify({ name: '@undefineds.co/xpod-client', version: '1' }),
      'xpod-client/src/index.ts': 'export const canonical = "original";',
      'xpod-client/LICENSE': 'fixture original terms', 'xpod-client/README.md': 'fixture source',
      'xpod-client/dist/library.cjs': 'module.exports = {};',
    })) {
      mkdirSync(path.dirname(path.join(scene, file)), { recursive: true });
      writeFileSync(path.join(scene, file), value);
    }
    await exportProducerMaterials(root);
    const materials = path.join(root, 'dist/producer-materials');
    const inventory = JSON.parse(readFileSync(path.join(materials, 'source-inventory.json'), 'utf8'));
    expect(inventory.files.some((file: { path: string }) => file.path === 'workspace/xpod-client/src/index.ts')).toBe(true);
    expect(readFileSync(path.join(materials, 'source/workspace/xpod-client/src/index.ts'), 'utf8')).toBe(readFileSync(path.join(client, 'src/index.ts'), 'utf8'));
    await expect(verifyProducerSourceArchive({ archive: path.join(materials, 'client-source.tar.gz'), inventory: path.join(materials, 'source-inventory.json') })).resolves.toBeUndefined();
    writeFileSync(path.join(client, 'package.json'), JSON.stringify({ name: '@wrong/client', version: '1' }));
    await expect(exportProducerMaterials(root)).rejects.toThrow('source identity mismatch');
  } finally { rmSync(scene, { recursive: true, force: true }); }
});
