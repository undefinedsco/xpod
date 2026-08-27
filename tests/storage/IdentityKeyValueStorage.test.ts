import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IdentityKeyValueStorage,
  resolveIdentityKeyValueStorageBackend,
} from '../../src/storage/keyvalue/IdentityKeyValueStorage';

describe('IdentityKeyValueStorage', () => {
  it.each([
    ['postgres://user@db/xpod', 'postgres'],
    ['postgresql://user@db/xpod', 'postgres'],
    ['sqlite:./data/identity.sqlite', 'sqlite'],
    ['./data/identity.sqlite', 'sqlite'],
  ] as const)('routes %s to the %s adapter', (connectionString, expected) => {
    expect(resolveIdentityKeyValueStorageBackend(connectionString)).toBe(expected);
  });

  it('rejects an empty connection string', () => {
    expect(() => new IdentityKeyValueStorage({ connectionString: '' })).toThrow(
      'Identity key/value storage requires a connection string',
    );
  });

  it('persists values through the selected SQLite delegate', async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'xpod-identity-kv-'));
    const store = new IdentityKeyValueStorage<{ active: boolean }>({
      connectionString: `sqlite:${path.join(workDir, 'identity.sqlite')}`,
      namespace: 'session:',
    });

    try {
      await store.initialize();
      expect(await store.has('alice')).toBe(false);
      expect(await store.set('alice', { active: true })).toBe(store);
      expect(await store.has('alice')).toBe(true);
      expect(await store.get('alice')).toEqual({ active: true });

      const entries: Array<[string, { active: boolean }]> = [];
      for await (const entry of store.entries()) entries.push(entry);
      expect(entries).toEqual([['alice', { active: true }]]);
      expect(await store.delete('alice')).toBe(true);
      expect(await store.get('alice')).toBeUndefined();
    } finally {
      await store.finalize();
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
