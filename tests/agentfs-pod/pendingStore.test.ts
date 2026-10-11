import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PodLowerPendingStore } from '../../packages/xpod-afs/src/agent-fs/pending-store';
import type { PendingOperation } from '../../packages/xpod-afs/src/agent-fs/pod-lower';

const ROOT = path.resolve('.test-data/agent-directory-workers/agentfs-test/pending');

describe('PodLowerPendingStore survives a restart', () => {
  const dirs: string[] = [];

  beforeAll(() => {
    mkdirSync(ROOT, { recursive: true });
  });

  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists dirty operations and reloads them for the next session', () => {
    const dir = mkdtempSync(path.join(ROOT, 'session-'));
    dirs.push(dir);
    const operations: PendingOperation[] = [
      { id: 'write-1', op: 'write', path: 'notes/a.txt', dataBase64: Buffer.from('DIRTY\n').toString('base64'), baseVersion: '"v1"', create: false },
      { id: 'create-2', op: 'write', path: 'notes/new.txt', dataBase64: Buffer.from('NEW\n').toString('base64'), create: true },
      { id: 'delete-3', op: 'delete', path: 'notes/old.txt', baseVersion: '"v4"' },
    ];

    const first = new PodLowerPendingStore(dir);
    first.save(operations);

    const reopened = new PodLowerPendingStore(dir);
    expect(reopened.load()).toEqual(operations);
  });

  it('returns an empty list for a missing or corrupt session file', () => {
    const dir = mkdtempSync(path.join(ROOT, 'empty-'));
    dirs.push(dir);
    expect(new PodLowerPendingStore(dir).load()).toEqual([]);
  });
});
