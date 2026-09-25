import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getTaskCredentialDatabase,
  resolveTaskCredentialDatabaseUrl,
  resetTaskCredentialDatabases,
} from '../../../src/api/tasks/TaskCredentialDatabase';
import {
  TASK_CREDENTIAL_ENCRYPTION_FAILED,
  TASK_CREDENTIAL_NOT_ACTIVE,
  TASK_CREDENTIAL_NOT_FOUND,
  TASK_CREDENTIAL_OWNER_MISMATCH,
  TASK_CREDENTIAL_VERSION_CONFLICT,
  TaskCredentialStore,
} from '../../../src/api/tasks/TaskCredentialStore';
import { DeploymentRootKeyProvider, SecretCellVault } from '../../../src/security/secret-cell';

const OWNER = 'https://pod.example/alice/profile/card#me';
const OTHER_OWNER = 'https://pod.example/bob/profile/card#me';
const ISSUER = 'https://pod.example/';
const CLIENT_ID = 'alice-client';
const CLIENT_SECRET = 'super-secret-value';

function vaultFor(keyId = 'k1'): SecretCellVault {
  return new SecretCellVault({
    rootKeys: new DeploymentRootKeyProvider({
      activeKeyId: keyId,
      keys: {
        k1: Buffer.alloc(32, 1),
        k2: Buffer.alloc(32, 2),
      },
    }),
  });
}

const temporaryDirectories: string[] = [];

async function storeAt(directory: string, options: { vault?: SecretCellVault; now?: () => Date } = {}) {
  const url = `sqlite:${path.join(directory, 'tasks.sqlite')}`;
  const database = getTaskCredentialDatabase(url);
  return {
    store: new TaskCredentialStore({
      database,
      vault: options.vault ?? vaultFor(),
      ...(options.now ? { now: options.now } : {}),
    }),
    raw: database.db,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'xpod-task-credential-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  resetTaskCredentialDatabases();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('resolveTaskCredentialDatabaseUrl', () => {
  it('puts the task layer in its own file next to a SQLite identity database', () => {
    expect(resolveTaskCredentialDatabaseUrl({ identityDatabaseUrl: 'sqlite:/var/lib/xpod/identity.sqlite' }))
      .toBe(`sqlite:${path.join('/var/lib/xpod', 'tasks.sqlite')}`);
  });

  it('prefers an explicit URL and refuses an empty identity URL', () => {
    expect(resolveTaskCredentialDatabaseUrl({
      identityDatabaseUrl: 'sqlite:/var/lib/xpod/identity.sqlite',
      configuredUrl: 'postgres://tasks.example/xpod',
    })).toBe('postgres://tasks.example/xpod');
    expect(() => resolveTaskCredentialDatabaseUrl({ identityDatabaseUrl: '  ' }))
      .toThrow('task_credential_database_unconfigured');
  });
});

describe('TaskCredentialStore', () => {
  it('stores the secret encrypted and never in the clear', async () => {
    const directory = await temporaryDirectory();
    const { store, raw } = await storeAt(directory);

    const summary = await store.grant({
      ownerWebId: OWNER,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    expect(summary).toMatchObject({ ownerWebId: OWNER, issuer: ISSUER, clientId: CLIENT_ID, version: 1, status: 'pending' });
    const rows = await raw.select().from((await import('../../../src/api/tasks/TaskCredentialSchema')).taskCredentialsSqlite);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].sealedSecret)).not.toContain(CLIENT_SECRET);
    expect(rows[0].sealedSecretKeyId).toBe('k1');
    expect(JSON.parse(String(rows[0].sealedSecret))).toMatchObject({ algorithm: 'AES-256-GCM' });
  });

  it('does not let a pending grant run, and activates it on request', async () => {
    const directory = await temporaryDirectory();
    const { store } = await storeAt(directory);
    const granted = await store.grant({
      ownerWebId: OWNER,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    await expect(store.lease({ credentialRef: granted.credentialRef, ownerWebId: OWNER }))
      .rejects.toThrow(`${TASK_CREDENTIAL_NOT_ACTIVE}:pending`);

    await store.activate(granted.credentialRef);
    await expect(store.lease({ credentialRef: granted.credentialRef, ownerWebId: OWNER }))
      .resolves.toMatchObject({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, version: 1 });
  });

  it('refuses another owner and an unknown reference', async () => {
    const directory = await temporaryDirectory();
    const { store } = await storeAt(directory);
    const granted = await store.grant({
      ownerWebId: OWNER,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      status: 'active',
    });

    await expect(store.lease({ credentialRef: granted.credentialRef, ownerWebId: OTHER_OWNER }))
      .rejects.toThrow(TASK_CREDENTIAL_OWNER_MISMATCH);
    await expect(store.lease({ credentialRef: 'taskcred_missing', ownerWebId: OWNER }))
      .rejects.toThrow(TASK_CREDENTIAL_NOT_FOUND);
  });

  it('bumps the version on rotation so a stale binding stops matching', async () => {
    const directory = await temporaryDirectory();
    const { store } = await storeAt(directory);
    const granted = await store.grant({
      ownerWebId: OWNER,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      status: 'active',
    });

    const rotated = await store.rotate(granted.credentialRef, {
      clientId: 'alice-client-2',
      clientSecret: 'rotated-secret',
      expectedVersion: 1,
    });

    expect(rotated).toMatchObject({ version: 2, clientId: 'alice-client-2' });
    await expect(store.lease({ credentialRef: granted.credentialRef, ownerWebId: OWNER, version: 1 }))
      .rejects.toThrow(`${TASK_CREDENTIAL_VERSION_CONFLICT}:2`);
    await expect(store.lease({ credentialRef: granted.credentialRef, ownerWebId: OWNER, version: 2 }))
      .resolves.toMatchObject({ clientSecret: 'rotated-secret' });
    await expect(store.rotate(granted.credentialRef, {
      clientId: 'x',
      clientSecret: 'y',
      expectedVersion: 1,
    })).rejects.toThrow(`${TASK_CREDENTIAL_VERSION_CONFLICT}:2`);
  });

  it('derives one stable reference per owner and issuer', async () => {
    const directory = await temporaryDirectory();
    const { store } = await storeAt(directory);

    const first = await store.grant({ ownerWebId: OWNER, issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const again = await store.grant({ ownerWebId: OWNER, issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const otherIssuer = await store.grant({
      ownerWebId: OWNER,
      issuer: 'https://other.example/',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    expect(again.credentialRef).toBe(first.credentialRef);
    expect(otherIssuer.credentialRef).not.toBe(first.credentialRef);
    expect(await store.listForOwner(OWNER)).toHaveLength(2);
  });

  it('treats a retried grant with the same reference and secret as idempotent', async () => {
    const directory = await temporaryDirectory();
    const { store } = await storeAt(directory);
    const first = await store.grant({
      ownerWebId: OWNER,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      credentialRef: 'taskcred_fixed',
    });

    const retry = await store.grant({
      ownerWebId: OWNER,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      credentialRef: 'taskcred_fixed',
      status: 'active',
    });

    expect(retry.version).toBe(first.version);
    expect(retry.status).toBe('active');
    expect((await store.listForOwner(OWNER))).toHaveLength(1);
  });

  it('refuses a reference that belongs to somebody else', async () => {
    const directory = await temporaryDirectory();
    const { store } = await storeAt(directory);
    await store.grant({
      ownerWebId: OWNER,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      credentialRef: 'taskcred_fixed',
    });

    await expect(store.grant({
      ownerWebId: OTHER_OWNER,
      issuer: ISSUER,
      clientId: 'bob-client',
      clientSecret: 'bob-secret',
      credentialRef: 'taskcred_fixed',
    })).rejects.toThrow(TASK_CREDENTIAL_OWNER_MISMATCH);
  });

  it('stops a revoked grant and keeps the row for audit', async () => {
    const directory = await temporaryDirectory();
    const { store } = await storeAt(directory);
    const granted = await store.grant({
      ownerWebId: OWNER,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      status: 'active',
    });

    await store.revoke(granted.credentialRef);

    await expect(store.lease({ credentialRef: granted.credentialRef, ownerWebId: OWNER }))
      .rejects.toThrow(`${TASK_CREDENTIAL_NOT_ACTIVE}:revoked`);
    expect(await store.listForOwner(OWNER)).toMatchObject([{ status: 'revoked' }]);
  });

  it('expires a grant by itself once its deadline passed', async () => {
    const directory = await temporaryDirectory();
    let now = new Date('2026-01-01T00:00:00Z');
    const { store } = await storeAt(directory, { now: () => now });
    const granted = await store.grant({
      ownerWebId: OWNER,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      status: 'active',
      expiresAt: new Date('2026-01-02T00:00:00Z'),
    });

    now = new Date('2026-01-03T00:00:00Z');
    await expect(store.lease({ credentialRef: granted.credentialRef, ownerWebId: OWNER }))
      .rejects.toThrow(`${TASK_CREDENTIAL_NOT_ACTIVE}:expired`);
    expect(await store.listForOwner(OWNER)).toMatchObject([{ status: 'expired' }]);
  });

  it('records usage only when the lease is actually taken', async () => {
    const directory = await temporaryDirectory();
    let now = new Date('2026-01-01T00:00:00Z');
    const { store } = await storeAt(directory, { now: () => now });
    const granted = await store.grant({
      ownerWebId: OWNER,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      status: 'active',
    });

    await store.lease({ credentialRef: granted.credentialRef, ownerWebId: OWNER, recordUsage: false });
    expect((await store.listForOwner(OWNER))[0]?.lastUsedAt).toBeUndefined();

    now = new Date('2026-01-01T01:00:00Z');
    await store.lease({ credentialRef: granted.credentialRef, ownerWebId: OWNER });
    expect((await store.listForOwner(OWNER))[0]?.lastUsedAt?.toISOString()).toBe('2026-01-01T01:00:00.000Z');
  });

  it('reports rows sealed with an older key so they can be rewrapped', async () => {
    const directory = await temporaryDirectory();
    const { store } = await storeAt(directory, { vault: vaultFor('k1') });
    const granted = await store.grant({
      ownerWebId: OWNER,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      status: 'active',
    });

    expect(await store.listNeedingRewrap('k1')).toEqual([]);
    expect(await store.listNeedingRewrap('k2')).toEqual([ granted.credentialRef ]);
    // A row sealed with k1 still opens after the deployment rotates to k2.
    const rotatedVault = await storeAt(directory, { vault: vaultFor('k2') });
    await expect(rotatedVault.store.lease({ credentialRef: granted.credentialRef, ownerWebId: OWNER }))
      .resolves.toMatchObject({ clientSecret: CLIENT_SECRET });
  });

  it('fails loudly when the ciphertext cannot be opened', async () => {
    const directory = await temporaryDirectory();
    const url = `sqlite:${path.join(directory, 'tasks.sqlite')}`;
    const { store } = await storeAt(directory);
    const granted = await store.grant({
      ownerWebId: OWNER,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      status: 'active',
    });

    // A deployment whose root key differs must not silently hand out a wrong credential.
    const foreignKeyStore = new TaskCredentialStore({
      database: getTaskCredentialDatabase(url),
      vault: new SecretCellVault({
        rootKeys: new DeploymentRootKeyProvider({
          activeKeyId: 'k1',
          keys: { k1: Buffer.alloc(32, 9) },
        }),
      }),
    });

    await expect(foreignKeyStore.lease({ credentialRef: granted.credentialRef, ownerWebId: OWNER }))
      .rejects.toThrow(TASK_CREDENTIAL_ENCRYPTION_FAILED);
  });
});
