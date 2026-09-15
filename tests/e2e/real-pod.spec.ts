import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { alias, configureSparqlEngine, drizzle, eq, type SPARQLQueryEngine, type SolidDatabase } from '@undefineds.co/drizzle-solid';
import { QueryEngine } from '@comunica/query-sparql-solid';
import { aiModelResource, aiProviderResource, credentialResource } from '@undefineds.co/models';
import {
  loginWithClientCredentials,
  type AccountSetup,
  type ClientCredentialsSolidSession,
} from '../integration/helpers/solidAccount';

type Ready = {
  controlUrl: string;
  accounts: { alice: AccountSetup; bob: AccountSetup };
};

// This suite always disables the fake native runtime. No request interception,
// open API principal, or existing developer account participates in these tests.
test.describe('authenticated local Pod with production storage', () => {
  test.describe.configure({ timeout: 120_000 });
  let child: ChildProcess | undefined;
  let ready: Ready | undefined;
  let alice: ClientCredentialsSolidSession;
  let bob: ClientCredentialsSolidSession;
  const resources = new Set<string>();

  test.beforeAll(async () => {
    // Hook timeouts do not inherit describe's per-test timeout. Use the same
    // startup budget as the fixture's existing readiness contract below.
    test.setTimeout(120_000);
    child = spawn('bun', [path.resolve('tests/helpers/xpodSettingsFixtureServer.ts')], {
      cwd: process.cwd(),
      env: { ...process.env, XPOD_E2E_REAL_POD: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Do not retain fixture stdout: its ready record contains disposable secrets.
    child.stderr?.resume();
    ready = await new Promise<Ready>((resolve, reject) => {
      let buffered = '';
      const timer = setTimeout(() => reject(new Error('Real Pod fixture startup timed out')), 120_000);
      child!.once('error', (error) => { clearTimeout(timer); reject(error); });
      child!.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Real Pod fixture exited (${code})`)); });
      child!.stdout!.on('data', (chunk: Buffer) => {
        buffered += chunk.toString();
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('XPOD_SETTINGS_FIXTURE_READY ')) {
            clearTimeout(timer);
            resolve(JSON.parse(line.slice('XPOD_SETTINGS_FIXTURE_READY '.length)) as Ready);
          } else if (line.startsWith('XPOD_SETTINGS_FIXTURE_ERROR ')) {
            clearTimeout(timer);
            reject(new Error('Real Pod fixture failed to initialize'));
          }
        }
      });
    });
    alice = await loginWithClientCredentials(ready.accounts.alice);
    bob = await loginWithClientCredentials(ready.accounts.bob);
  });

  test.afterAll(async () => {
    for (const resource of resources) await alice?.fetch(resource, { method: 'DELETE' }).catch(() => undefined);
    await alice?.logout();
    await bob?.logout();
    if (ready) await fetch(new URL('/control/shutdown', ready.controlUrl), {
      method: 'POST', signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    child?.kill('SIGTERM');
  });

  async function writePrivateDocument(): Promise<{ url: string; content: string }> {
    const url = new URL(`private-${randomUUID()}.txt`, ready!.accounts.alice.podUrl).href;
    const content = `real-pod-${randomUUID()}`;
    resources.add(url);
    const response = await alice.fetch(url, {
      method: 'PUT', headers: { 'content-type': 'text/plain' }, body: content,
    });
    expect(response.status).toBe(201);
    return { url, content };
  }

  test('returns the exact private document written by its authenticated owner', async () => {
    const { url, content } = await writePrivateDocument();
    const response = await alice.fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(content);
  });

  test('rejects anonymous reads of an existing private document', async () => {
    const { url, content } = await writePrivateDocument();
    const response = await fetch(url);
    expect([401, 403]).toContain(response.status);
    expect(await response.text()).not.toContain(content);
  });

  test('rejects another authenticated account reading the owner private document', async () => {
    const { url, content } = await writePrivateDocument();
    const response = await bob.fetch(url);
    expect([401, 403]).toContain(response.status);
    expect(await response.text()).not.toContain(content);
  });

  test('reads back an exact credential persisted through drizzle-solid', async () => {
    const database = drizzle(alice, {
      podUrl: ready!.accounts.alice.podUrl,
      schema: { aiModel: aiModelResource, aiProvider: aiProviderResource, credential: credentialResource },
      autoConnect: false,
      resourcePreparation: 'off',
    }) as unknown as SolidDatabase;
    configureSparqlEngine({
      createQueryEngine: async () => new QueryEngine() as unknown as SPARQLQueryEngine,
    });
    await database.init?.(credentialResource);
    const id = credentialResource.buildId({ id: `real-pod-${randomUUID()}` });
    const label = `persisted-${randomUUID()}`;
    await database.insert(credentialResource).values({
      id, label, service: 'ai', status: 'active', authMode: 'apiKey',
    } as never).execute();
    // A fresh client must retrieve the persisted row; an insertion result or
    // a cache in the writer is insufficient evidence of Pod persistence.
    const reader = drizzle(alice, {
      podUrl: ready!.accounts.alice.podUrl,
      schema: { credential: credentialResource },
      autoConnect: false,
      resourcePreparation: 'off',
    }) as unknown as SolidDatabase;
    expect(await reader.findById(credentialResource, id)).toMatchObject({ id, label, service: 'ai' });
  });

  test('finds persisted RDF through the authenticated native SPARQL collection endpoint', async () => {
    configureSparqlEngine({
      createQueryEngine: async () => new QueryEngine() as unknown as SPARQLQueryEngine,
    });
    const writer = drizzle(alice, {
      podUrl: ready!.accounts.alice.podUrl,
      schema: { credential: credentialResource },
      autoConnect: false,
      resourcePreparation: 'off',
    }) as unknown as SolidDatabase;
    await writer.init?.(credentialResource);
    const id = credentialResource.buildId({ id: `native-query-${randomUUID()}` });
    const label = `native-query-${randomUUID()}`;
    await writer.insert(credentialResource).values({
      id, label, service: 'ai', status: 'active', authMode: 'apiKey',
    } as never).execute();

    const endpoint = new URL('settings/-/sparql', ready!.accounts.alice.podUrl).href;
    const queryResponses: number[] = [];
    const authenticatedFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await alice.fetch(input, init);
      if (new URL(request.url).pathname === new URL(endpoint).pathname) {
        queryResponses.push(response.status);
      }
      return response;
    };
    const nativeCredential = alias(credentialResource, 'nativeCredential');
    nativeCredential.setSparqlEndpoint(endpoint);
    const reader = drizzle({ info: alice.info, fetch: authenticatedFetch }, {
      podUrl: ready!.accounts.alice.podUrl,
      schema: { credential: nativeCredential },
      autoConnect: false,
      resourcePreparation: 'off',
    }) as unknown as SolidDatabase;
    const rows = await reader.select().from(nativeCredential)
      .where(eq(nativeCredential.label, label)).execute() as Array<Record<string, unknown>>;
    expect(queryResponses.length).toBeGreaterThan(0);
    expect(queryResponses.every((status) => status === 200)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, label, service: 'ai' });
  });
});
