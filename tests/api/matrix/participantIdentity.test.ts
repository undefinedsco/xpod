import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { messageResource } from '@undefineds.co/models';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';
import { matrixSigningIdentityRegistry } from '../../../src/api/matrix/identityRegistry';
import { InMemoryMatrixSigningKeyStore, MatrixSigningIdentityProvider } from '../../../src/api/matrix/signingKeyStore';
import { MatrixServiceIdentity } from '../../../src/api/matrix/protocol/serviceIdentity';
import { decodeVerifyKey } from '../../../src/api/matrix/protocol/eventIntegrity';
import { getProtocolMetadata } from '../../../src/api/protocol-metadata';
import { readPersistedEvent, verifyPersistedEventSignature } from '../../../src/api/matrix/persistedEvent';

function deploymentIdentity(serverName: string): MatrixServiceIdentity {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new MatrixServiceIdentity({
    serverName,
    activeKey: { keyId: 'ed25519:deployment', privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
  });
}

function providerFor(serverName: string) {
  return {
    serverName,
    provider: new MatrixSigningIdentityProvider({
      store: new InMemoryMatrixSigningKeyStore(),
      serverName,
      now: () => 1_000,
    }),
  };
}

/** A registry holding one identity per participant plus the deployment's own identity. */
function participantRegistry() {
  return matrixSigningIdentityRegistry({
    identity: deploymentIdentity('example.test'),
    providers: [ providerFor('alice.example'), providerFor('bob.example') ],
  });
}

function storedEvent(rows: Map<unknown, any[]>, eventId: string) {
  const row = rows.get(messageResource as never)!
    .find((item: any) => (getProtocolMetadata(item.metadata, 'matrix')?.event as any)?.event_id === eventId);
  expect(row, `the row storing ${eventId}`).toBeDefined();
  return readPersistedEvent(getProtocolMetadata(row.metadata, 'matrix')!)!;
}

async function publishedKey(registry: ReturnType<typeof participantRegistry>, serverName: string) {
  const identity = await registry.identityFor(serverName);
  const response = identity!.serverKeyResponse();
  return {
    identity: identity!,
    verify: (event: Record<string, unknown>) => verifyPersistedEventSignature(
      event as never, serverName, identity!.keyId, decodeVerifyKey(response.verify_keys[identity!.keyId].key)),
  };
}

describe('participant signing identities', () => {
  it('names and signs each participant under the server whose key this deployment holds', async () => {
    const registry = participantRegistry();
    const { store, context, rows } = matrixHarness({ identities: registry });
    const bobContext = { ...context, webId: 'https://bob.example/profile/card#me' };

    const alice = (await store.getAccount(context)).userId;
    const bob = (await store.getAccount(bobContext)).userId;
    // The WebID host is the server name, because this deployment holds that identity.
    expect(alice).toMatch(/:alice\.example$/u);
    expect(bob).toMatch(/:bob\.example$/u);

    const room = await store.createRoom({ invite: [ bob ] }, context);
    expect(room.roomId).toMatch(/:alice\.example$/u);
    const create = storedEvent(rows, (await store.currentState(room.roomId, context)).get('m.room.create')!.eventId);
    expect(create.sender).toBe(alice);
    expect(Object.keys(create.signatures ?? {})).toEqual([ 'alice.example' ]);

    await store.joinRoom(room.roomId, bobContext);
    const join = rows.get(messageResource as never)!
      .map((row: any) => readPersistedEvent(getProtocolMetadata(row.metadata, 'matrix')!))
      .find(event => event?.type === 'm.room.member' && event.sender === bob)!;
    expect(Object.keys(join.signatures ?? {})).toEqual([ 'bob.example' ]);

    // Each event verifies against its own server's published key and not the other's.
    const aliceKey = await publishedKey(registry, 'alice.example');
    const bobKey = await publishedKey(registry, 'bob.example');
    expect(aliceKey.verify(create)).toBe(true);
    expect(bobKey.verify(create)).toBe(false);

    const sent = await store.sendEvent(room.roomId, 'm.room.message', 'from-alice', { body: 'hello' }, context);
    expect(aliceKey.verify(storedEvent(rows, sent.eventId))).toBe(true);
    expect(bobKey.verify(storedEvent(rows, sent.eventId))).toBe(false);
  });

  it('falls back to the deployment identity for a WebID whose server it does not sign for', async () => {
    const registry = participantRegistry();
    const { store, context, rows } = matrixHarness({ identities: registry });
    const carolContext = { ...context, webId: 'https://carol.example/profile/card#me' };

    const carol = (await store.getAccount(carolContext)).userId;
    // No key for carol.example, so she is served under the deployment's own name — and
    // the event is signed by that name, so sender and signature agree.
    expect(carol).toMatch(/:example\.test$/u);

    const room = await store.createRoom({}, carolContext);
    expect(room.roomId).toMatch(/:example\.test$/u);
    const sent = await store.sendEvent(room.roomId, 'm.room.message', 'from-carol', { body: 'hi' }, carolContext);
    const event = storedEvent(rows, sent.eventId);
    expect(event.sender).toBe(carol);
    expect(Object.keys(event.signatures ?? {})).toEqual([ 'example.test' ]);
  });

  it('keeps one deployment identity working when no participant identity is registered', async () => {
    const { store, context } = matrixHarness({
      identities: matrixSigningIdentityRegistry({ identity: deploymentIdentity('example.test') }),
    });
    const alice = (await store.getAccount(context)).userId;
    // The harness WebID is alice.example, but nothing signs for that name, so the
    // deployment name is used exactly as before.
    expect(alice).toMatch(/:example\.test$/u);
    const room = await store.createRoom({}, context);
    expect(room.roomId).toMatch(/:example\.test$/u);
  });

  it('reports members with the server each of them belongs to', async () => {
    const registry = participantRegistry();
    const { store, context } = matrixHarness({ identities: registry });
    const bobContext = { ...context, webId: 'https://bob.example/profile/card#me' };
    const bob = (await store.getAccount(bobContext)).userId;
    const room = await store.createRoom({ invite: [ bob ] }, context);
    await store.joinRoom(room.roomId, bobContext);

    const members = await store.getMembers(room.roomId, context);
    const servers = members.map(event => event.state_key?.split(':').slice(1).join(':')).sort();
    expect(servers).toEqual([ 'alice.example', 'bob.example' ]);
  });
});
