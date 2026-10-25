import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chatResource, messageResource } from '@undefineds.co/models';
import { PodMatrixStore } from '../../../src/api/matrix/PodMatrixStore';
import { InMemoryMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';
import {
  InMemoryMatrixRoomDirectory,
  roomContainerOf,
  verifyRoomBinding,
} from '../../../src/api/matrix/MatrixRoomDirectory';
import { encodeSyncCursor } from '../../../src/api/matrix/MatrixSyncCursor';
import { MATRIX_STORAGE_BINDING_EVENT_TYPE, matrixUserIdForWebId } from '../../../src/api/matrix/MatrixIdentity';

const alice = 'https://id.example/people/alice#me';
const bob = 'https://id.example/people/bob#me';
const alicePod = 'https://pods.example/alice/';
const bobPod = 'https://pods.example/bob/';
const roomId = '!authorized-room:example.test';
const bobId = matrixUserIdForWebId(bob, 'example.test');
const surface = `matrix-${createHash('sha256').update(roomId).digest('hex').slice(0, 16)}`;
const chatIri = chatResource.buildIri(alicePod, { id: surface });
const canonicalContainer = roomContainerOf(chatIri);
const evilContainer = 'https://evil.example/.data/chat/evil/';

function isoNow(): string {
  return new Date('2026-10-25T00:00:00.000Z').toISOString();
}

/** Room-Pod rows: one chat document and Bob's current joined membership. */
function roomDb(container: string) {
  const chatId = chatResource.buildId({ id: surface });
  const threadIri = `${chatIri.replace(/#this$/u, '#thread')}`;
  const chatRow = {
    id: chatId,
    title: 'Authorized room',
    author: alice,
    createdAt: isoNow(),
    metadata: { protocol: 'matrix', protocols: { matrix: { roomId } } },
  };
  const memberRow = {
    id: 'member-bob',
    thread: threadIri,
    maker: bob,
    role: 'system',
    content: '{}',
    createdAt: isoNow(),
    metadata: { protocol: 'matrix', protocols: { matrix: {
      eventId: '$member-bob:example.test', roomId, eventType: 'm.room.member', stateKey: bobId,
      originServerTs: 10, senderWebId: bob, content: { membership: 'join' },
    } } },
  };
  const bindingRow = {
    id: 'name-row',
    thread: threadIri,
    maker: alice,
    role: 'system',
    content: '{}',
    createdAt: isoNow(),
    metadata: { protocol: 'matrix', protocols: { matrix: {
      eventId: '$name:example.test', roomId, eventType: 'm.room.name', stateKey: '',
      originServerTs: 11, senderWebId: alice, content: { name: 'Authorized room' },
    } } },
  };
  void container;
  return {
    init: async () => undefined,
    select: () => {
      let table: any;
      const query: any = {
        from: (value: any) => { table = value; return query; },
        where: () => query,
        then: (ok: any, fail: any) => Promise.resolve(
          table === messageResource ? [memberRow, bindingRow] : [chatRow],
        ).then(ok, fail),
      };
      return query;
    },
    findById: async (table: any, id: string) =>
      (table === chatResource ? [chatRow] : [memberRow, bindingRow]).find(row => row.id === id),
    insert: () => ({ values: async () => undefined }),
  };
}

function emptyDb() {
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

async function fixture() {
  const directory = new InMemoryMatrixRoomDirectory(async root => root === alicePod || root === bobPod);
  const verified = await verifyRoomBinding(alicePod, async root => root === alicePod || root === bobPod);
  const reference = await directory.register(verified, {
    roomId,
    roomName: 'Authorized room',
    creatorWebId: alice,
    inviteeWebId: bob,
    inviteeMatrixUserId: bobId,
    inviteResourceId: 'message/invite.ttl',
    inviteEventId: '$invite:example.test',
    createdAt: 1,
  });
  expect(reference.roomContainer).toBe(canonicalContainer);
  const calls: Array<{ webId: string; podUrl: string }> = [];
  const store = new PodMatrixStore({
    serverName: 'example.test',
    journal: new InMemoryMatrixEventJournal(),
    directory,
    verifyStorage: async root => root === alicePod || root === bobPod,
    podAccess: {
      getPodFetch: async (webId, options) => {
        calls.push({ webId, podUrl: options?.podBaseUrl ?? '' });
        throw new Error('tampered cursor must not fetch');
      },
    },
  });
  const seenKeys: string[] = [];
  const cache = new Map<string, any>([
    [JSON.stringify([bobPod, null]), emptyDb()],
    [JSON.stringify([alicePod, canonicalContainer]), roomDb(canonicalContainer)],
  ]);
  const cacheView = {
    has: (key: string) => { seenKeys.push(`has:${key}`); return cache.has(key); },
    get: (key: string) => { seenKeys.push(`get:${key}`); return cache.get(key); },
    set: (key: string, value: any) => { cache.set(key, value); return cacheView; },
  };
  const context = {
    webId: bob, podUrl: bobPod,
    auth: { type: 'solid' as const, webId: bob, clientId: 'bob-device' },
    _matrixDbs: cacheView,
  } as any;
  return { directory, reference, store, calls, seenKeys, context };
}

function cursorWith(bindings: Record<string, any>, invites = 1_000): string {
  return encodeSyncCursor({ version: 3, local: 0, invites, rooms: {}, roomSequences: {}, bindings });
}

describe('Cursor hit: server directory fields win over tampered hint fields', () => {
  it('uses the canonical room endpoint and discards tampered container/chat/thread/creator', async () => {
    const f = await fixture();
    // The genuine reference is below the cursor watermark, so this exercises
    // rehydration by key (not fresh discovery).
    const tampered = {
      storage: alicePod,
      roomId,
      roomContainer: evilContainer,
      chatIri: `${evilContainer}index.ttl#this`,
      threadIri: `${evilContainer}index.ttl#thread`,
      creatorWebId: 'https://evil.example/creator#me',
      createdAt: 999,
    };
    f.seenKeys.length = 0;
    f.calls.length = 0;
    const sync = await f.store.sync(f.context, {
      since: cursorWith({ [JSON.stringify([alicePod, roomId])]: tampered }), timeout: 0,
    });
    // The canonical room-container cache key is used; no evil endpoint is.
    expect(f.seenKeys.some(key => key.includes(canonicalContainer))).toBe(true);
    expect(f.seenKeys.some(key => key.includes('evil.example'))).toBe(false);
    expect(f.calls).toEqual([]);
    const joined = sync.rooms.join[roomId];
    expect(joined).toBeDefined();
    const binding = joined.state.events.find(event => event.type === MATRIX_STORAGE_BINDING_EVENT_TYPE);
    expect(binding?.content).toMatchObject({
      storage: alicePod,
      room_container: canonicalContainer,
      chat: chatIri,
      thread: chatIri.replace(/#this$/u, '#thread'),
      verified: true,
    });
    expect(JSON.stringify(sync)).not.toContain('evil.example');
  });

  it('drops a hint that names the authorized room under a different outer key before routing', async () => {
    const f = await fixture();
    const hint = {
      storage: alicePod,
      roomId,
      roomContainer: canonicalContainer,
      chatIri,
      threadIri: chatIri.replace(/#this$/u, '#thread'),
      creatorWebId: alice,
      createdAt: 1,
    };
    f.seenKeys.length = 0;
    f.calls.length = 0;
    const sync = await f.store.sync(f.context, {
      since: cursorWith({ [JSON.stringify([alicePod, '!different:example.test'])]: hint }), timeout: 0,
    });
    // Directory lookup may occur, but the key mismatch must drop before any
    // room DB routing/fetch.
    expect(f.seenKeys.some(key => key.includes(canonicalContainer))).toBe(false);
    expect(f.calls).toEqual([]);
    expect(sync.rooms.join[roomId]).toBeUndefined();
    expect(JSON.stringify(sync)).not.toContain(MATRIX_STORAGE_BINDING_EVENT_TYPE);
  });
});
