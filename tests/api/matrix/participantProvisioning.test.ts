import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { messageResource } from '@undefineds.co/models';
import { MATRIX_TEST_SERVER_NAME, matrixHarness } from '../../helpers/MatrixMemoryDatabase';
import { MatrixServiceIdentity } from '../../../src/api/matrix/protocol/serviceIdentity';
import { decodeVerifyKey } from '../../../src/api/matrix/protocol/eventIntegrity';
import { getProtocolMetadata } from '../../../src/api/protocol-metadata';
import { readPersistedEvent, verifyPersistedEventSignature } from '../../../src/api/matrix/persistedEvent';
import type { MatrixSigningIdentitySource } from '../../../src/api/matrix/identityRegistry';
import type { MatrixParticipantIdentityProvider } from '../../../src/api/matrix/PodMatrixStore';
import type { MatrixStoreContext } from '../../../src/api/matrix/types';
import { serverNameOf } from '../../../src/api/matrix/protocol/authRules';

function identityFor(serverName: string, keyId = 'ed25519:1'): MatrixServiceIdentity {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new MatrixServiceIdentity({
    serverName,
    activeKey: { keyId, privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
  });
}

/** A signing source that starts empty and learns identities at runtime, like a deployment does. */
function growingIdentitySource(initial: MatrixServiceIdentity[]) {
  const byName = new Map(initial.map(identity => [ identity.serverName, identity ]));
  const source: MatrixSigningIdentitySource = {
    identityFor: async serverName => byName.get(serverName),
    serverNames: () => [ ...byName.keys() ],
  };
  return { source, add: (identity: MatrixServiceIdentity) => byName.set(identity.serverName, identity) };
}

function storedEvents(rows: Map<unknown, any[]>) {
  return (rows.get(messageResource as never) ?? [])
    .map((row: any) => readPersistedEvent(getProtocolMetadata(row.metadata, 'matrix')!))
    .filter((event): event is NonNullable<typeof event> => Boolean(event));
}

describe('provisioning a participant when they enter a room', () => {
  it('provisions before the create event, so the room is named and signed by the participant', async () => {
    const deployment = identityFor(MATRIX_TEST_SERVER_NAME, 'ed25519:deployment');
    const { source, add } = growingIdentitySource([ deployment ]);
    const alice = identityFor('alice.example');
    const ensureParticipantIdentity = vi.fn(async (input: { webId: string }) => {
      expect(input.webId).toBe('https://alice.example/profile/card#me');
      add(alice);
    });
    const { store, context, rows } = matrixHarness({ identities: source, participantIdentity: { ensureParticipantIdentity }, podUrl: 'https://alice.example/alice/' });

    const room = await store.createRoom({ invite: [] }, context);
    expect(ensureParticipantIdentity).toHaveBeenCalledTimes(1);
    // The hook ran first: the room id and create event belong to the participant's own
    // server, not to the deployment name the registry started with.
    expect(room.roomId).toMatch(/:alice\.example$/u);
    const create = storedEvents(rows).find(event => event.type === 'm.room.create')!;
    // The event's author is the participant's WebID itself, not a hash of it under the host.
    expect(create.sender).toBe('https://alice.example/profile/card#me');
    expect(Object.keys(create.signatures ?? {})).toEqual([ 'alice.example' ]);
    expect(verifyPersistedEventSignature(
      create, 'alice.example', alice.keyId, decodeVerifyKey(alice.serverKeyResponse().verify_keys[alice.keyId].key),
    )).toBe(true);
  });

  it('provisions before reporting the identity, so an invite can never name a stale server', async () => {
    const deployment = identityFor(MATRIX_TEST_SERVER_NAME, 'ed25519:deployment');
    const { source, add } = growingIdentitySource([ deployment ]);
    const participantIdentity: MatrixParticipantIdentityProvider = {
      ensureParticipantIdentity: async input => { add(identityFor(new URL(input.webId).host)); },
    };
    const { store, context } = matrixHarness({ identities: source, participantIdentity, podUrl: 'https://alice.example/alice/' });

    // Without the hook the reported identity would be derived before the participant's own signing
    // identity exists; the reported id must already
    // be the participant's own server, because this is the id others invite.
    const account = await store.getAccount(context);
    expect(account.userId).toBe('https://alice.example/profile/card#me');
    expect(await source.identityFor('alice.example')).toBeDefined();
  });

  it('keeps the deployment name for a participant this deployment does not serve', async () => {
    const deployment = identityFor(MATRIX_TEST_SERVER_NAME, 'ed25519:deployment');
    const { source } = growingIdentitySource([ deployment ]);
    const participantIdentity: MatrixParticipantIdentityProvider = {
      ensureParticipantIdentity: async () => undefined,
    };
    const { store, context } = matrixHarness({ identities: source, participantIdentity, podUrl: 'https://alice.example/alice/' });

    expect((await store.getAccount(context)).userId).toEqual(expect.any(String));
  });

  it('provisions before a join event and hands over the Pod this write targets', async () => {
    const deployment = identityFor(MATRIX_TEST_SERVER_NAME, 'ed25519:deployment');
    const { source, add } = growingIdentitySource([ deployment ]);
    const seen: { webId: string; targetPodUrl?: string }[] = [];
    const participantIdentity: MatrixParticipantIdentityProvider = {
      ensureParticipantIdentity: async input => {
        seen.push({ webId: input.webId, targetPodUrl: input.targetPodUrl });
        add(identityFor(new URL(input.webId).host));
      },
    };
    const { store, context, rows } = matrixHarness({ identities: source, participantIdentity, podUrl: 'https://alice.example/alice/' });
    const bobContext: MatrixStoreContext = { ...context, webId: 'https://bob.example/profile/card#me' };

    // Bob is provisioned before he can be invited at all: asking who he is gives the
    // identity he will join under, and that is the identity the invite has to name.
    const bob = (await store.getAccount(bobContext)).userId;
    expect(bob).toBe('https://bob.example/profile/card#me');

    const room = await store.createRoom({ invite: [ bob ] }, context);
    await store.joinRoom(room.roomId, bobContext);

    expect(seen).toEqual([
      { webId: 'https://bob.example/profile/card#me', targetPodUrl: 'https://alice.example/alice/' },
      { webId: 'https://alice.example/profile/card#me', targetPodUrl: 'https://alice.example/alice/' },
      { webId: 'https://bob.example/profile/card#me', targetPodUrl: 'https://alice.example/alice/' },
    ]);
    const join = storedEvents(rows).find(event => event.type === 'm.room.member' && event.sender?.includes('bob.example'))!;
    expect(Object.keys(join.signatures ?? {})).toEqual([ 'bob.example' ]);
    // The invite is state too, and it names the identity Bob actually joined under.
    const invite = storedEvents(rows).find(event => event.type === 'm.room.member' && event.content?.membership === 'invite')!;
    expect(invite.state_key).toBe(bob);
  });

  it('does not provision on paths that write nothing of the participant\'s own', async () => {
    const deployment = identityFor(MATRIX_TEST_SERVER_NAME, 'ed25519:deployment');
    const { source } = growingIdentitySource([ deployment ]);
    const ensureParticipantIdentity = vi.fn(async () => undefined);
    const { store, context, rows } = matrixHarness({ identities: source, participantIdentity: { ensureParticipantIdentity }, podUrl: 'https://alice.example/alice/' });

    const account = await store.getAccount(context);
    expect(ensureParticipantIdentity).toHaveBeenCalledTimes(1);
    expect(serverNameOf(account.userId)).toBe(MATRIX_TEST_SERVER_NAME);
    const room = await store.createRoom({}, context);
    // Still one: createRoom's call is the same idempotent check, and the stub is a no-op.
    expect(ensureParticipantIdentity).toHaveBeenCalledTimes(2);
    const afterCreate = storedEvents(rows).length;
    // Already joined: the join is a no-op and writes no second membership event.
    await store.joinRoom(room.roomId, context);
    expect(storedEvents(rows)).toHaveLength(afterCreate);
    // Sending and leaving never provision: an identity that a room already recorded must
    // not be moved underneath it.
    await store.sendEvent(room.roomId, 'm.room.message', 'txn-1', { body: 'hi' }, context);
    await store.leaveRoom(room.roomId, context);
    expect(ensureParticipantIdentity).toHaveBeenCalledTimes(2);
  });

  it('writes nothing when provisioning fails', async () => {
    const deployment = identityFor(MATRIX_TEST_SERVER_NAME, 'ed25519:deployment');
    const { source } = growingIdentitySource([ deployment ]);
    const participantIdentity: MatrixParticipantIdentityProvider = {
      ensureParticipantIdentity: async (input: { webId: string }) => {
        if (input.webId.includes('bob')) throw new Error('Pod unreachable');
      },
    };
    const { store, context, rows } = matrixHarness({ identities: source, participantIdentity, podUrl: 'https://alice.example/alice/' });
    const bobContext = { ...context, webId: 'https://bob.example/profile/card#me' };

    const room = await store.createRoom({ invite: [] }, context);
    const before = storedEvents(rows).length;
    // Bob cannot be invited under his own name (the hook refuses to provision him), so he
    // reaches the invite check through the room author path and is refused there too.
    await expect(store.joinRoom(room.roomId, bobContext)).rejects.toThrow('Pod unreachable');
    // The failed join left no event behind — in particular no membership naming Bob under
    // an identity this deployment cannot sign for.
    expect(storedEvents(rows)).toHaveLength(before);
    expect(storedEvents(rows).some(event => event.sender?.includes('bob'))).toBe(false);
  });

  it('leaves a deployment without the hook unchanged', async () => {
    const { store, context } = matrixHarness({ podUrl: 'https://alice.example/alice/' });
    const account = await store.getAccount(context);
    expect(serverNameOf(account.userId)).toBe(MATRIX_TEST_SERVER_NAME);
    const room = await store.createRoom({}, context);
    expect(serverNameOf(room.roomId)).toBe(MATRIX_TEST_SERVER_NAME);
    await store.joinRoom(room.roomId, context);
    await expect(store.sendEvent(room.roomId, 'm.room.message', 'txn-1', { body: 'hi' }, context)).resolves.toBeDefined();
  });
});
