import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeAllIdentityConnections, getIdentityDatabase } from '../../../src/identity/drizzle/db';
import {
  canonicalStorageRoot,
  InMemoryMatrixRoomDirectory,
  SqlMatrixRoomDirectory,
  verifyRoomBinding,
  type MatrixRoomDirectory,
  type MatrixRoomReferenceInput,
} from '../../../src/api/matrix/MatrixRoomDirectory';

const alice = 'https://id.example/people/alice#me';
const bob = 'https://id.example/people/bob#me';
const mallory = 'https://id.example/people/mallory#me';
const alicePod = 'https://pods.example/alice/';
const alicePodChild = 'https://pods.example/alice/.data/chat/matrix-abc/';
const bobPod = 'https://pods.example/bob/';

const directories: string[] = [];

afterEach(async () => {
  await closeAllIdentityConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function openSql(filename: string): SqlMatrixRoomDirectory {
  const database = getIdentityDatabase(`sqlite:${filename}`);
  return new SqlMatrixRoomDirectory(database, isRegistered);
}

function reference(overrides: Partial<MatrixRoomReferenceInput> = {}): MatrixRoomReferenceInput {
  return {
    roomId: '!shared-room:example.test',
    roomAlias: '#shared-room:example.test',
    roomName: 'Alice and Bob',
    creatorWebId: alice,
    inviteeWebId: bob,
    inviteeMatrixUserId: '@u_bob:example.test',
    inviteResourceId: 'message/invite.ttl',
    inviteEventId: '$invite:example.test',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

const isRegistered = async (root: string): Promise<boolean> => root === alicePod || root === bobPod;
const registered = { storage: alicePod, verified: true as const };

async function verified(storage: string): Promise<{ storage: string; verified: true }> {
  return verifyRoomBinding(storage, isRegistered);
}

for (const [name, create] of [
  ['memory', (): MatrixRoomDirectory => new InMemoryMatrixRoomDirectory(isRegistered)],
  ['SQLite', (): MatrixRoomDirectory => openSql(':memory:')],
] as const) {
  describe(`Matrix room directory (${name})`, () => {
    it('stores only the canonical verified binding and reference fields', async () => {
      const directory = create();
      const room = await directory.register(await verified(alicePod), reference());
      expect(room.binding).toEqual({ storage: alicePod, verified: true });
      expect(room.sourceStorage).toBe(alicePod);
      expect(room.roomContainer).toMatch(/^https:\/\/pods\.example\/alice\/\.data\/chat\/matrix-[0-9a-f]{16}\/$/u);
    expect(room.roomContainer).not.toContain('#');
    expect(room.chatIri).toMatch(/#this$/u);
    expect(room.threadIri).toMatch(/#thread$/u);
    expect(room.inviteeWebId).toBe(bob);
      expect(room.inviteeMatrixUserId).toBe('@u_bob:example.test');
      expect(room.inviteEventId).toBe('$invite:example.test');
      expect(room.inviteResourceId).toBe('message/invite.ttl');
      expect(JSON.stringify(room)).not.toMatch(/body|membership|accessToken/iu);
    });

    it('returns references to the invitee and to the creator only', async () => {
      const directory = create();
      await directory.register(await verified(alicePod), reference());
      expect((await directory.listForInvitee(bob)).map(row => row.roomId)).toEqual(['!shared-room:example.test']);
      expect(await directory.listForInvitee(mallory)).toEqual([]);
      expect((await directory.listForParticipant(alice)).map(row => row.roomId)).toEqual(['!shared-room:example.test']);
      expect(await directory.listForParticipant(mallory)).toEqual([]);
      await expect(directory.findForParticipant(mallory, '!shared-room:example.test')).resolves.toBeUndefined();
    });

    it('rejects a room child path that is not the registered Pod root', async () => {
      const directory = create();
      await expect(directory.register({ storage: alicePodChild, verified: true }, reference()))
        .rejects.toMatchObject({ status: 403 });
      expect(await directory.listForInvitee(bob)).toEqual([]);
    });

    it('rejects unverified or unregistered storage before any write', async () => {
      const directory = create();
      await expect(directory.register({ storage: alicePod, verified: false as unknown as true }, reference()))
        .rejects.toMatchObject({ status: 403 });
      await expect(directory.register({ storage: 'https://evil.example/x/', verified: true }, reference()))
        .rejects.toMatchObject({ status: 403 });
      await expect(directory.register({ storage: 'https://pods.example/alice/?q=1', verified: true }, reference()))
        .rejects.toMatchObject({ status: 403 });
      await expect(directory.register({ storage: alicePodChild, verified: true }, reference()))
        .rejects.toMatchObject({ status: 403 });
      expect(await directory.listForInvitee(bob)).toEqual([]);
    });

    it('requires a registered verifier and canonical input', async () => {
      await expect(verifyRoomBinding(alicePod, undefined)).rejects.toMatchObject({ status: 403 });
      await expect(verifyRoomBinding('https://unknown.example/', async () => false)).rejects.toMatchObject({ status: 403 });
      await expect(verifyRoomBinding(alicePodChild, isRegistered)).rejects.toMatchObject({ status: 403 });
      await expect(verifyRoomBinding('https://pods.example/alice', isRegistered)).resolves.toEqual(registered);
      expect(canonicalStorageRoot('https://pods.example/alice')).toBe(alicePod);
      expect(canonicalStorageRoot('https://pods.example/alice/tenant/')).toBe('https://pods.example/alice/tenant/');
      expect(canonicalStorageRoot('https://user:pass@pods.example/alice/')).toBeUndefined();
    });

    it('keeps distinct invitees and distinct storages as separate references', async () => {
      const directory = create();
      await directory.register(await verified(alicePod), reference());
      await directory.register(await verified(alicePod), reference({
        inviteeWebId: mallory, inviteeMatrixUserId: '@u_mallory:example.test', inviteEventId: '$m:example.test',
      }));
      await directory.register(await verified(bobPod), reference({
        roomId: '!bob-room:example.test', inviteEventId: '$b:example.test', creatorWebId: bob, inviteeWebId: alice,
      }));
      expect((await directory.listForInvitee(mallory)).map(row => row.roomId)).toEqual(['!shared-room:example.test']);
      expect((await directory.listForInvitee(bob)).map(row => row.roomId)).toEqual(['!shared-room:example.test']);
      expect((await directory.listForParticipant(alice)).map(row => row.sourceStorage))
        .toEqual(expect.arrayContaining([alicePod, bobPod]));
    });

    it('refuses an ambiguous room id across two verified storages', async () => {
      const directory = create();
      await directory.register(await verified(alicePod), reference());
      await directory.register(await verified(bobPod), reference({ inviteEventId: '$second:example.test' }));
      await expect(directory.findForParticipant(bob, '!shared-room:example.test'))
        .rejects.toMatchObject({ status: 409, errcode: 'M_CONFLICT' });
    });

    it('continues a bounded directory page without dropping older invites', async () => {
      const directory = create();
      const first = await directory.register(await verified(alicePod), reference({ inviteEventId: '$one:example.test' }));
      await directory.register(await verified(alicePod), reference({ roomId: '!two:example.test', inviteEventId: '$two:example.test' }));
      const page = await directory.listForInviteeAfter(bob, 0, 1);
      expect(page.references.map(row => row.roomId)).toEqual(['!shared-room:example.test']);
      expect(page.truncated).toBe(true);
      const next = await directory.listForInviteeAfter(bob, page.nextSequence, 1);
      expect(next.references.map(row => row.roomId)).toEqual(['!two:example.test']);
      expect(next.nextSequence).toBeGreaterThan(first.sequence);
      expect((await directory.listForInviteeAfter(bob, next.nextSequence)).references).toEqual([]);
    });

    it('converges repeated registration of the same invite', async () => {
      const directory = create();
      const first = await directory.register(await verified(alicePod), reference());
      const second = await directory.register(await verified(alicePod), reference());
      expect(second.sequence).toBe(first.sequence);
      expect(await directory.listForInvitee(bob)).toHaveLength(1);
    });
  });
}

describe('Matrix room directory SQLite persistence', () => {
  it('survives process restart with the same reference sequence', async () => {
    const root = path.resolve('.test-data/matrix-shared-room/directory');
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(path.join(root, 'restart-'));
    directories.push(directory);
    const filename = path.join(directory, 'identity.sqlite');

    const first = openSql(filename);
    const registered = await first.register(await verified(alicePod), reference());
    await closeAllIdentityConnections();

    const reopened = openSql(filename);
    const restored = await reopened.listForInvitee(bob);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      sequence: registered.sequence,
      roomId: '!shared-room:example.test',
      binding: { storage: alicePod, verified: true },
      sourceStorage: alicePod,
      inviteEventId: '$invite:example.test',
    });
    const again = await reopened.register(await verified(alicePod), reference());
    expect(again.sequence).toBe(registered.sequence);
  });

  it('does not let a stale or tampered storage string grant a verified binding', async () => {
    const root = path.resolve('.test-data/matrix-shared-room/directory');
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(path.join(root, 'stale-'));
    directories.push(directory);
    const filename = path.join(directory, 'identity.sqlite');
    const db = getIdentityDatabase(`sqlite:${filename}`);
    const store = new SqlMatrixRoomDirectory(db, isRegistered);
    await store.register(await verified(alicePod), reference());

    // A caller-supplied hint is not an access grant: the verifier rejects an
    // unregistered root even if it is well formed.
    await expect(verifyRoomBinding('https://attacker.example/', async root => root === alicePod))
      .rejects.toMatchObject({ status: 403 });
    // And arbitrary input can never be written with a self-declared flag:
    // the directory re-checks canonical form itself.
    await expect(store.register({ storage: 'https://attacker.example/', verified: true }, reference({
      roomId: '!forged:example.test', inviteEventId: '$forged:example.test',
    }))).rejects.toMatchObject({ status: 403 });
  });
});
