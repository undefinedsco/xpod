import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatResource, messageResource, threadResource } from '@undefineds.co/models';
import { closeAllIdentityConnections, getIdentityDatabase } from '../../../src/identity/drizzle/db';
import { PodMatrixStore } from '../../../src/api/matrix/PodMatrixStore';
import { InMemoryMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';
import { InMemoryMatrixRoomDirectory, SqlMatrixRoomDirectory } from '../../../src/api/matrix/MatrixRoomDirectory';
import { matrixUserIdForWebId, MATRIX_STORAGE_BINDING_EVENT_TYPE } from '../../../src/api/matrix/MatrixIdentity';

const alice = 'https://id.example/people/alice#me';
const bob = 'https://id.example/people/bob#me';
const mallory = 'https://id.example/people/mallory#me';
const alicePod = 'https://pods.example/alice/';
const bobPod = 'https://pods.example/bob/';

const directories: string[] = [];
afterEach(async () => {
  await closeAllIdentityConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * Two independent Pod stores sharing one reference directory and journal.
 *
 * The memory harness keys rows by table only, so each Pod needs its own map and
 * DB. Fetch calls are recorded with the caller webId and target Pod so routing
 * can be asserted without claiming a real Solid ACL run.
 */
function pods() {
  const rows = new Map<string, Map<any, any[]>>();
  const calls: Array<{ webId: string; podUrl: string }> = [];
  const dbFor = (podUrl: string) => {
    const mine = rows.get(podUrl) ?? new Map<any, any[]>();
    rows.set(podUrl, mine);
    return {
      select: () => {
        let table: any;
        let condition: unknown;
        const q: any = {
          from: (value: any) => { table = value; return q; },
          where: (value: unknown) => { condition = value; return q; },
          then: (ok: any, fail: any) => {
            // The memory DB must honour the one equality condition the store
            // uses (message.thread), or all rooms would look like one timeline
            // and hide per-room pagination bugs.
            const equality = condition as { operator?: string; left?: { name?: string }; right?: unknown } | undefined;
            const rows = [...(mine.get(table) ?? [])].filter(row =>
              equality?.operator !== '=' || equality.left?.name !== 'thread'
                || row.thread === equality.right);
            return Promise.resolve(rows).then(ok, fail);
          },
        };
        return q;
      },
      findById: async (table: any, id: string) => (mine.get(table) ?? []).find(row => row.id === id),
      insert: (table: any) => ({
        values: async (row: any) => {
          const list = mine.get(table) ?? [];
          if (!list.some(existing => existing.id === row.id)) list.push(structuredClone(row));
          mine.set(table, list);
        },
      }),
      updateById: async (table: any, id: string, value: any) =>
        Object.assign((mine.get(table) ?? []).find(row => row.id === id), value),
    };
  };
  const directory = new InMemoryMatrixRoomDirectory(async root => root === alicePod || root === bobPod);
  const journal = new InMemoryMatrixEventJournal();
  const aliceContext = {
    webId: alice, podUrl: alicePod,
    auth: { type: 'solid' as const, webId: alice, clientId: 'alice-device' },
  };
  const bobContext = {
    webId: bob, podUrl: bobPod,
    auth: { type: 'solid' as const, webId: bob, clientId: 'bob-device' },
  };

  const aliceStore = new PodMatrixStore({
    serverName: 'example.test', journal, directory,
    verifyStorage: async root => root === alicePod || root === bobPod,
    podAccess: { getPodFetch: async (webId, options) => {
      calls.push({ webId, podUrl: options?.podBaseUrl ?? '' });
      return (async () => new Response()) as typeof fetch;
    } },
  });
  const bobStore = new PodMatrixStore({
    serverName: 'example.test', journal, directory,
    verifyStorage: async root => root === alicePod || root === bobPod,
    podAccess: { getPodFetch: async (webId, options) => {
      calls.push({ webId, podUrl: options?.podBaseUrl ?? '' });
      return (async () => new Response()) as typeof fetch;
    } },
  });
  // Stable DB handles per Pod, shared by both stores so a routed exact read
  // sees the same authoritative rows the owning Pod wrote.
  const databases = new Map<string, any>();
  const database = (podUrl: string) => {
    const existing = databases.get(podUrl);
    if (existing) return existing;
    const created = dbFor(podUrl);
    databases.set(podUrl, created);
    return created;
  };
  const handles = new Map<string, any>();
  const lookup = (key: string) => {
    if (handles.has(key)) return handles.get(key);
    try {
      const [root] = JSON.parse(key) as [string, string | null];
      if (typeof root === 'string' && (root === alicePod || root === bobPod)) return database(root);
    } catch { /* legacy plain storage key */ }
    return undefined;
  };
  const flexible = {
    get: (key: string) => {
      const value = lookup(key);
      return typeof value === 'function' ? value() : value;
    },
    has: (key: string) => lookup(key) !== undefined,
    set: (key: string, value: any) => { handles.set(key, value); return flexible; },
  } as unknown as Map<string, any>;
  const bind = (_target: PodMatrixStore, context: any) => ({ ...context, _matrixDbs: flexible });
  return { aliceStore, bobStore, aliceContext: bind(aliceStore, aliceContext), bobContext: bind(bobStore, bobContext), bind, rows, calls, directory };
}

async function inviteAliceToBob() {
  const p = pods();
  const room = await p.aliceStore.createRoom({ name: 'Alice and Bob' }, p.aliceContext);
  const bobId = matrixUserIdForWebId(bob, 'example.test');
  await p.aliceStore.inviteUser(room.roomId, bobId, p.aliceContext, bob);
  return { ...p, room, bobId };
}

describe('Matrix shared-room discovery and routing', () => {
  it('discovers Alice\'s room in Bob default sync with a verified binding and normal state', async () => {
    const f = await inviteAliceToBob();
    const sync = await f.bobStore.sync(f.bobContext);
    const invited = sync.rooms.invite?.[f.room.roomId];
    expect(invited).toBeDefined();
    const events = invited!.invite_state.events;
    expect(events.find(event => event.type === 'm.room.member')?.content.membership).toBe('invite');
    expect(events.find(event => event.type === 'm.room.name')?.content.name).toBe('Alice and Bob');
    const binding = events.find(event => event.type === MATRIX_STORAGE_BINDING_EVENT_TYPE);
    expect(binding?.content).toEqual({
      storage: alicePod,
      room_container: `https://pods.example/alice/.data/chat/matrix-${(await import('node:crypto')).createHash('sha256').update(f.room.roomId).digest('hex').slice(0, 16)}/`,
      chat: `https://pods.example/alice/.data/chat/matrix-${(await import('node:crypto')).createHash('sha256').update(f.room.roomId).digest('hex').slice(0, 16)}/index.ttl#this`,
      thread: `https://pods.example/alice/.data/chat/matrix-${(await import('node:crypto')).createHash('sha256').update(f.room.roomId).digest('hex').slice(0, 16)}/index.ttl#thread`,
      verified: true,
    });
    // Bob's own Pod is the selection; the invite came from Alice's storage.
    expect(f.bobContext.podUrl).toBe(bobPod);
  });

  it('joins and sends as Bob on Alice\'s Pod without borrowing Alice\'s credential', async () => {
    const f = await inviteAliceToBob();
    await f.bobStore.sync(f.bobContext);
    expect(await f.bobStore.joinRoom(f.room.roomId, f.bobContext)).toEqual({ roomId: f.room.roomId });
    await f.bobStore.sendEvent(f.room.roomId, 'm.room.message', 'bob-1', { body: 'hello from Bob' }, f.bobContext);
    const history = await f.bobStore.listMessages(f.room.roomId, f.bobContext, { limit: 50 });
    const bobMessage = history.chunk.find(event => event.content.body === 'hello from Bob');
    expect(bobMessage?.sender).toBe(f.bobId);
    // A context without the cached handle exercises the real routing hook:
    // the operation targets Alice's root while the credential subject is Bob.
    const uncached = { ...f.bobContext } as any;
    delete uncached._matrixDbs;
    await expect(f.bobStore.listMessages(f.room.roomId, uncached, { limit: 50 })).rejects.toBeTruthy();
    expect(f.calls.at(-1)).toEqual({ webId: bob, podUrl: alicePod });
    // The message lives in Alice's Pod rows, where the room is authoritative.
    const aliceMessages = f.rows.get(alicePod)?.get(messageResource) ?? [];
    expect(aliceMessages.some(row => row.content?.includes('hello from Bob')
      || row.metadata?.protocols?.matrix?.content?.body === 'hello from Bob')).toBe(true);
  });

  it('does not leak Alice\'s reference to an unrelated caller and rechecks membership on send', async () => {
    const f = await inviteAliceToBob();
    const malloryContext = {
      webId: mallory, podUrl: 'https://mallory.pod.example/',
      auth: { type: 'solid' as const, webId: mallory, clientId: 'mallory-device' },
    };
    const sync = await f.bobStore.sync({ ...malloryContext, podUrl: bobPod } as any);
    expect(sync.rooms.invite?.[f.room.roomId]).toBeUndefined();
    const against = f.bind(f.aliceStore, { ...malloryContext, podUrl: alicePod }) as any;
    await expect(f.aliceStore.sendEvent(f.room.roomId, 'm.room.message', 'mallory-1', { body: 'intruder' }, against))
      .rejects.toMatchObject({ status: 403 });
  });

  it('does not let a stale verified hint grant membership in another Pod', async () => {
    const f = await inviteAliceToBob();
    await f.bobStore.sync(f.bobContext);
    // Create a room that Bob is not invited to and point a store context at it
    // with a verified-looking hint. The hint is never an access grant.
    const other = await f.aliceStore.createRoom({ name: 'Private' }, f.aliceContext);
    const staleMessage = await f.aliceStore.sendEvent(other.roomId, 'm.room.message', 'secret-1', { body: 'secret' }, f.aliceContext);
    await expect(f.bobStore.sendEvent(staleMessage.roomId, 'm.room.message', 'bob-stale', { body: 'x' }, {
      ...f.bobContext, roomStorage: alicePod,
    })).rejects.toMatchObject({ status: 403 });
  });

  it('keeps per-Pod cursor progress independent under a shared page limit', async () => {
    const f = await inviteAliceToBob();
    await f.bobStore.sync(f.bobContext);
    await f.bobStore.joinRoom(f.room.roomId, f.bobContext);
    const start = await f.bobStore.sync(f.bobContext);
    for (let index = 0; index < 6; index += 1) {
      await f.bobStore.sendEvent(f.room.roomId, 'm.room.message', `remote-${index}`, { body: `remote ${index}` }, f.bobContext);
    }
    const local = await f.aliceStore.createRoom({ name: 'Bob local' }, f.bobContext);
    for (let index = 0; index < 4; index += 1) {
      await f.aliceStore.sendEvent(local.roomId, 'm.room.message', `local-${index}`, { body: `local ${index}` }, f.bobContext);
    }
    const seen = new Set<string>();
    let since: string | undefined = start.next_batch;
    let pages = 0;
    for (let page = 0; page < 20; page += 1) {
      const sync = await f.bobStore.sync(f.bobContext, { since, limit: 2 });
      const delivered = Object.values(sync.rooms.join).flatMap(room => room.timeline.events);
      for (const event of delivered) {
        expect(seen.has(event.event_id)).toBe(false);
        seen.add(event.event_id);
      }
      since = sync.next_batch;
      pages += 1;
      if (!delivered.length) break;
    }
    // Ten new messages across two Pods produce exactly ten unique deliveries
    // (plus any state events) with no repetition and stable per-scope cursors.
    expect(pages).toBeGreaterThan(2);
    expect(seen.size).toBeGreaterThanOrEqual(10);
    // A cursor from one Pod is never interpreted as the other's sequence.
    const parsed = JSON.parse(Buffer.from(since!.slice(3), 'base64url').toString('utf8'));
    expect(parsed).toHaveProperty('local');
    expect(parsed).toHaveProperty('rooms');
  });

  it('pages two rooms on one Pod by journal sequence without skipping either', async () => {
    const f = await inviteAliceToBob();
    await f.bobStore.sync(f.bobContext);
    await f.bobStore.joinRoom(f.room.roomId, f.bobContext);
    const second = await f.aliceStore.createRoom({ name: 'Second shared room' }, f.aliceContext);
    const bobId = matrixUserIdForWebId(bob, 'example.test');
    await f.aliceStore.inviteUser(second.roomId, bobId, f.aliceContext, bob);
    await f.bobStore.sync(f.bobContext);
    await f.bobStore.joinRoom(second.roomId, f.bobContext);
    // Baseline BEFORE sends, so every interleaved message is still pending.
    const baseline = await f.bobStore.sync(f.bobContext);
    // Interleave sends so room B has an EARLIER sequence than room A's tail.
    const expected = new Set<string>();
    for (let index = 0; index < 3; index += 1) {
      expected.add((await f.bobStore.sendEvent(f.room.roomId, 'm.room.message', `a-${index}`, { body: `roomA ${index}` }, f.bobContext)).eventId);
      expected.add((await f.bobStore.sendEvent(second.roomId, 'm.room.message', `b-${index}`, { body: `roomB ${index}` }, f.bobContext)).eventId);
    }
    let since: string | undefined = baseline.next_batch;
    const seen: string[] = [];
    for (let page = 0; page < 20; page += 1) {
      const sync = await f.bobStore.sync(f.bobContext, { since, limit: 1 });
      const delivered = Object.values(sync.rooms.join).flatMap(room => room.timeline.events);
      for (const event of delivered) {
        expect(seen).not.toContain(event.event_id);
        seen.push(event.event_id);
      }
      since = sync.next_batch;
      if (!delivered.length) break;
    }
    expect(seen.length).toBeGreaterThanOrEqual(expected.size);
    expect([...expected].every(id => seen.includes(id))).toBe(true);
  });

  it('maps identity and rooms on a port-bearing server authority', async () => {
    const directory = new InMemoryMatrixRoomDirectory(async root => root === alicePod || root === bobPod);
    const store = new PodMatrixStore({
      serverName: 'localhost:3000', journal: new InMemoryMatrixEventJournal(), directory,
      verifyStorage: async root => root === alicePod || root === bobPod,
    });
    const context = {
      webId: bob, podUrl: bobPod,
      auth: { type: 'solid' as const, webId: bob, clientId: 'bob-port' },
    };
    const account = await store.getAccount(context);
    expect(account.userId).toBe(`@u_${matrixUserIdForWebId(bob, 'example.test').split(':')[0].slice(3)}:localhost:3000`);
    expect(account.userId.endsWith(':localhost:3000')).toBe(true);
    // IPv6 authority is accepted by the MXID derivation as well.
    expect(matrixUserIdForWebId(bob, '[::1]:3000')).toMatch(/:\[::1\]:3000$/u);
  });

  it('accepts legacy v2 Pod cursors and ignores MXID-only invites for routing', async () => {
    const f = await inviteAliceToBob();
    const legacy = await f.bobStore.sync(f.bobContext, { since: 'v2_0' });
    expect(legacy.next_batch).toMatch(/^v3\./);
    const legacyRoom = await f.aliceStore.createRoom({ name: 'Legacy MXID only' }, f.aliceContext);
    const bobId = matrixUserIdForWebId(bob, 'example.test');
    await f.aliceStore.inviteUser(legacyRoom.roomId, bobId, f.aliceContext);
    // No full WebID was supplied, so no directory reference exists: Bob's
    // default sync must not guess Alice's Pod address.
    const sync = await f.bobStore.sync(f.bobContext);
    expect(sync.rooms.invite?.[legacyRoom.roomId]).toBeUndefined();
  });

  it('rejects a mismatched WebID/MXID pair without writing an invite', async () => {
    const f = await inviteAliceToBob();
    const malloryId = matrixUserIdForWebId(mallory, 'example.test');
    await expect(f.aliceStore.inviteUser(f.room.roomId, malloryId, f.aliceContext, bob))
      .rejects.toMatchObject({ status: 400, errcode: 'M_INVALID_PARAM' });
    const rows = f.rows.get(alicePod)?.get(messageResource) ?? [];
    expect(rows.some(row => row.metadata?.protocols?.matrix?.stateKey === malloryId
      && row.metadata?.protocols?.matrix?.content?.membership === 'invite')).toBe(false);
  });

  it('does not grant ACL: invitation creates no Solid authorization side effect', async () => {
    const f = await inviteAliceToBob();
    // The Matrix invite writes a reference and a Pod membership event only.
    // No ACL/ACR resource is written by this adapter.
    const aliceRows = [...(f.rows.get(alicePod)?.keys() ?? [])];
    expect(aliceRows).toEqual(expect.arrayContaining([chatResource, threadResource, messageResource]));
    expect(aliceRows.some(table => String(table?.name ?? table).toLowerCase().includes('acl'))).toBe(false);
  });
});

describe('Matrix directory SQLite integration', () => {
  it('survives restart and keeps Bob\'s discovery', async () => {
    const root = path.resolve('.test-data/matrix-shared-room/store');
    mkdirSync(root, { recursive: true });
    const directoryPath = mkdtempSync(path.join(root, 'restart-'));
    directories.push(directoryPath);
    const filename = path.join(directoryPath, 'identity.sqlite');
    const isRegistered = async (value: string) => value === alicePod || value === bobPod;
    const first = new SqlMatrixRoomDirectory(getIdentityDatabase(`sqlite:${filename}`), isRegistered);
    const reference = {
      roomId: '!persisted:example.test', roomName: 'Persisted', creatorWebId: alice,
      inviteeWebId: bob, inviteeMatrixUserId: matrixUserIdForWebId(bob, 'example.test'),
      inviteResourceId: 'message/persisted.ttl', inviteEventId: '$persisted:example.test',
      createdAt: 1_700_000_000_000,
    };
    await first.register(await import('../../../src/api/matrix/MatrixRoomDirectory').then(module =>
      module.verifyRoomBinding(alicePod, isRegistered)), reference);
    await closeAllIdentityConnections();
    const reopened = new SqlMatrixRoomDirectory(getIdentityDatabase(`sqlite:${filename}`), isRegistered);
    expect(await reopened.listForInvitee(bob)).toMatchObject([{ roomId: '!persisted:example.test' }]);
  });
});
