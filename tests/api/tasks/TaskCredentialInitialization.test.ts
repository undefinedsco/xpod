import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The schema initializer is the seam under test: instrument the real module so the
// factory and the Store both go through the same spy. `vi.hoisted` keeps the spy
// available to the hoisted `vi.mock` factory.
const schemaMocks = vi.hoisted(() => ({
  ensureTaskCredentialTables: vi.fn<[any], Promise<void>>(),
}));

vi.mock('../../../src/api/tasks/TaskCredentialSchema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/api/tasks/TaskCredentialSchema')>();
  return {
    ...actual,
    ensureTaskCredentialTables: schemaMocks.ensureTaskCredentialTables,
  };
});

import {
  getTaskCredentialDatabase,
  resetTaskCredentialDatabases,
} from '../../../src/api/tasks/TaskCredentialDatabase';
import { taskCredentialSchema } from '../../../src/api/tasks/TaskCredentialSchema';
import { TaskCredentialStore } from '../../../src/api/tasks/TaskCredentialStore';
import { DeploymentRootKeyProvider, SecretCellVault } from '../../../src/security/secret-cell';

const OWNER = 'https://pod.example/alice/profile/card#me';

function vaultFor(): SecretCellVault {
  return new SecretCellVault({
    rootKeys: new DeploymentRootKeyProvider({
      activeKeyId: 'k1',
      keys: { k1: Buffer.alloc(32, 1) },
    }),
  });
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'xpod-task-credential-init-'));
  temporaryDirectories.push(directory);
  return directory;
}

beforeEach(() => {
  schemaMocks.ensureTaskCredentialTables.mockReset();
  schemaMocks.ensureTaskCredentialTables.mockResolvedValue(undefined);
});

afterEach(async () => {
  resetTaskCredentialDatabases();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('task credential schema initialization ownership', () => {
  it('never initializes from the factory: the Store is the only initialization path', async () => {
    const url = `sqlite:${path.join(await temporaryDirectory(), 'tasks.sqlite')}`;

    const database = getTaskCredentialDatabase(url);
    // The factory only opens and caches a handle; it must not race a DDL ensure.
    expect(schemaMocks.ensureTaskCredentialTables).not.toHaveBeenCalled();

    new TaskCredentialStore({ database, vault: vaultFor() });
    // Exactly one initialization for one handle, owned by the Store and awaited by it.
    expect(schemaMocks.ensureTaskCredentialTables).toHaveBeenCalledTimes(1);
    expect(schemaMocks.ensureTaskCredentialTables).toHaveBeenCalledWith(database.db);
  });

  it('makes the first Store operation wait for that single initialization', async () => {
    let release: (() => void) | undefined;
    const initialization = new Promise<void>((resolve) => { release = resolve; });
    schemaMocks.ensureTaskCredentialTables.mockReturnValueOnce(initialization);

    const db = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    };
    const store = new TaskCredentialStore({
      database: { db, schema: taskCredentialSchema.sqlite },
      vault: vaultFor(),
    });

    let settled = false;
    const operation = store.listForOwner(OWNER).then((rows) => {
      settled = true;
      return rows;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    release?.();
    await expect(operation).resolves.toEqual([]);
    expect(settled).toBe(true);
  });

  it('surfaces an initialization failure at the first real Store operation', async () => {
    schemaMocks.ensureTaskCredentialTables.mockRejectedValueOnce(new Error('task_credential_ddl_failed'));

    const store = new TaskCredentialStore({
      database: { db: {}, schema: taskCredentialSchema.sqlite },
      vault: vaultFor(),
    });

    await expect(store.listForOwner(OWNER)).rejects.toThrow('task_credential_ddl_failed');
  });
});
