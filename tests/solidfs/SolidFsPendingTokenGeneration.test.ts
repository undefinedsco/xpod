// B-owned contract test: every accepted pre-file attempt gets a fresh persistent token.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteSolidFsSyncJournal } from '../../src/solidfs/SolidFsSyncJournal';

const workspace = { workspace: 'http://root.invalid/', cwd: '/tmp/root.invalid', projection: 'direct' as const, entries: [] };
const change = {
  path: 'alice/notes.ttl',
  resource: 'http://root.invalid/alice/notes.ttl',
  sourcePath: '/tmp/root.invalid/alice/notes.ttl',
  source: 'filesystem' as const,
  projection: 'direct' as const,
  type: 'updated' as const,
};

async function withTmp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const parent = path.resolve('.test-data/solidfs-pending-generation');
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, 'run-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('SolidFsSyncJournal authority pending token generation', () => {
  it('mints distinct tokens for identical-content attempts on one connection', async () => {
    await withTmp(async dir => {
      const journal = new SqliteSolidFsSyncJournal({ path: path.join(dir, 'journal.sqlite') });
      try {
        const first = journal.recordAuthorityPending(change, workspace, 'same-version');
        const second = journal.recordAuthorityPending(change, workspace, 'same-version');
        expect(second.id).not.toBe(first.id);
        expect(journal.listAuthorityPending('alice/notes.ttl').map(op => op.id).sort())
          .toEqual([ first.id, second.id ].sort());
      } finally {
        journal.close();
      }
    });
  });

  it('keeps an exact-token clear from deleting a newer identical-content attempt across connections', async () => {
    await withTmp(async dir => {
      const file = path.join(dir, 'journal.sqlite');
      const older = new SqliteSolidFsSyncJournal({ path: file });
      const newer = new SqliteSolidFsSyncJournal({ path: file });
      try {
        const stale = older.recordAuthorityPending(change, workspace, 'same-version');
        const current = newer.recordAuthorityPending(change, workspace, 'same-version');
        expect(current.id).not.toBe(stale.id);
        expect(older.clearAuthorityPending(stale.id)).toBe(true);
        expect(newer.getAuthorityPending(current.id)?.id).toBe(current.id);
      } finally {
        older.close();
        newer.close();
      }
    });
  });

  it('preserves local_committed idempotence for repeated identical commits', async () => {
    await withTmp(async dir => {
      const journal = new SqliteSolidFsSyncJournal({ path: path.join(dir, 'journal.sqlite') });
      try {
        const first = await journal.recordLocalCommitted(change, workspace);
        const second = await journal.recordLocalCommitted(change, workspace);
        expect(second.id).toBe(first.id);
      } finally {
        journal.close();
      }
    });
  });
});
