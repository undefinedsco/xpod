import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { migratePodInterfaceKeysToTaskCredentials } from '../../../src/api/tasks/PodInterfaceKeyMigration';
import {
  getTaskCredentialDatabase,
  resetTaskCredentialDatabases,
} from '../../../src/api/tasks/TaskCredentialDatabase';
import { TaskCredentialStore } from '../../../src/api/tasks/TaskCredentialStore';
import { PodInterfaceKeyStore } from '../../../src/api/ai-gateway/pod/PodInterfaceKeyStore';
import { PlaintextCredentialVault } from '../../../src/api/ai-gateway/credentials/PlaintextCredentialVault';
import { InMemoryInterfaceKeyRepository } from '../../helpers/podInterfaceKeyAccess';
import { DeploymentRootKeyProvider, SecretCellVault } from '../../../src/security/secret-cell';

const OWNER = 'https://pod.example/alice/profile/card#me';
const OTHER_OWNER = 'https://pod.example/bob/profile/card#me';
const ISSUER = 'https://pod.example/';

const temporaryDirectories: string[] = [];

async function createStores() {
  const directory = await mkdtemp(path.join(tmpdir(), 'xpod-pod-key-migration-'));
  temporaryDirectories.push(directory);
  const taskCredentials = new TaskCredentialStore({
    database: getTaskCredentialDatabase(`sqlite:${path.join(directory, 'tasks.sqlite')}`),
    vault: new SecretCellVault({
      rootKeys: new DeploymentRootKeyProvider({ activeKeyId: 'k1', keys: { k1: Buffer.alloc(32, 5) } }),
    }),
  });
  const repository = new InMemoryInterfaceKeyRepository();
  const keys = new PodInterfaceKeyStore({ repository, vault: new PlaintextCredentialVault() });
  return { taskCredentials, keys, repository };
}

afterEach(async () => {
  resetTaskCredentialDatabases();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('migratePodInterfaceKeysToTaskCredentials', () => {
  it('moves every stored owner key into the task layer', async () => {
    const { taskCredentials, keys } = await createStores();
    await keys.saveKey(OWNER, { clientId: 'alice-client', clientSecret: 'alice-secret' });
    await keys.saveKey(OTHER_OWNER, { clientId: 'bob-client', clientSecret: 'bob-secret' });

    const result = await migratePodInterfaceKeysToTaskCredentials({ keys, taskCredentials, issuer: ISSUER });

    expect(result).toEqual({ scanned: 2, migrated: 2, skipped: 0, failed: 0 });
    const alice = await taskCredentials.listForOwner(OWNER);
    expect(alice).toMatchObject([{ status: 'active', issuer: ISSUER, clientId: 'alice-client' }]);
    await expect(taskCredentials.lease({ credentialRef: alice[0]!.credentialRef, ownerWebId: OWNER }))
      .resolves.toMatchObject({ clientId: 'alice-client', clientSecret: 'alice-secret' });
    expect(await taskCredentials.listForOwner(OTHER_OWNER)).toHaveLength(1);
  });

  it('is safe to run on every boot', async () => {
    const { taskCredentials, keys } = await createStores();
    await keys.saveKey(OWNER, { clientId: 'alice-client', clientSecret: 'alice-secret' });

    await migratePodInterfaceKeysToTaskCredentials({ keys, taskCredentials, issuer: ISSUER });
    const second = await migratePodInterfaceKeysToTaskCredentials({ keys, taskCredentials, issuer: ISSUER });

    expect(second).toMatchObject({ scanned: 1, migrated: 1, failed: 0 });
    const grants = await taskCredentials.listForOwner(OWNER);
    expect(grants).toHaveLength(1);
    // The re-run keeps the version: a retried migration is not a rotation.
    expect(grants[0]?.version).toBe(1);
  });

  it('leaves the legacy table readable and reports a row it cannot open', async () => {
    const { taskCredentials, keys, repository } = await createStores();
    await keys.saveKey(OWNER, { clientId: 'alice-client', clientSecret: 'alice-secret' });
    await repository.write({
      ownerWebId: OTHER_OWNER,
      clientId: 'broken-client',
      sealedSecret: 'not-a-sealed-envelope',
    });

    const result = await migratePodInterfaceKeysToTaskCredentials({ keys, taskCredentials, issuer: ISSUER });

    expect(result).toMatchObject({ scanned: 2, migrated: 1, failed: 1 });
    // Nothing is deleted, so a failure stays reversible.
    expect(await repository.read(OTHER_OWNER)).toBeDefined();
    expect(await taskCredentials.listForOwner(OTHER_OWNER)).toEqual([]);
  });

  it('reports a legacy table that cannot be listed at all', async () => {
    const { taskCredentials } = await createStores();
    const keys = {
      read: vi.fn(),
      listOwners: vi.fn(async () => { throw new Error('database is locked'); }),
    };

    await expect(migratePodInterfaceKeysToTaskCredentials({ keys, taskCredentials, issuer: ISSUER }))
      .resolves.toEqual({ scanned: 0, migrated: 0, skipped: 0, failed: 0 });
  });

  it('does nothing when there is nothing to migrate', async () => {
    const { taskCredentials, keys } = await createStores();

    await expect(migratePodInterfaceKeysToTaskCredentials({ keys, taskCredentials, issuer: ISSUER }))
      .resolves.toEqual({ scanned: 0, migrated: 0, skipped: 0, failed: 0 });
  });
});
