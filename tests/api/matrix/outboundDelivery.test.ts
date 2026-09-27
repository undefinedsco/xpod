import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';
import { matrixSigningIdentityRegistry } from '../../../src/api/matrix/identityRegistry';
import { InMemoryMatrixSigningKeyStore, MatrixSigningIdentityProvider } from '../../../src/api/matrix/signingKeyStore';
import { MatrixServiceIdentity } from '../../../src/api/matrix/protocol/serviceIdentity';
import { computeEventId } from '../../../src/api/matrix/protocol/eventIntegrity';
import type { MatrixFederationOutbox } from '../../../src/api/matrix/PodMatrixStore';

function identity(serverName: string): MatrixServiceIdentity {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new MatrixServiceIdentity({
    serverName,
    activeKey: { keyId: 'ed25519:1', privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
    now: () => 1_000,
  });
}

function provider(serverName: string) {
  return { serverName, provider: new MatrixSigningIdentityProvider({ store: new InMemoryMatrixSigningKeyStore(), serverName, now: () => 1_000 }) };
}

/** Alice and Bob are each their own server; both identities are held by this deployment. */
function registry() {
  return matrixSigningIdentityRegistry({
    identity: identity('pod.example'),
    providers: [ provider('alice.example'), provider('bob.example') ],
  });
}

interface Enqueued {
  scope: string;
  origin: string;
  destination: string;
  pdus: readonly unknown[];
}

function outbox() {
  const enqueued: Enqueued[] = [];
  const port: MatrixFederationOutbox = {
    enqueue: vi.fn(async (input: Enqueued) => { enqueued.push(input); }),
  };
  return { port, enqueued };
}

const ALICE_CONTEXT_WEBID = 'https://alice.example/profile/card#me';
const BOB_CONTEXT_WEBID = 'https://bob.example/profile/card#me';

async function twoServerRoom() {
  const { port, enqueued } = outbox();
  const { store, context, rows } = matrixHarness({ identities: registry(), outbound: port });
  const bobContext = { ...context, webId: BOB_CONTEXT_WEBID };
  const bob = (await store.getAccount(bobContext)).userId;
  const room = await store.createRoom({ invite: [ bob ] }, context);
  await store.joinRoom(room.roomId, bobContext);
  return { store, context, bobContext, room, enqueued, rows };
}

describe('handing written events to the other servers in the room', () => {
  it('queues a message for the other member\'s server, as the sender\'s own server', async () => {
    const { store, context, room, enqueued } = await twoServerRoom();
    enqueued.length = 0;

    const sent = await store.sendEvent(room.roomId, 'm.room.message', 'txn-1', { body: 'hi' }, context);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ origin: 'alice.example', destination: 'bob.example', scope: 'https://pod.example/alice/' });
    expect(enqueued[0].pdus).toHaveLength(1);

    // What goes on the wire is the persisted protocol event: verifiable material and the
    // id derived from it, not the Solid row that references it.
    const pdu = enqueued[0].pdus[0] as Record<string, unknown>;
    expect(pdu.event_id).toBe(sent.eventId);
    expect(computeEventId(pdu)).toBe(pdu.event_id);
    expect(pdu).toMatchObject({ type: 'm.room.message', room_id: room.roomId, sender: sent.sender, content: { body: 'hi' } });
    expect(Object.keys(pdu.signatures as Record<string, unknown>)).toEqual([ 'alice.example' ]);
    expect(typeof (pdu.hashes as Record<string, unknown>).sha256).toBe('string');
  });

  it('reaches the server of the member an invite is about', async () => {
    const { port, enqueued } = outbox();
    const { store, context } = matrixHarness({ identities: registry(), outbound: port });
    const bobContext = { ...context, webId: BOB_CONTEXT_WEBID };
    const bob = (await store.getAccount(bobContext)).userId;

    const room = await store.createRoom({ invite: [ bob ] }, context);
    // The create event has nobody to tell; the invite has to reach bob.example even though
    // Bob has not joined.
    expect(enqueued.map(entry => [ entry.origin, entry.destination ])).toEqual([ [ 'alice.example', 'bob.example' ] ]);
    expect(enqueued[0].pdus[0]).toMatchObject({ type: 'm.room.member', state_key: bob, content: { membership: 'invite' } });
    expect(room.roomId).toMatch(/^!/u);
  });

  it('sends nothing when every member is on this server', async () => {
    const { port, enqueued } = outbox();
    // No participant identities: everybody is on the deployment's own name, so the room
    // has no other server to talk to.
    const { store, context } = matrixHarness({ outbound: port });
    const room = await store.createRoom({}, context);
    await store.joinRoom(room.roomId, context);
    await store.sendEvent(room.roomId, 'm.room.message', 'txn-1', { body: 'hi' }, context);
    expect(enqueued).toEqual([]);
  });

  it('queues for each server in the room once', async () => {
    const { port, enqueued } = outbox();
    const { store, context } = matrixHarness({ identities: registry(), outbound: port });
    const bobContext = { ...context, webId: BOB_CONTEXT_WEBID };
    const bob = (await store.getAccount(bobContext)).userId;
    const room = await store.createRoom({ invite: [ bob ] }, context);
    await store.joinRoom(room.roomId, bobContext);

    await store.inviteUser(room.roomId, '@u_carol:carol.example', context);
    enqueued.length = 0;
    await store.sendEvent(room.roomId, 'm.room.message', 'txn-2', { body: 'hello all' }, context);
    // Bob is joined; Carol was only invited, so she does not make carol.example a
    // participating server yet.
    expect(enqueued.map(entry => entry.destination)).toEqual([ 'bob.example' ]);
  });

  it('does not relay an event received from another server', async () => {
    const { port, enqueued } = outbox();
    const { store, context } = matrixHarness({ identities: registry(), outbound: port });
    const room = await store.createRoom({}, context);
    enqueued.length = 0;

    // Relaying is a separate decision (see the register); for now a received event is
    // stored, not forwarded.
    await store.acceptReceivedEvent({
      event: { type: 'm.room.message', room_id: room.roomId, sender: '@u_bob:bob.example', origin_server_ts: 1, content: { body: 'remote' } },
      context,
    });
    expect(enqueued).toEqual([]);
  });

  it('leaves writes alone when no queue is configured', async () => {
    const { store, context } = matrixHarness({ identities: registry() });
    const room = await store.createRoom({}, context);
    await expect(store.sendEvent(room.roomId, 'm.room.message', 'txn-1', { body: 'hi' }, context)).resolves.toBeDefined();
  });
});
