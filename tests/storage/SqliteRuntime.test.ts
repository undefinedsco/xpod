import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  createBunSqliteRuntimeMock: vi.fn(),
  createNodeSqliteRuntimeMock: vi.fn(),
  createSqliteRuntimeMock: vi.fn(),
}));

vi.mock('../../src/storage/sqlite/backends/BunSqliteRuntime', () => ({
  createBunSqliteRuntime: mocked.createBunSqliteRuntimeMock,
}));

vi.mock('../../src/storage/sqlite/backends/NodeSqliteRuntime', () => ({
  createNodeSqliteRuntime: mocked.createNodeSqliteRuntimeMock,
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
  const originalRuntime = process.env.XPOD_SQLITE_RUNTIME;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalBun === undefined) {
      delete (globalThis as any).Bun;
    } else {
      (globalThis as any).Bun = originalBun;
    }

    if (originalRuntime === undefined) {
      delete process.env.XPOD_SQLITE_RUNTIME;
    } else {
      process.env.XPOD_SQLITE_RUNTIME = originalRuntime;
    }
  });

  it('resolves node runtime kind outside bun', async() => {
    delete (globalThis as any).Bun;
    const { resolveDefaultSqliteRuntimeKind, createSqliteRuntime } = await vi.importActual<
      typeof import('../../src/storage/sqlite/factory')
    >('../../src/storage/sqlite/factory');
    const runtime = { kind: 'node-sqlite' } as any;
    mocked.createNodeSqliteRuntimeMock.mockReturnValue(runtime);

    expect(resolveDefaultSqliteRuntimeKind()).toBe('node-sqlite');
    expect(createSqliteRuntime()).toBe(runtime);
    expect(mocked.createNodeSqliteRuntimeMock).toHaveBeenCalledTimes(1);
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
    expect(mocked.createNodeSqliteRuntimeMock).not.toHaveBeenCalled();
  });

  it('resolves node:sqlite runtime when requested via env', async() => {
    delete (globalThis as any).Bun;
    process.env.XPOD_SQLITE_RUNTIME = 'node-sqlite';
    const { resolveDefaultSqliteRuntimeKind, createSqliteRuntime } = await vi.importActual<
      typeof import('../../src/storage/sqlite/factory')
    >('../../src/storage/sqlite/factory');
    const runtime = { kind: 'node-sqlite' } as any;
    mocked.createNodeSqliteRuntimeMock.mockReturnValue(runtime);

    expect(resolveDefaultSqliteRuntimeKind()).toBe('node-sqlite');
    expect(createSqliteRuntime()).toBe(runtime);
    expect(mocked.createNodeSqliteRuntimeMock).toHaveBeenCalledTimes(1);
    expect(mocked.createBunSqliteRuntimeMock).not.toHaveBeenCalled();
  });

  it('caches getSqliteRuntime result', async() => {
    mocked.createSqliteRuntimeMock.mockReturnValue({ kind: 'node-sqlite' } as any);
    vi.resetModules();
    const { getSqliteRuntime } = await import('../../src/storage/SqliteRuntime');

    const first = getSqliteRuntime();
    const second = getSqliteRuntime();

    expect(first).toBe(second);
    expect(mocked.createSqliteRuntimeMock).toHaveBeenCalledTimes(1);
  });
});
