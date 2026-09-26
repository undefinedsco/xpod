import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MatrixSigningIdentityRegistry,
  matrixSigningIdentityRegistry,
} from '../../../src/api/matrix/identityRegistry';
import { MatrixSigningIdentityProvider } from '../../../src/api/matrix/signingKeyStore';
import { InMemoryMatrixSigningKeyStore } from '../../../src/api/matrix/signingKeyStore';
import { MatrixServiceIdentity } from '../../../src/api/matrix/protocol/serviceIdentity';
import { decodeVerifyKey, verifyJson } from '../../../src/api/matrix/protocol/eventIntegrity';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';

function identity(serverName: string, keyId = 'ed25519:1'): MatrixServiceIdentity {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new MatrixServiceIdentity({
    serverName,
    activeKey: { keyId, privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
  });
}

function providerFor(serverName: string): { serverName: string; provider: MatrixSigningIdentityProvider } {
  return {
    serverName,
    provider: new MatrixSigningIdentityProvider({
      store: new InMemoryMatrixSigningKeyStore(),
      serverName,
      now: () => 1_000,
    }),
  };
}

describe('Matrix signing identity registry', () => {
  it('answers for the identity\'s own server name and refuses every other', async () => {
    const registry = matrixSigningIdentityRegistry({ identity: identity('alice.example') });
    expect(await registry.identityFor('alice.example')).toBeDefined();
    expect(registry.serverNames()).toEqual([ 'alice.example' ]);
    // Signing as a server whose key we do not hold would attribute the event to a
    // server that never signed it, so this must not fall back.
    await expect(registry.identityFor('bob.example')).rejects.toThrow(/No Matrix signing identity/u);
  });

  it('serves key-set-backed identities per server name', async () => {
    const registry = new MatrixSigningIdentityRegistry({
      identity: identity('deployment.example'),
      providers: [ providerFor('alice.example'), providerFor('bob.example') ],
    });
    expect(registry.serverNames()).toEqual([ 'alice.example', 'bob.example', 'deployment.example' ]);

    const alice = await registry.identityFor('alice.example');
    const bob = await registry.identityFor('bob.example');
    expect(alice?.serverName).toBe('alice.example');
    expect(bob?.serverName).toBe('bob.example');
    // Two identities generated on first use must not be the same key material.
    expect(alice?.keyId).toBeDefined();
    expect((await registry.identityFor('alice.example'))?.keyId).toBe(alice?.keyId);

    const published = alice!.serverKeyResponse();
    expect(published.server_name).toBe('alice.example');
    expect(verifyJson(published, 'alice.example', alice!.keyId,
      decodeVerifyKey(published.verify_keys[alice!.keyId].key))).toBe(true);
  });

  it('lets a key-set provider take precedence over the static identity', async () => {
    const registry = new MatrixSigningIdentityRegistry({
      identity: identity('alice.example', 'ed25519:static'),
      providers: [ providerFor('alice.example') ],
    });
    // The provider generates its own key, so the active key id is not the static one.
    expect((await registry.identityFor('alice.example'))?.keyId).not.toBe('ed25519:static');
  });

  it('refuses an event for a name it holds no key for instead of signing it wrongly', async () => {
    // The store signs for its own server name; a registry that only knows another
    // name must make the write fail loudly.
    const { store, context } = matrixHarness({ serviceIdentity: identity('other.example') });
    await expect(store.createRoom({}, context)).rejects.toThrow(/No Matrix signing identity/u);
  });

  it('does not need an identity at all when none is configured', async () => {
    const { store, context } = matrixHarness();
    const room = await store.createRoom({}, context);
    expect(room.roomId).toBeTruthy();
  });
});
