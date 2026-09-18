import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppRunner, type App } from '@solid/community-server';
import { expect, it } from 'vitest';
import { getFreePort } from '../../src/runtime/port-finder';
import { DrizzleIndexedStorage } from '../../src/identity/drizzle/DrizzleIndexedStorage';
import { closeAllIdentityConnections } from '../../src/identity/drizzle/db';

// Real CSS HTTP and the exact Cloud AccountStorage declaration, with SQLite.
// This isolates the Cloud account boundary; it does not claim PostgreSQL or
// complete Cloud topology / remote SP provisioning coverage.
it('protects the last password through HTTP while permitting passwordless Pod accounts', async () => {
  await mkdir(path.resolve('.test-data'), { recursive: true });
  const root = await mkdtemp(path.resolve('.test-data/login-method-guard-http-'));
  const port = await getFreePort(30_000 + Math.floor(Math.random() * 20_000), '127.0.0.1');
  const origin = `http://localhost:${port}`;
  const database = `sqlite:${path.join(root, 'identity.sqlite')}`;
  const cloud = JSON.parse(await readFile(path.resolve('config/cloud.json'), 'utf8'));
  const accountOverride = cloud['@graph'].find((entry: { overrideInstance?: { '@id'?: string } }) =>
    entry.overrideInstance?.['@id'] === 'urn:solid-server:default:AccountStorage');
  expect(accountOverride.overrideParameters['@type']).toBe('LoginMethodGuardStorage');
  const config = path.join(root, 'account-config.json');
  await writeFile(config, JSON.stringify({ '@context': cloud['@context'],
    import: ['css:config/default.json'], '@graph': [accountOverride] }));
  const request = (route: string, method: string, body?: object, token?: string) => fetch(new URL(route, origin), {
    method, redirect: 'manual', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `CSS-Account-Token ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const createAccount = async () => {
    const response = await request('/.account/account/', 'POST', {});
    expect(response.ok).toBe(true);
    const account = await response.json() as { authorization: string };
    expect(account.authorization).toBeTruthy();
    const controls = await request('/.account/', 'GET', undefined, account.authorization);
    expect(controls.status, await controls.clone().text()).toBe(200);
    return { token: account.authorization, ...(await controls.json() as {
      controls: { password: { create: string }; account: { pod: string } };
    }) };
  };
  let app: App | undefined;
  try {
    app = await new AppRunner().create({ config, loaderProperties: { mainModulePath: process.cwd() },
      variableBindings: { 'urn:solid-server:default:variable:identityDbUrl': database },
      shorthand: { port, baseUrl: `${origin}/`, rootFilePath: path.join(root, 'data'), loggingLevel: 'off' },
    });
    await app.start();
    const account = await createAccount();
    const email = 'guard-http@example.test';
    const password = 'guard-http-password';
    const created = await request(account.controls.password.create, 'POST', { email, password }, account.token);
    expect(created.ok).toBe(true);
    const first = await created.json() as { resource: string };
    expect((await request(first.resource, 'DELETE', undefined, account.token)).status).toBe(400);
    expect((await request('/.account/login/password/', 'POST', { email, password })).ok).toBe(true);
    const second = await request(account.controls.password.create, 'POST', { email: 'guard-second@example.test', password }, account.token);
    expect(second.ok).toBe(true);
    const secondResource = (await second.json() as { resource: string }).resource;
    expect((await request(secondResource, 'DELETE', undefined, account.token)).ok).toBe(true);
    expect((await request(first.resource, 'DELETE', undefined, account.token)).status).toBe(400);
    expect((await request('/.account/login/password/', 'POST', { email, password })).ok).toBe(true);

    const passwordless = await createAccount();
    const podResponse = await request(passwordless.controls.account.pod, 'POST', { name: 'passwordless-sp' }, passwordless.token);
    expect(podResponse.ok).toBe(true);
    const pod = await podResponse.json() as { pod: string };
    expect(pod.pod).toBe(`${origin}/passwordless-sp/`);
    const persisted = new DrizzleIndexedStorage(database);
    const rows = await persisted.find('pod', { baseUrl: pod.pod });
    expect(rows).toHaveLength(1);
    expect(await persisted.has('account', rows[0].accountId)).toBe(true);
    expect(await persisted.find('password', { accountId: rows[0].accountId })).toEqual([]);
  } finally {
    await app?.stop();
    await closeAllIdentityConnections();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
