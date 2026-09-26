import { describe, expect, it, vi } from 'vitest';
import { credentialResource } from '@undefineds.co/models';
import {
  createPodSigningKeyChannel,
  createPodSigningKeyDb,
  matrixSigningKeyLocator,
  matrixSigningKeyStorageId,
  type MatrixSigningKeyChannelDb,
  type MatrixSigningKeyRow,
} from '../../../src/api/matrix/signingKeyChannel';
import { MatrixSigningIdentityProvider, SealedMatrixSigningKeyStore } from '../../../src/api/matrix/signingKeyStore';
import {
  DeploymentRootKeyProvider,
  parseDeploymentRootKeyConfig,
  SecretCellVault,
  type SecretCellContext,
} from '../../../src/security/secret-cell';
import { redactEvent, verifyJson, decodeVerifyKey } from '../../../src/api/matrix/protocol/eventIntegrity';

const ROOT_KEY = Buffer.alloc(32, 7).toString('base64');
const context: SecretCellContext = {
  ownerWebId: 'https://alice.example/profile#me',
  resourceIri: 'https://alice.example/settings/credentials.ttl',
  predicate: 'https://xpod.dev/ns#credentialSecret',
  field: 'matrixSigningKeySet',
  schemaVersion: 'v1',
  provider: 'matrix',
};

/** The credential document of one identity's Pod, as far as this channel is concerned. */
function fakePodDb() {
  const rows = new Map<string, MatrixSigningKeyRow & Record<string, unknown>>();
  const writes: string[] = [];
  const db: MatrixSigningKeyChannelDb = {
    async findById<T>(_resource: unknown, id: string) { return (rows.get(id) as T) ?? undefined; },
    insert() {
      return {
        values: (row: Record<string, unknown>) => ({
          execute: async () => {
            rows.set(String(row.id), row as MatrixSigningKeyRow & Record<string, unknown>);
            writes.push('insert');
          },
        }),
      };
    },
    async updateById(_resource: unknown, id: string, value: Record<string, unknown>) {
      rows.set(id, { ...(rows.get(id) ?? { id }), ...value } as MatrixSigningKeyRow & Record<string, unknown>);
      writes.push('update');
    },
  };
  return { db, rows, writes };
}

function vault(): SecretCellVault {
  return new SecretCellVault({
    rootKeys: new DeploymentRootKeyProvider({ activeKeyId: 'root-v1', keys: { 'root-v1': parseDeploymentRootKeyConfig(ROOT_KEY) } }),
  });
}

describe('Matrix signing key channel', () => {
  it('round-trips the payload through one credential row', async () => {
    const pod = fakePodDb();
    const channel = createPodSigningKeyChannel({ db: pod.db, serverName: 'alice.example', now: () => 1_000 });
    const id = matrixSigningKeyStorageId('alice.example');

    expect(await channel.read()).toBeUndefined();
    await channel.write('{"sealed":true}');
    expect(await channel.read()).toBe('{"sealed":true}');
    expect(pod.rows.get(id)).toMatchObject({ service: 'matrix', status: 'active', storageMode: 'secret-cell-v1' });
    expect(String(pod.rows.get(id)?.label)).toContain('alice.example');

    // A second write updates the same row instead of adding another one.
    await channel.write('{"sealed":"rotated"}');
    expect(await channel.read()).toBe('{"sealed":"rotated"}');
    expect(pod.writes).toEqual([ 'insert', 'update' ]);
  });

  it('keeps the identity locator stable and readable', () => {
    expect(matrixSigningKeyLocator('alice.example')).toBe('matrix-signing-alice.example');
    expect(matrixSigningKeyLocator('alice.example')).toBe(matrixSigningKeyLocator('alice.example'));
    expect(matrixSigningKeyStorageId('alice.example')).not.toBe(matrixSigningKeyStorageId('bob.example'));
    expect(() => matrixSigningKeyLocator('  ')).toThrow(/server name/u);
  });

  it('stores the sealed envelope, never the key', async () => {
    const pod = fakePodDb();
    const channel = createPodSigningKeyChannel({ db: pod.db, serverName: 'alice.example' });
    const store = new SealedMatrixSigningKeyStore({ vault: vault(), context, channel });
    const provider = new MatrixSigningIdentityProvider({ store, serverName: 'alice.example', now: () => 1_000 });
    const identity = await provider.identity();

    const row = pod.rows.get(matrixSigningKeyStorageId('alice.example'))!;
    expect(row.secretPayload).toContain('AES-256-GCM');
    expect(row.secretPayload).not.toContain('PRIVATE KEY');
    expect(row.encryptionAlgorithm).toBe('AES-256-GCM');
    // The descriptive key id comes from the envelope's wrapped data key.
    expect(JSON.parse(String(row.secretPayload)).wrappedDek.keyId).toBe('root-v1');

    const published = identity.serverKeyResponse();
    expect(verifyJson(published, 'alice.example', identity.keyId,
      decodeVerifyKey(published.verify_keys[identity.keyId].key))).toBe(true);
  });

  it('persists an identity across restarts and rotates it through the Pod', async () => {
    const pod = fakePodDb();
    const channel = createPodSigningKeyChannel({ db: pod.db, serverName: 'alice.example' });
    const store = new SealedMatrixSigningKeyStore({ vault: vault(), context, channel });
    const first = new MatrixSigningIdentityProvider({ store, serverName: 'alice.example', now: () => 1_000 });
    const before = await first.identity();
    const signed = before.signEvent({
      type: 'm.room.message', room_id: '!r:alice.example', sender: '@u_a:alice.example',
      origin_server_ts: 1_100, content: { msgtype: 'm.text', body: 'before' },
    });

    // A fresh process reads the same Pod row and signs with the same key.
    const restarted = new MatrixSigningIdentityProvider({ store, serverName: 'alice.example', now: () => 2_000 });
    expect((await restarted.identity()).keyId).toBe(before.keyId);
    const sealedBefore = String(pod.rows.get(matrixSigningKeyStorageId('alice.example'))!.secretPayload);

    // Rotation goes back through the same row, and the old key stays verifiable.
    await restarted.stageKey();
    await restarted.activateKey('ed25519:2');
    const afterRotate = await restarted.identity();
    expect(afterRotate.keyId).toBe('ed25519:2');
    const response = afterRotate.serverKeyResponse();
    expect(verifyJson(redactEvent(signed), 'alice.example', before.keyId,
      decodeVerifyKey(response.old_verify_keys![before.keyId].key))).toBe(true);
    const sealedAfter = String(pod.rows.get(matrixSigningKeyStorageId('alice.example'))!.secretPayload);
    expect(JSON.parse(sealedAfter).ciphertext).not.toBe(JSON.parse(sealedBefore).ciphertext);
  });

  it('fails loudly when the Pod row cannot be opened, and leaves it alone', async () => {
    const pod = fakePodDb();
    const channel = createPodSigningKeyChannel({ db: pod.db, serverName: 'alice.example' });
    const store = new SealedMatrixSigningKeyStore({ vault: vault(), context, channel });
    const provider = new MatrixSigningIdentityProvider({ store, serverName: 'alice.example', now: () => 1_000 });
    await provider.identity();
    const stored = pod.rows.get(matrixSigningKeyStorageId('alice.example'))!.secretPayload;

    // A different deployment root key cannot open this identity's keys.
    const foreignVault = new SecretCellVault({
      rootKeys: new DeploymentRootKeyProvider({
        activeKeyId: 'root-v2',
        keys: { 'root-v2': parseDeploymentRootKeyConfig(Buffer.alloc(32, 9).toString('base64')) },
      }),
    });
    const foreign = new MatrixSigningIdentityProvider({
      store: new SealedMatrixSigningKeyStore({ vault: foreignVault, context, channel }),
      serverName: 'alice.example', now: () => 2_000,
    });
    await expect(foreign.identity()).rejects.toThrow();
    // Nothing was overwritten: a silent replacement would orphan every signature.
    expect(pod.rows.get(matrixSigningKeyStorageId('alice.example'))!.secretPayload).toBe(stored);
  });

  it('refuses to build a Pod database without Pod access', async () => {
    const podAccess = { getPodFetch: vi.fn(async () => undefined) };
    await expect(createPodSigningKeyDb({
      podAccess, owner: 'https://alice.example/profile#me', podUrl: 'https://alice.example/',
    })).rejects.toThrow(/No Pod access/u);

    const withAccess = { getPodFetch: vi.fn(async () => (async () => new Response('{}')) as unknown as typeof fetch) };
    const db = await createPodSigningKeyDb({
      podAccess: withAccess, owner: 'https://alice.example/profile#me', podUrl: 'https://alice.example/',
    });
    expect(typeof db.findById).toBe('function');
    expect(typeof db.updateById).toBe('function');
    expect(credentialResource).toBeDefined();
  });
});
