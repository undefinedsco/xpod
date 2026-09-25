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

function createServer(
  store?: TaskCredentialStore,
  verification?: {
    validateClientCredential?: (apiKey: string) => Promise<any>;
    clientCredentialIssuer?: string;
  },
) {
  const routes: Record<string, (request: any, response: any, params: any) => Promise<void>> = {};
  const server = {
    get: (routePath: string, handler: any) => { routes[`GET ${routePath}`] = handler; },
    post: (routePath: string, handler: any) => { routes[`POST ${routePath}`] = handler; },
    delete: (routePath: string, handler: any) => { routes[`DELETE ${routePath}`] = handler; },
  } as any;
  registerTaskCredentialRoutes(server, {
    ...(store ? { taskCredentials: store } : {}),
    ...(verification?.validateClientCredential ? { validateClientCredential: verification.validateClientCredential } : {}),
    ...(verification?.clientCredentialIssuer ? { clientCredentialIssuer: verification.clientCredentialIssuer } : {}),
  });
  return routes;
}

function bodyRequest(webId: string | undefined, body: unknown) {
  return {
    auth: webId ? { type: 'solid', webId } : undefined,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  };
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

describe('POST /api/ai/task-credentials', () => {
  const SK = `sk-${Buffer.from('alice-client:alice-secret').toString('base64')}`;

  function verifiedContext() {
    return {
      success: true,
      context: { type: 'solid', webId: OWNER, clientId: 'alice-client', clientSecret: 'alice-secret' },
    };
  }

  it('creates an active grant from the user\'s own credential', async () => {
    const store = await createStore();
    const routes = createServer(store, {
      validateClientCredential: async () => verifiedContext(),
      clientCredentialIssuer: ISSUER,
    });
    const res = response();

    await routes['POST /api/ai/task-credentials'](
      bodyRequest(OWNER, { apiKey: SK, name: 'background indexing' }),
      res,
      {},
    );

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { credential: { credentialRef: string; status: string } };
    expect(body.credential.status).toBe('active');
    expect(res.body).not.toContain('alice-secret');
    // The grant is usable right away, which is what the settings page promises.
    await expect(store.lease({ credentialRef: body.credential.credentialRef, ownerWebId: OWNER }))
      .resolves.toMatchObject({ clientId: 'alice-client', clientSecret: 'alice-secret' });
  });

  it('refuses a wrapper that is missing, malformed or belongs to somebody else', async () => {
    const store = await createStore();
    const routes = createServer(store, {
      validateClientCredential: async () => verifiedContext(),
      clientCredentialIssuer: ISSUER,
    });

    const missing = response();
    await routes['POST /api/ai/task-credentials'](bodyRequest(OWNER, {}), missing, {});
    expect(missing.statusCode).toBe(400);

    const malformed = response();
    await routes['POST /api/ai/task-credentials'](bodyRequest(OWNER, { apiKey: 'xpod_gw_not_a_wrapper' }), malformed, {});
    expect(malformed.statusCode).toBe(400);

    const otherOwner = response();
    await routes['POST /api/ai/task-credentials'](
      bodyRequest(OWNER, { apiKey: SK }),
      otherOwner,
      {},
    );
    expect(otherOwner.statusCode).toBe(201);
    expect(await store.listForOwner(OWNER)).toHaveLength(1);
  });

  it('refuses a credential issued to another WebID and an unverifiable one', async () => {
    const store = await createStore();
    const routes = createServer(store, {
      validateClientCredential: async () => ({
        success: true,
        context: { type: 'solid', webId: 'https://pod.example/bob/profile/card#me', clientId: 'b', clientSecret: 's' },
      }),
      clientCredentialIssuer: ISSUER,
    });
    const foreign = response();
    await routes['POST /api/ai/task-credentials'](bodyRequest(OWNER, { apiKey: SK }), foreign, {});
    expect(foreign.statusCode).toBe(403);

    const refusing = createServer(store, {
      validateClientCredential: async () => ({ success: false, category: 'invalid_credentials' }),
      clientCredentialIssuer: ISSUER,
    });
    const invalid = response();
    await refusing['POST /api/ai/task-credentials'](bodyRequest(OWNER, { apiKey: SK }), invalid, {});
    expect(invalid.statusCode).toBe(401);
  });

  it('reports the grant surface as unavailable when the deployment cannot verify or store', async () => {
    const store = await createStore();
    const withoutVerifier = response();
    await createServer(store)['POST /api/ai/task-credentials'](bodyRequest(OWNER, { apiKey: SK }), withoutVerifier, {});
    expect(withoutVerifier.statusCode).toBe(503);
    expect(JSON.parse(withoutVerifier.body)).toEqual({ error: 'task_credential_grant_unavailable' });

    const withoutStore = response();
    await createServer(undefined, {
      validateClientCredential: async () => verifiedContext(),
      clientCredentialIssuer: ISSUER,
    })['POST /api/ai/task-credentials'](bodyRequest(OWNER, { apiKey: SK }), withoutStore, {});
    expect(withoutStore.statusCode).toBe(503);
    expect(JSON.parse(withoutStore.body)).toEqual({ error: 'task_credential_storage_unconfigured' });
  });
});
