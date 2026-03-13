import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  createBetterSqlite3RuntimeMock: vi.fn(),
  createBunSqliteRuntimeMock: vi.fn(),
  createSqliteRuntimeMock: vi.fn(),
}));

vi.mock('../../src/storage/sqlite/backends/BetterSqlite3Runtime', () => ({
  createBetterSqlite3Runtime: mocked.createBetterSqlite3RuntimeMock,
}));

vi.mock('../../src/storage/sqlite/backends/BunSqliteRuntime', () => ({
  createBunSqliteRuntime: mocked.createBunSqliteRuntimeMock,
}));

vi.mock('../../src/storage/sqlite/factory', async() => {
  const actual = await vi.importActual<typeof import('../../src/storage/sqlite/factory')>(
    '../../src/storage/sqlite/factory',
  );
  return {
    ...actual,
    createSqliteRuntime: mocked.createSqliteRuntimeMock,
  };
});

describe('Sqlite runtime selection', () => {
  const originalBun = (globalThis as any).Bun;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalBun === undefined) {
      delete (globalThis as any).Bun;
    } else {
      (globalThis as any).Bun = originalBun;
    }
  });

  it('resolves node runtime kind outside bun', async() => {
    delete (globalThis as any).Bun;
    const { resolveDefaultSqliteRuntimeKind, createSqliteRuntime } = await vi.importActual<
      typeof import('../../src/storage/sqlite/factory')
    >('../../src/storage/sqlite/factory');
    const runtime = { kind: 'node-better-sqlite3' } as any;
    mocked.createBetterSqlite3RuntimeMock.mockReturnValue(runtime);

    expect(resolveDefaultSqliteRuntimeKind()).toBe('node-better-sqlite3');
    expect(createSqliteRuntime()).toBe(runtime);
    expect(mocked.createBetterSqlite3RuntimeMock).toHaveBeenCalledTimes(1);
    expect(mocked.createBunSqliteRuntimeMock).not.toHaveBeenCalled();
  });

  it('resolves bun runtime kind inside bun', async() => {
    (globalThis as any).Bun = {};
    const { resolveDefaultSqliteRuntimeKind, createSqliteRuntime } = await vi.importActual<
      typeof import('../../src/storage/sqlite/factory')
    >('../../src/storage/sqlite/factory');
    const runtime = { kind: 'bun-sqlite' } as any;
    mocked.createBunSqliteRuntimeMock.mockReturnValue(runtime);

    expect(resolveDefaultSqliteRuntimeKind()).toBe('bun-sqlite');
    expect(createSqliteRuntime()).toBe(runtime);
    expect(mocked.createBunSqliteRuntimeMock).toHaveBeenCalledTimes(1);
    expect(mocked.createBetterSqlite3RuntimeMock).not.toHaveBeenCalled();
  });

  it('caches getSqliteRuntime result', async() => {
    mocked.createSqliteRuntimeMock.mockReturnValue({ kind: 'node-better-sqlite3' } as any);
    vi.resetModules();
    const { getSqliteRuntime } = await import('../../src/storage/SqliteRuntime');

    const first = getSqliteRuntime();
    const second = getSqliteRuntime();

    expect(first).toBe(second);
    expect(mocked.createSqliteRuntimeMock).toHaveBeenCalledTimes(1);
  });
});
