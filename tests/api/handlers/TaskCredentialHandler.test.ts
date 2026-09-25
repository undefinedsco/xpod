import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTaskCredentialRoutes } from '../../../src/api/handlers/TaskCredentialHandler';
import {
  getTaskCredentialDatabase,
  resetTaskCredentialDatabases,
} from '../../../src/api/tasks/TaskCredentialDatabase';
import { TaskCredentialStore } from '../../../src/api/tasks/TaskCredentialStore';
import { DeploymentRootKeyProvider, SecretCellVault } from '../../../src/security/secret-cell';

const OWNER = 'https://pod.example/alice/profile/card#me';
const ISSUER = 'https://pod.example/';

const temporaryDirectories: string[] = [];

async function createStore(): Promise<TaskCredentialStore> {
  const directory = await mkdtemp(path.join(tmpdir(), 'xpod-task-credential-route-'));
  temporaryDirectories.push(directory);
  const database = getTaskCredentialDatabase(`sqlite:${path.join(directory, 'tasks.sqlite')}`);
  return new TaskCredentialStore({
    database,
    vault: new SecretCellVault({
      rootKeys: new DeploymentRootKeyProvider({ activeKeyId: 'k1', keys: { k1: Buffer.alloc(32, 3) } }),
    }),
  });
}

function createServer(store?: TaskCredentialStore) {
  const routes: Record<string, (request: any, response: any, params: any) => Promise<void>> = {};
  const server = {
    get: (routePath: string, handler: any) => { routes[`GET ${routePath}`] = handler; },
    post: (routePath: string, handler: any) => { routes[`POST ${routePath}`] = handler; },
    delete: (routePath: string, handler: any) => { routes[`DELETE ${routePath}`] = handler; },
  } as any;
  registerTaskCredentialRoutes(server, { ...(store ? { taskCredentials: store } : {}) });
  return routes;
}

function response() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) { this.headers[name] = value; },
    end(chunk: string) { this.body = chunk; },
  };
}

const request = (webId?: string) => ({ auth: webId ? { type: 'solid', webId } : undefined });

afterEach(async () => {
  resetTaskCredentialDatabases();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('TaskCredentialHandler', () => {
  it('lists grants as metadata only', async () => {
    const store = await createStore();
    const granted = await store.grant({
      ownerWebId: OWNER,
      issuer: ISSUER,
      clientId: 'alice-client',
      clientSecret: 'super-secret',
      status: 'active',
    });
    const res = response();

    await createServer(store)['GET /api/ai/task-credentials'](request(OWNER), res, {});

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<Record<string, unknown>> };
    expect(body.data).toEqual([
      expect.objectContaining({ credentialRef: granted.credentialRef, ownerWebId: OWNER, status: 'active' }),
    ]);
    expect(res.body).not.toContain('super-secret');
  });

  it('activates a pending grant and reports a revoked one as a conflict', async () => {
    const store = await createStore();
    const granted = await store.grant({ ownerWebId: OWNER, issuer: ISSUER, clientId: 'c', clientSecret: 's' });
    const routes = createServer(store);

    const activated = response();
    await routes['POST /api/ai/task-credentials/:credentialRef/activate'](
      request(OWNER),
      activated,
      { credentialRef: granted.credentialRef },
    );
    expect(activated.statusCode).toBe(200);
    expect(JSON.parse(activated.body).credential.status).toBe('active');

    await store.revoke(granted.credentialRef);
    const revoked = response();
    await routes['POST /api/ai/task-credentials/:credentialRef/activate'](
      request(OWNER),
      revoked,
      { credentialRef: granted.credentialRef },
    );
    expect(revoked.statusCode).toBe(409);
    expect(JSON.parse(revoked.body)).toEqual({ error: 'task_credential_not_active' });
  });

  it('never lets one owner see or change another owner\'s grant', async () => {
    const store = await createStore();
    const granted = await store.grant({
      ownerWebId: OWNER,
      issuer: ISSUER,
      clientId: 'c',
      clientSecret: 's',
      status: 'active',
    });
    const routes = createServer(store);
    const other = 'https://pod.example/bob/profile/card#me';

    const listed = response();
    await routes['GET /api/ai/task-credentials'](request(other), listed, {});
    expect(JSON.parse(listed.body)).toEqual({ data: [] });

    const revoked = response();
    await routes['DELETE /api/ai/task-credentials/:credentialRef'](
      request(other),
      revoked,
      { credentialRef: granted.credentialRef },
    );
    expect(revoked.statusCode).toBe(404);
    expect((await store.listForOwner(OWNER))[0]?.status).toBe('active');
  });

  it('requires an authenticated Solid owner and a configured store', async () => {
    const store = await createStore();
    const routes = createServer(store);

    const anonymous = response();
    await routes['GET /api/ai/task-credentials'](request(), anonymous, {});
    expect(anonymous.statusCode).toBe(401);

    const unconfigured = response();
    await createServer()['GET /api/ai/task-credentials'](request(OWNER), unconfigured, {});
    expect(unconfigured.statusCode).toBe(503);
    expect(JSON.parse(unconfigured.body)).toEqual({ error: 'task_credential_storage_unconfigured' });
  });

  it('revokes a grant without deleting its history', async () => {
    const store = await createStore();
    const granted = await store.grant({
      ownerWebId: OWNER,
      issuer: ISSUER,
      clientId: 'c',
      clientSecret: 's',
      status: 'active',
    });
    const res = response();

    await createServer(store)['DELETE /api/ai/task-credentials/:credentialRef'](
      request(OWNER),
      res,
      { credentialRef: granted.credentialRef },
    );

    expect(res.statusCode).toBe(200);
    expect(await store.listForOwner(OWNER)).toMatchObject([{ credentialRef: granted.credentialRef, status: 'revoked' }]);
  });

  it('turns an unexpected store failure into a generic error', async () => {
    const store = await createStore();
    const granted = await store.grant({
      ownerWebId: OWNER,
      issuer: ISSUER,
      clientId: 'c',
      clientSecret: 's',
      status: 'active',
    });
    vi.spyOn(store, 'revoke').mockRejectedValue(new Error('database is down'));
    const res = response();

    await createServer(store)['DELETE /api/ai/task-credentials/:credentialRef'](
      request(OWNER),
      res,
      { credentialRef: granted.credentialRef },
    );

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'task_credential_operation_failed' });
  });
});
