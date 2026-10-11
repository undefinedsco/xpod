import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { c as createTar } from 'tar';
import { exportProducerMaterials } from '../scripts/producer-materials';
import { verifyProducerSourceArchive } from '../src/producer-source';

test('rebuilds a closed producer inventory without stale source or a previous index', async () => {
  const parent = path.resolve('.test-data/xpod-cli/producer-materials');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'case-'));
  try {
    for (const [file, value] of Object.entries({
      'package.json': JSON.stringify({ name: '@fixture/client', version: '1' }),
      'licenses/javascript/index.json': '{"schemaVersion":1,"entries":[]}',
      '.test-data/build/client-inputs.json': '{"inputs":{}}',
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
    expect(existsSync(path.join(materials, 'source/src/removed.ts'))).toBe(false);
    const index = JSON.parse(readFileSync(path.join(materials, 'index.json'), 'utf8'));
    expect(index.files.some((file: { path: string }) => file.path === 'index.json')).toBe(false);
    expect(index.producer).toMatchObject({ name: '@fixture/client', version: '1' });
    expect(index.status).toBe('producer-materials-only');
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
