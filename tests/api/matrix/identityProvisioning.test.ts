import { describe, expect, it, vi } from 'vitest';
import { messageResource } from '@undefineds.co/models';
import { fakePodCredentialDb, testSecretCellVault } from '../../helpers/podCredentialDb';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';
import {
  provisionMatrixSigningIdentity,
  provisionMatrixSigningIdentityWithDb,
  signingKeySecretContext,
} from '../../../src/api/matrix/identityProvisioning';
import { matrixSigningIdentityRegistry } from '../../../src/api/matrix/identityRegistry';
import { MatrixSigningIdentityProvider, SealedMatrixSigningKeyStore } from '../../../src/api/matrix/signingKeyStore';
import { createPodSigningKeyChannel, matrixSigningKeyStorageId } from '../../../src/api/matrix/signingKeyChannel';
import { decodeVerifyKey } from '../../../src/api/matrix/protocol/eventIntegrity';
import { getProtocolMetadata } from '../../../src/api/protocol-metadata';
import { readPersistedEvent, verifyPersistedEventSignature } from '../../../src/api/matrix/persistedEvent';

const ALICE_WEBID = 'https://alice.example/profile/card#me';
const ALICE_POD = 'https://alice.example/';

/** The provider a running deployment would keep after provisioning this identity. */
function providerFor(db: ReturnType<typeof fakePodCredentialDb>['db'], serverName: string) {
  return new MatrixSigningIdentityProvider({
    store: new SealedMatrixSigningKeyStore({
      vault: testSecretCellVault(),
      context: signingKeySecretContext(serverName, ALICE_WEBID),
      channel: createPodSigningKeyChannel({ db, serverName }),
    }),
    serverName,
    now: () => 1_000,
  });
}

describe('Matrix signing identity provisioning', () => {
  it('mints a sealed identity in the owner\'s Pod and reports what it made', async () => {
    const pod = fakePodCredentialDb();
    const result = await provisionMatrixSigningIdentityWithDb({
      db: pod.db, serverName: 'alice.example', ownerWebId: ALICE_WEBID, podUrl: ALICE_POD,
      vault: testSecretCellVault(), now: () => 1_000,
    });

    expect(result).toEqual({
      serverName: 'alice.example', keyId: 'ed25519:1', storageId: matrixSigningKeyStorageId('alice.example'), created: true,
    });
    const row = pod.rows.get(result.storageId)!;
    expect(row).toMatchObject({ service: 'matrix', status: 'active', storageMode: 'secret-cell-v1' });
    expect(String(row.secretPayload)).toContain('AES-256-GCM');
    expect(String(row.secretPayload)).not.toContain('PRIVATE KEY');
    expect(pod.writes).toEqual([ 'insert' ]);
  });

  it('reads an existing identity back instead of replacing it', async () => {
    const pod = fakePodCredentialDb();
    const first = await provisionMatrixSigningIdentityWithDb({
      db: pod.db, serverName: 'alice.example', ownerWebId: ALICE_WEBID, podUrl: ALICE_POD,
      vault: testSecretCellVault(), now: () => 1_000,
    });
    const sealed = String(pod.rows.get(first.storageId)!.secretPayload);

    const second = await provisionMatrixSigningIdentityWithDb({
      db: pod.db, serverName: 'alice.example', ownerWebId: ALICE_WEBID, podUrl: ALICE_POD,
      vault: testSecretCellVault(), now: () => 9_000,
    });
    expect(second).toEqual({ ...first, created: false });
    // Replacing the key set would orphan every signature this identity published.
    expect(String(pod.rows.get(first.storageId)!.secretPayload)).toBe(sealed);
    expect(pod.writes).toEqual([ 'insert' ]);
  });

  it('refuses to provision when it cannot reach the identity\'s Pod', async () => {
    const podAccess = { getPodFetch: vi.fn(async () => undefined) };
    await expect(provisionMatrixSigningIdentity({
      podAccess, serverName: 'alice.example', ownerWebId: ALICE_WEBID, podUrl: ALICE_POD,
      vault: testSecretCellVault(),
    })).rejects.toThrow(/No Pod access/u);
    expect(podAccess.getPodFetch).toHaveBeenCalledWith(ALICE_WEBID, undefined);
  });

  it('produces an identity a running registry can sign with', async () => {
    const pod = fakePodCredentialDb();
    const provisioned = await provisionMatrixSigningIdentityWithDb({
      db: pod.db, serverName: 'alice.example', ownerWebId: ALICE_WEBID, podUrl: ALICE_POD,
      vault: testSecretCellVault(), now: () => 1_000,
    });

    // The deployment attaches the provisioned identity and immediately names Alice
    // under her own server instead of the deployment's.
    const registry = matrixSigningIdentityRegistry();
    registry.register('alice.example', providerFor(pod.db, 'alice.example'));
    expect(registry.serverNames()).toEqual([ 'alice.example' ]);

    const harness = matrixHarness({ identities: registry });
    const alice = (await harness.store.getAccount(harness.context)).userId;
    expect(alice).toMatch(/:alice\.example$/u);
    const room = await harness.store.createRoom({}, harness.context);
    expect(room.roomId).toMatch(/:alice\.example$/u);

    const sent = await harness.store.sendEvent(room.roomId, 'm.room.message', 'first', { body: 'hi' }, harness.context);
    const row = harness.rows.get(messageResource as never)!
      .find((item: any) => (getProtocolMetadata(item.metadata, 'matrix')?.event as any)?.event_id === sent.eventId);
    const event = readPersistedEvent(getProtocolMetadata(row.metadata, 'matrix')!)!;
    expect(Object.keys(event.signatures ?? {})).toEqual([ 'alice.example' ]);

    const identity = await registry.identityFor('alice.example');
    const published = identity!.serverKeyResponse();
    expect(identity!.keyId).toBe(provisioned.keyId);
    expect(verifyPersistedEventSignature(event, 'alice.example', identity!.keyId,
      decodeVerifyKey(published.verify_keys[identity!.keyId].key))).toBe(true);
  });
});
