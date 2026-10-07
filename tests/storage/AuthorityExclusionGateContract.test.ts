// B-owned contract tests for the public SqliteAuthorityExclusionGate constructor/persistence surface.
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  AuthorityExclusionError,
  isInMemoryDatabasePath,
  SqliteAuthorityExclusionGate,
} from '../../src/storage/AuthorityExclusionGate';
import { getSqliteRuntime } from '../../src/storage/SqliteRuntime';

const MEMORY_FORMS = [
  ':memory:',
  '  :memory:  ',
  'file::memory:',
  'file::memory:?cache=shared',
  'file::memory:?cache=shared&mode=memory',
  'file:example?mode=memory',
  'file:example?mode=MEMORY&cache=shared',
  'file:example?cache=shared&mode=memory',
  'file:example?mode=memory#ignored-fragment',
  'file:example?vfs=memdb',
  'file:%3Amemory%3A',
  'file:',
  'file://host',
  '',
  '   ',
];

const LITERAL_FILENAMES = [
  'literal.sqlite?mode=memory',
  'literal.sqlite?vfs=memdb',
  'ordinary.sqlite?cache=shared',
];

const INVALID_TIMING: Array<[string, unknown]> = [
  [ 'retryDelayMs', Number.NaN ],
  [ 'retryDelayMs', Number.POSITIVE_INFINITY ],
  [ 'retryDelayMs', -1 ],
  [ 'retryDelayMs', '5' ],
  [ 'defaultTimeoutMs', Number.NaN ],
  [ 'defaultTimeoutMs', Number.POSITIVE_INFINITY ],
  [ 'defaultTimeoutMs', -1 ],
  [ 'defaultTimeoutMs', '15' ],
];

describe('SqliteAuthorityExclusionGate constructor contract', () => {
  let root: string;
  let openSpy: MockInstance;

  beforeEach(async () => {
    const parent = path.resolve('.test-data/authority-gate-contract');
    await mkdir(parent, { recursive: true });
    root = await mkdtemp(path.join(parent, 'run-'));
    openSpy = vi.spyOn(getSqliteRuntime(), 'openDatabase');
  });

  afterEach(async () => {
    openSpy.mockRestore();
    await rm(root, { recursive: true, force: true });
  });

  it.each(MEMORY_FORMS)('rejects the non-persistent database form %j before allocating a handle', form => {
    expect(isInMemoryDatabasePath(form)).toBe(true);
    expect(() => new SqliteAuthorityExclusionGate(form)).toThrow(AuthorityExclusionError);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it.each(INVALID_TIMING)('rejects invalid %s=%o before allocating a handle', async (name, value) => {
    const databasePath = path.join(root, 'coordination.sqlite');
    expect(() => new SqliteAuthorityExclusionGate(databasePath, { [name]: value } as never))
      .toThrow(AuthorityExclusionError);
    expect(openSpy, `openDatabase must not run for invalid ${name}`).not.toHaveBeenCalled();
    await expect(stat(databasePath)).rejects.toBeDefined();
  });

  it('accepts a persistent on-disk path and preserves physical alias exclusion', async () => {
    const canonical = path.join(root, 'coordination.sqlite');
    const alias = `${root}${path.sep}.${path.sep}coordination.sqlite`;
    expect(isInMemoryDatabasePath(canonical)).toBe(false);
    expect(isInMemoryDatabasePath(alias)).toBe(false);

    const first = new SqliteAuthorityExclusionGate(canonical, { retryDelayMs: 1, defaultTimeoutMs: 100 });
    const second = new SqliteAuthorityExclusionGate(alias, { retryDelayMs: 1, defaultTimeoutMs: 25 });
    try {
      let release!: () => void;
      const holding = new Promise<void>((resolve) => { release = resolve; });
      const holder = first.runExclusive(() => holding);
      let aliasRan = false;
      await expect(second.runExclusive(() => { aliasRan = true; })).rejects.toBeInstanceOf(AuthorityExclusionError);
      expect(aliasRan).toBe(false);
      release();
      await holder;
      let canonicalRan = false;
      await first.runExclusive(() => { canonicalRan = true; });
      expect(canonicalRan).toBe(true);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it.each(LITERAL_FILENAMES)(
    'accepts the ordinary on-disk filename %j (URI parameters do not apply)',
    async name => {
      const databasePath = path.join(root, name);
      expect(isInMemoryDatabasePath(databasePath)).toBe(false);
      // The same public runtime proves the literal filename is a real persistent file.
      const control = getSqliteRuntime().openDatabase(databasePath);
      try {
        control.exec('CREATE TABLE literal_probe (value INTEGER)');
      } finally {
        control.close();
      }
      expect((await stat(databasePath)).isFile()).toBe(true);
      const gate = new SqliteAuthorityExclusionGate(databasePath);
      try {
        await expect(gate.runExclusive(() => 'admitted')).resolves.toBe('admitted');
      } finally {
        await gate.close();
      }
    },
  );

  it('accepts a nested persistent path with default timing options', async () => {
    await mkdir(path.join(root, 'nested'), { recursive: true });
    const databasePath = path.join(root, 'nested', 'exclusion.sqlite');
    expect(isInMemoryDatabasePath(databasePath)).toBe(false);
    const gate = new SqliteAuthorityExclusionGate(databasePath);
    try {
      await expect(gate.runExclusive(() => 'applied')).resolves.toBe('applied');
    } finally {
      await gate.close();
    }
  });
});
