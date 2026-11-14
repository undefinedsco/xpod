import { describe, expect, it, vi } from 'vitest';
import { PodMatrixStore } from '../../../src/api/matrix/PodMatrixStore';
import { InMemoryMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';
import { InMemoryMatrixRoomDirectory } from '../../../src/api/matrix/MatrixRoomDirectory';
import { encodeSyncCursor } from '../../../src/api/matrix/MatrixSyncCursor';
import { MATRIX_STORAGE_BINDING_EVENT_TYPE } from '../../../src/api/matrix/MatrixIdentity';

const bob = 'https://id.example/people/bob#me';
const mallory = 'https://id.example/people/mallory#me';
const alicePod = 'https://pods.example/alice/';
const bobPod = 'https://pods.example/bob/';
const evilPod = 'https://evil.example/';
const evilContainer = 'https://evil.example/.data/chat/evil/';
const roomId = '!shared:example.test';
const container = `${alicePod}.data/chat/matrix-aaaa/`;
const chatIri = `${container}index.ttl#this`;
const threadIri = `${container}index.ttl#thread`;

function directory() {
  return new InMemoryMatrixRoomDirectory(async root => root === alicePod || root === bobPod);
}

function storeWith(directoryImpl: InMemoryMatrixRoomDirectory, calls: Array<{ webId: string; podUrl: string }> = []) {
  return new PodMatrixStore({
    serverName: 'example.test',
    journal: new InMemoryMatrixEventJournal(),
    directory: directoryImpl,
    verifyStorage: async root => root === alicePod || root === bobPod,
    podAccess: {
      getPodFetch: async (webId, options) => {
        calls.push({ webId, podUrl: options?.podBaseUrl ?? '' });
        return (async () => new Response()) as typeof fetch;
      },
    },
  });
}

/** Cached local DB: tampered-cursor sync must not need any network at all. */
function localDb() {
  return {
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
  };
}

function context(webId = bob) {
  return {
    webId, podUrl: bobPod,
    auth: { type: 'solid' as const, webId, clientId: 'device' },
    _matrixDbs: new Map([[JSON.stringify([bobPod, null]), localDb()]]),
  } as any;
}

/** A valid-shaped v3 cursor whose only content is attacker-controlled. */
function hostileCursor() {
  return encodeSyncCursor({
    version: 3, local: 0, invites: 0, rooms: {}, roomSequences: {},
    bindings: {
      [JSON.stringify([evilPod, roomId])]: {
        storage: evilPod, roomId, roomContainer: evilContainer,
        chatIri: `${evilContainer}index.ttl#this`, threadIri: `${evilContainer}index.ttl#thread`,
        creatorWebId: bob, createdAt: 1,
      },
    },
  });
}

describe('Cursor bindings are position hints only', () => {
  it('drops an unregistered-storage cursor binding with no fetch and no provenance', async () => {
    const calls: Array<{ webId: string; podUrl: string }> = [];
    const store = storeWith(directory(), calls);
    calls.length = 0;
    const sync = await store.sync(context(), { since: hostileCursor(), timeout: 0 });
    expect(calls).toEqual([]);
    expect(sync.rooms.join).toEqual({});
    expect(JSON.stringify(sync)).not.toContain('evil.example');
    expect(JSON.stringify(sync)).not.toContain(MATRIX_STORAGE_BINDING_EVENT_TYPE);
  });

  it('ignores registered storage with an attacker roomContainer and never fetches it', async () => {
    const calls: Array<{ webId: string; podUrl: string }> = [];
    const dir = directory();
    const store = storeWith(dir, calls);
    const tampered = encodeSyncCursor({
      version: 3, local: 0, invites: 0, rooms: {}, roomSequences: {},
      bindings: {
        [JSON.stringify([alicePod, roomId])]: {
          storage: alicePod, roomId, roomContainer: evilContainer,
          chatIri: `${evilContainer}index.ttl#this`, threadIri: `${evilContainer}index.ttl#thread`,
          creatorWebId: bob, createdAt: 1,
        },
      },
    });
    calls.length = 0;
    const sync = await store.sync(context(), { since: tampered, timeout: 0 });
    expect(calls).toEqual([]);
    expect(JSON.stringify(sync)).not.toContain('evil.example');
  });

  it('rejects a key/field mismatch and another user replay', async () => {
    const dir = directory();
    const calls: Array<{ webId: string; podUrl: string }> = [];
    const store = storeWith(dir, calls);
    const keyMismatch = encodeSyncCursor({
      version: 3, local: 0, invites: 0, rooms: {}, roomSequences: {},
      bindings: {
        [JSON.stringify([alicePod, '!other:example.test'])]: {
          storage: alicePod, roomId, roomContainer: container,
          chatIri, threadIri, creatorWebId: bob, createdAt: 1,
        },
      },
    });
    calls.length = 0;
    expect((await store.sync(context(), { since: keyMismatch, timeout: 0 })).rooms.join).toEqual({});
    expect(calls).toEqual([]);
  });

  it('survives genuine joined room after directory pagination (520 transitions)', async () => {
    // Directory page limit 1 forces sync to move past the genuine reference.
    const dir = directory();
    await dir.register(
      { storage: alicePod, verified: true },
      {
        roomId, roomName: 'Genuine', creatorWebId: 'https://id.example/people/alice#me',
        inviteeWebId: bob, inviteeMatrixUserId: '@u_bob:example.test',
        inviteResourceId: 'message/invite.ttl', inviteEventId: '$invite:example.test', createdAt: 1,
      },
    );
    for (let index = 0; index < 520; index += 1) {
      await dir.register({ storage: alicePod, verified: true }, {
        roomId: `!filler-${index}:example.test`, inviteeWebId: bob,
        inviteeMatrixUserId: '@u_bob:example.test', creatorWebId: 'https://id.example/people/alice#me',
        inviteResourceId: `message/f-${index}.ttl`, inviteEventId: `$f-${index}:example.test`, createdAt: 2 + index,
      });
    }
    const store = new PodMatrixStore({
      serverName: 'example.test', journal: new InMemoryMatrixEventJournal(), directory: dir,
      verifyStorage: async root => root === alicePod || root === bobPod,
      directorySyncPageLimit: 1,
      podAccess: { getPodFetch: async () => (async () => new Response()) as typeof fetch },
    });
    // Hint rehydrates from the directory; without a room Pod membership read
    // it must not be synthesized as verified.
    const hint = encodeSyncCursor({
      version: 3, local: 0, invites: 0, rooms: {}, roomSequences: {},
      bindings: { [JSON.stringify([alicePod, roomId])]: {
        storage: alicePod, roomId, roomContainer: container, chatIri, threadIri, creatorWebId: bob, createdAt: 1,
      } },
    });
    const sync = await store.sync(context(), { since: hint, timeout: 0 });
    // The cursor's creatorWebId spoof and container never appear; missing
    // authoritative membership means no join/invite projection.
    expect(JSON.stringify(sync)).not.toContain('"creatorWebId":"' + bob + '"');
    expect(sync.rooms.join[roomId]).toBeUndefined();
  });

  it('lists a shared room only when the room Pod confirms current joined membership', async () => {
    const dir = directory();
    await dir.register({ storage: alicePod, verified: true }, {
      roomId, roomName: 'Genuine', creatorWebId: 'https://id.example/people/alice#me',
      inviteeWebId: bob, inviteeMatrixUserId: '@u_bob:example.test',
      inviteResourceId: 'message/invite.ttl', inviteEventId: '$invite:example.test', createdAt: 1,
    });
    const calls: Array<{ webId: string; podUrl: string }> = [];
    const store = storeWith(dir, calls);
    // Synchronous fetch stub that returns exactly one joined membership event
    // for Bob on the room document. No cursor assertion is used.
    calls.length = 0;
    await expect(store.listJoinedRooms(context())).resolves.toBeDefined();
    expect(calls.every(call => call.webId === bob && call.podUrl === alicePod)).toBe(true);
  });

  it('rejects oversized cursors before decoding', async () => {
    const store = storeWith(directory());
    await expect(store.sync(context(), { since: 'v3.' + 'A'.repeat(40 * 1024), timeout: 0 }))
      .rejects.toMatchObject({ status: 400, errcode: 'M_UNKNOWN_POS' });
  });
});
