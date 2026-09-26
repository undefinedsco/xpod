import { describe, expect, it } from 'vitest';
import {
  InMemoryMatrixSigningKeyStore,
  MatrixSigningIdentityProvider,
  SealedMatrixSigningKeyStore,
  type MatrixSigningKeyStore,
  type SealedSecretChannel,
} from '../../../src/api/matrix/signingKeyStore';
import {
  activateMatrixSigningKey,
  createMatrixSigningKeySet,
  publishableVerifyKeys,
  stageMatrixSigningKey,
} from '../../../src/api/matrix/protocol/signingKeys';
import { createMatrixServiceIdentityFromKeySet } from '../../../src/api/matrix/protocol/serviceIdentity';
import { decodeVerifyKey, redactEvent, verifyJson } from '../../../src/api/matrix/protocol/eventIntegrity';
import {
  DeploymentRootKeyProvider,
  SecretCellError,
  SecretCellVault,
  parseDeploymentRootKeyConfig,
  type SecretCellContext,
} from '../../../src/security/secret-cell';

const DAY = 24 * 60 * 60 * 1000;
/** A 32-byte deployment root key, base64: the only secret env keeps. */
const ROOT_KEY = Buffer.alloc(32, 1).toString('base64');

const context: SecretCellContext = {
  ownerWebId: 'https://alice.example/profile#me',
  resourceIri: 'https://alice.example/.data/credentials.ttl',
  predicate: 'https://xpod.dev/ns#credentialSecret',
  field: 'matrixSigningKeySet',
  schemaVersion: 'v1',
  provider: 'matrix',
};

function vault(): SecretCellVault {
  return new SecretCellVault({
    rootKeys: new DeploymentRootKeyProvider({
      activeKeyId: 'root-v1',
      keys: { 'root-v1': parseDeploymentRootKeyConfig(ROOT_KEY) },
    }),
  });
}

/** Stands in for the Pod resource the sealed payload travels through. */
function channel(initial?: string): SealedSecretChannel & { payload?: string } {
  return {
    payload: initial,
    async read() { return this.payload; },
    async write(payload: string) { this.payload = payload; },
  };
}

describe('Matrix signing identity custody', () => {
  it('seeds a key set on first use and reports the generated key', async () => {
    const store = new InMemoryMatrixSigningKeyStore();
    const generated: string[] = [];
    const provider = new MatrixSigningIdentityProvider({
      store, serverName: 'alice.example', now: () => 1_000, onGeneratedKey: keyId => generated.push(keyId),
    });

    const identity = await provider.identity();
    expect(identity.keyId).toBe('ed25519:1');
    expect(generated).toEqual([ 'ed25519:1' ]);
    // Seeding is persisted, so a second provider on the same store reuses it.
    const second = new MatrixSigningIdentityProvider({ store, serverName: 'alice.example', now: () => 2_000 });
    expect((await second.identity()).keyId).toBe('ed25519:1');
    expect(await store.read()).toMatchObject({ version: 1 });
  });

  it('answers from memory inside the refresh window and notices an external rotation after it', async () => {
    const store = new InMemoryMatrixSigningKeyStore();
    let reads = 0;
    const counting: MatrixSigningKeyStore = {
      async read() { reads += 1; return store.read(); },
      async write(keySet) { return store.write(keySet); },
    };
    let now = 1_000;
    const provider = new MatrixSigningIdentityProvider({
      store: counting, serverName: 'alice.example', now: () => now, refreshIntervalMs: 60_000,
    });

    const first = await provider.identity();
    await provider.identity();
    await provider.identity();
    // One read to seed, one to confirm on the second call, then nothing for a while.
    expect(reads).toBeLessThanOrEqual(2);
    expect(await provider.identity()).toBe(first);

    // Another instance rotates this identity while our cache is still warm.
    const rotated = activateMatrixSigningKey(
      stageMatrixSigningKey((await store.read())!, { now: 2_000 }), 'ed25519:2', { now: 3_000, retentionMs: DAY });
    await store.write(rotated);

    expect(await provider.identity()).toBe(first);
    now += 60_000;
    const refreshed = await provider.identity();
    expect(refreshed.keyId).toBe('ed25519:2');
    expect(refreshed).not.toBe(first);
  });

  it('rotates in two phases: the staged key is published before it signs', async () => {
    const store = new InMemoryMatrixSigningKeyStore();
    let now = 1_000;
    const provider = new MatrixSigningIdentityProvider({
      store, serverName: 'alice.example', now: () => now, retentionMs: 7 * DAY,
    });
    const before = await provider.identity();

    const staged = await provider.stageKey();
    expect(staged.keys.map(key => key.status)).toEqual([ 'active', 'pending' ]);
    // The staged key is already published, while the old key still signs.
    expect(Object.keys((await provider.identity()).serverKeyResponse().verify_keys).sort())
      .toEqual([ 'ed25519:1', 'ed25519:2' ]);
    expect((await provider.identity()).keyId).toBe(before.keyId);

    const activated = await provider.activateKey('ed25519:2');
    const after = await provider.identity();
    expect(after.keyId).toBe('ed25519:2');
    const response = after.serverKeyResponse();
    expect(Object.keys(response.verify_keys)).toEqual([ 'ed25519:2' ]);
    expect(response.old_verify_keys?.['ed25519:1'].expired_ts).toBe(now);
    expect(activated.version).toBe(staged.version + 1);

    // An event signed by the previous identity verifies against the published old key.
    const signed = before.signEvent({
      type: 'm.room.message', room_id: '!r:alice.example', sender: '@a:alice.example',
      origin_server_ts: 1_100, content: { msgtype: 'm.text', body: 'before' },
    });
    expect(verifyJson(redactEvent(signed), 'alice.example', 'ed25519:1',
      decodeVerifyKey(response.old_verify_keys!['ed25519:1'].key))).toBe(true);

    // Pruning before the window ends keeps the key publishable; after it, drops it.
    const kept = await provider.prune();
    expect(kept.version).toBe(activated.version);
    now += 7 * DAY + 1;
    const pruned = await provider.prune();
    expect(pruned.keys.map(key => key.keyId)).toEqual([ 'ed25519:2' ]);
    expect((await provider.identity()).serverKeyResponse().old_verify_keys).toBeUndefined();
  });

  it('stores only ciphertext and refuses a payload from another context or an unreadable one', async () => {
    const sealed = new SealedMatrixSigningKeyStore({ vault: vault(), context, channel: channel() });
    const keySet = createMatrixSigningKeySet({ now: 1_000 });
    await sealed.write(keySet);

    const payload = (sealed as unknown as { channel: SealedSecretChannel & { payload?: string } })['channel'].payload!;
    expect(payload).not.toContain('PRIVATE KEY');
    expect(payload).not.toContain(keySet.keys[0].privateKeyPem.slice(30, 60));
    expect(JSON.parse(payload)).toMatchObject({ algorithm: 'AES-256-GCM', aadPurpose: 'xpod.secret-cell.payload' });

    expect(await sealed.read()).toEqual(keySet);

    // A payload bound to a different identity's resource must not decrypt.
    const foreign = new SealedMatrixSigningKeyStore({
      vault: vault(), context: { ...context, resourceIri: 'https://bob.example/.data/credentials.ttl' },
      channel: channel(payload),
    });
    await expect(foreign.read()).rejects.toThrow(SecretCellError);

    const garbage = new SealedMatrixSigningKeyStore({ vault: vault(), context, channel: channel('not json') });
    await expect(garbage.read()).rejects.toThrow(/not a secret-cell envelope/u);
  });

  it('never generates a replacement when the stored key set cannot be read', async () => {
    const store = new InMemoryMatrixSigningKeyStore();
    const provider = new MatrixSigningIdentityProvider({ store, serverName: 'alice.example', now: () => 1_000 });
    await provider.identity();
    const sealedBefore = JSON.stringify(await store.read());

    const failing = new MatrixSigningIdentityProvider({
      store: {
        async read(): Promise<never> { throw new Error('Pod unavailable'); },
        async write(keySet) { return store.write(keySet); },
      },
      serverName: 'alice.example', now: () => 2_000,
    });
    // Silence would silently orphan every signature this identity ever made.
    await expect(failing.identity()).rejects.toThrow('Pod unavailable');
    expect(JSON.stringify(await store.read())).toBe(sealedBefore);
  });

  it('keeps the identity served to signers in step with the key set that is stored', async () => {
    const store = new InMemoryMatrixSigningKeyStore();
    const provider = new MatrixSigningIdentityProvider({ store, serverName: 'alice.example', now: () => 5_000 });
    await provider.stageKey();
    await provider.activateKey('ed25519:2');
    const stored = await store.read();
    const fromStored = createMatrixServiceIdentityFromKeySet(stored!, { serverName: 'alice.example', now: () => 5_000 });

    // Store and provider must agree on what is published, or a peer sees a key list
    // that does not match the signatures it receives.
    expect((await provider.identity()).serverKeyResponse()).toEqual(fromStored.serverKeyResponse());
    expect(publishableVerifyKeys(stored!, 5_000).old_verify_keys['ed25519:1'].expired_ts).toBe(5_000);
  });
});
