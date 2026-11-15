import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SolidRdfEngine, type LocalNativeSparqlClientLike } from '../../../src/storage/rdf/SolidRdfEngine';

describe('SolidRdfEngine original auto-open owner lifecycle', () => {
  let directory: string;
  let engine: SolidRdfEngine | undefined;
  beforeEach(async () => {
    const root = path.resolve('.test-data/solid-rdf-engine-lifecycle');
    await mkdir(root, { recursive: true });
    directory = await mkdtemp(path.join(root, 'case-'));
  });
  afterEach(async () => {
    await engine?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  function create(native: LocalNativeSparqlClientLike): SolidRdfEngine {
    engine = new SolidRdfEngine({ index: { path: path.join(directory, 'index.sqlite') }, nativeSparqlClient: native, autoOpen: true });
    return engine;
  }

  it('waits for the original constructor opening before closing its native owner', async () => {
    let ready!: () => void;
    const opening = new Promise<void>(resolve => { ready = resolve; });
    const native = { start: vi.fn(() => opening), close: vi.fn(async () => {}), query: vi.fn() };
    const original = create(native);
    try {
      const closing = original.close();
      await Promise.resolve();
      expect(native.start).toHaveBeenCalledTimes(1);
      expect(native.close).not.toHaveBeenCalled();
      ready();
      await closing;
      expect(native.close).toHaveBeenCalledTimes(1);
    } finally { ready(); }
  });

  it('cleans up the same native owner when auto-opening fails without reporting readiness', async () => {
    const failure = new Error('original native startup failed');
    const native = { start: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined), close: vi.fn(async () => {}), query: vi.fn() };
    const original = create(native);
    await expect(original.open()).rejects.toBe(failure);
    expect(native.start).toHaveBeenCalledTimes(1);
    await expect(original.close()).resolves.toBeUndefined();
    expect(native.close).toHaveBeenCalledTimes(1);
  });

  it('retries a refused close on the same original native owner without starting another', async () => {
    const refusal = new Error('original native drain refused');
    const native = { start: vi.fn(async () => {}), close: vi.fn().mockRejectedValueOnce(refusal).mockResolvedValue(undefined), query: vi.fn() };
    const original = create(native);
    await expect(original.close()).rejects.toBe(refusal);
    await expect(original.close()).resolves.toBeUndefined();
    expect(native.start).toHaveBeenCalledTimes(1);
    expect(native.close).toHaveBeenCalledTimes(2);
  });
});
