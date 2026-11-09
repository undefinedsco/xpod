import { describe, expect, it } from 'vitest';
import { PodMatrixStore } from '../../../src/api/matrix/PodMatrixStore';
import { InMemoryMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';
import { InMemoryMatrixRoomDirectory } from '../../../src/api/matrix/MatrixRoomDirectory';
import { matrixUserIdForWebId } from '../../../src/api/matrix/MatrixIdentity';
import { messageResource } from '@undefineds.co/models';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';

const alice = 'https://id.example/people/alice#me';
const bob = 'https://id.other.example/people/bob#me';
const alicePod = 'https://pods.example/alice/';
const bobPod = 'https://pods.other.example/bob/';

function storeWithPort() {
  return new PodMatrixStore({
    serverName: 'localhost:3000',
    journal: new InMemoryMatrixEventJournal(),
    directory: new InMemoryMatrixRoomDirectory(async root => root === alicePod || root === bobPod),
    verifyStorage: async root => root === alicePod || root === bobPod,
    podAccess: { getPodFetch: async () => (async () => new Response()) as typeof fetch },
  });
}

/**
 * Port-bearing (and same-host / different-host) identities must work through
 * real createRoom/invite/whoami flows, not only the hash helper. There is no
 * requirement that identity issuer host and Pod host, or Alice's and Bob's
 * hosts, match.
 */
describe('Matrix port-bearing server authority end-to-end', () => {
  it('creates, invites, and reports whoami on localhost:3000', async () => {
    const { db, rows } = matrixHarness();
    const store = storeWithPort();
    const aliceContext = {
      webId: alice, podUrl: alicePod,
      auth: { type: 'solid' as const, webId: alice, clientId: 'alice-port' },
      _matrixDb: db,
    } as any;
    const bobContext = {
      webId: bob, podUrl: bobPod,
      auth: { type: 'solid' as const, webId: bob, clientId: 'bob-port' },
    } as any;
    const aliceId = (await store.getAccount({ ...aliceContext, _matrixDb: undefined })).userId;
    const bobId = (await store.getAccount({ ...bobContext, _matrixDb: undefined })).userId;
    expect(aliceId.endsWith(':localhost:3000')).toBe(true);
    expect(bobId.endsWith(':localhost:3000')).toBe(true);
    expect(aliceId).not.toBe(bobId);
    expect(aliceId).toBe(matrixUserIdForWebId(alice, 'localhost:3000'));

    const room = await store.createRoom({ name: 'Port room' }, aliceContext);
    await store.inviteUser(room.roomId, bobId, aliceContext, bob);
    // Real membership event written to the room Pod: the invited MXID is
    // Bob's canonical mapping and the sender is Alice's canonical MXID.
    const membership = (rows.get(messageResource) ?? []).find(row =>
      row.metadata?.protocols?.matrix?.stateKey === bobId);
    expect(membership?.metadata?.protocols?.matrix?.content?.membership).toBe('invite');
    expect(membership?.metadata?.protocols?.matrix?.sender).toBe(aliceId);
  });

  it('accepts an IPv6 authority and does not require matching identity/Pod hosts', async () => {
    const { db } = matrixHarness();
    const store = new PodMatrixStore({
      serverName: '[::1]:3000',
      journal: new InMemoryMatrixEventJournal(),
      directory: new InMemoryMatrixRoomDirectory(async root => root === alicePod || root === bobPod),
      verifyStorage: async root => root === alicePod || root === bobPod,
      podAccess: { getPodFetch: async () => (async () => new Response()) as typeof fetch },
    });
    const aliceContext = {
      webId: alice, podUrl: alicePod,
      auth: { type: 'solid' as const, webId: alice, clientId: 'alice-ipv6' },
      _matrixDb: db,
    } as any;
    const account = await store.getAccount({ ...aliceContext, _matrixDb: undefined });
    expect(account.userId).toBe(matrixUserIdForWebId(alice, '[::1]:3000'));
    expect(account.userId).toMatch(/^@u_[0-9a-f]{64}:\[::1\]:3000$/u);
    const room = await store.createRoom({ name: 'IPv6 room' }, aliceContext);
    expect(room.roomId).toMatch(/\[::1\]:3000$/u);
    // Different identity host and different Pod host than the service authority.
    expect(new URL(alice).host).toBe('id.example');
    expect(new URL(alicePod).host).toBe('pods.example');
  });
});
