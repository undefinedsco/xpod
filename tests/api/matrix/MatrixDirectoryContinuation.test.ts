import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeAllIdentityConnections, executeStatement, getIdentityDatabase } from '../../../src/identity/drizzle/db';
import { sql } from 'drizzle-orm';
import { SqlMatrixRoomDirectory, verifyRoomBinding } from '../../../src/api/matrix/MatrixRoomDirectory';
import { PodMatrixStore } from '../../../src/api/matrix/PodMatrixStore';
import { InMemoryMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';
import { matrixUserIdForWebId } from '../../../src/api/matrix/MatrixIdentity';

const bob = 'https://id.example/people/bob#me';
const alicePod = 'https://pods.example/alice/';
const bobPod = 'https://pods.example/bob/';
const rooms = 520;
const directories: string[] = [];

afterEach(async () => {
  await closeAllIdentityConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * >500 real SQL rows: one sync pass consumes a bounded number of directory
 * pages; later passes continue from the cursor instead of silently hiding
 * older active rooms. Joined remote bindings stay in the cursor.
 */
describe('Matrix directory continuation beyond 500 rooms', () => {
  it('discovers every active reference across bounded sync passes', async () => {
    const root = path.resolve('.test-data/matrix-shared-room/continuation');
    mkdirSync(root, { recursive: true });
    const directoryPath = mkdtempSync(path.join(root, 'sql-'));
    directories.push(directoryPath);
    const db = getIdentityDatabase(`sqlite:${path.join(directoryPath, 'identity.sqlite')}`);
    const isRegistered = async (value: string) => value === alicePod || value === bobPod;
    const directory = new SqlMatrixRoomDirectory(db, isRegistered);
    const binding = await verifyRoomBinding(alicePod, isRegistered);
    const matrixUserId = matrixUserIdForWebId(bob, 'example.test');
    for (let index = 0; index < rooms; index += 1) {
      await directory.register(binding, {
        roomId: `!room-${index}:example.test`,
        roomName: `Room ${index}`,
        creatorWebId: 'https://id.example/people/alice#me',
        inviteeWebId: bob,
        inviteeMatrixUserId: matrixUserId,
        inviteResourceId: `message/invite-${index}.ttl`,
        inviteEventId: `$invite-${index}:example.test`,
        createdAt: 1_700_000_000_000 + index,
      });
    }
    // Real SQL: one bounded page still caps at 500.
    const first = await directory.listForParticipantAfter(bob, 0, 500);
    expect(first.references).toHaveLength(500);
    expect(first.truncated).toBe(true);
    const second = await directory.listForParticipantAfter(bob, first.nextSequence, 500);
    expect(second.references).toHaveLength(20);
    expect(second.truncated).toBe(false);

    // The sync path consumes at most one page per pass and resumes from the
    // cursor, so no room is hidden and no request loops unboundedly.
    const store = new PodMatrixStore({
      serverName: 'example.test',
      journal: new InMemoryMatrixEventJournal(),
      directory,
      verifyStorage: isRegistered,
      directorySyncPageLimit: 1,
    });
    const context = {
      webId: bob, podUrl: bobPod,
      auth: { type: 'solid' as const, webId: bob, clientId: 'bob-device' },
      _matrixDbs: new Map(),
    } as any;
    // Stub only the local Pod DB; remote Pods are unreadable in this test, so
    // the assertion is about directory watermark progress (cursor.invites).
    context._matrixDbs.set(JSON.stringify([bobPod, null]), {
      init: async () => undefined,
      select: () => {
        const query: any = {
          from: () => query, where: () => query,
          then: (ok: any, fail: any) => Promise.resolve([]).then(ok, fail),
        };
        return query;
      },
      findById: async () => undefined,
      insert: () => ({ values: async () => undefined }),
    });
    let since: string | undefined;
    const watermarks: number[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      const sync = await store.sync(context, { since, timeout: 0, limit: 1 });
      since = sync.next_batch;
      const parsed = JSON.parse(Buffer.from(since.slice(3), 'base64url').toString('utf8'));
      watermarks.push(parsed.invites);
    }
    expect(watermarks[0]).toBe(200);
    expect(watermarks[1]).toBe(400);
    expect(watermarks[2]).toBe(520);
    expect(watermarks[3]).toBe(520);
  });
});
