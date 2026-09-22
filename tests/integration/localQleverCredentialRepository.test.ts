import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Parser } from 'n3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  alias,
  drizzle,
  eq,
  type SolidAuthSession,
  type SolidDatabase,
} from '@undefineds.co/drizzle-solid';
import { aiModelResource, aiProviderResource, credentialResource } from '@undefineds.co/models';
import { PodConnectedCredentialRepository } from '../../src/api/ai-gateway/connect';
import { createInterfaceKeyPodAccess } from '../helpers/podInterfaceKeyAccess';
import { createXpodAiConnectionsPodStore } from '../../ui/src/extensions/XpodAiConnectionsPodStore';
import { XpodTestStack } from '../helpers/XpodTestStack';
import {
  loginWithClientCredentials,
  setupAccount,
  type ClientCredentialsSolidSession,
} from './helpers/solidAccount';

const runtimeCommand = process.env.XPOD_QLEVER_ACCEPTANCE_RUNTIME_COMMAND;
const runtimeTest = runtimeCommand ? it : it.skip;

describe('Local QLever credential repository', () => {
  let stack: XpodTestStack | undefined;
  let session: ClientCredentialsSolidSession | undefined;
  let runtimeRoot: string | undefined;

  afterEach(async () => {
    await session?.logout().catch(() => undefined);
    await stack?.stop();
    if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
  });

  runtimeTest('reads a UI-written API credential through the Gateway repository', async () => {
    runtimeRoot = path.resolve(
      '.test-data',
      'local-qlever-credential-repository',
      randomUUID(),
    );
    stack = new XpodTestStack();
    await stack.start('local', {
      authMode: 'acp',
      open: false,
      transport: 'port',
      runtimeRoot,
      logLevel: 'error',
      env: {
        XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: runtimeCommand!,
      },
    });
    const account = await setupAccount(stack.baseUrl.replace(/\/$/u, ''), 'qlever-credential');
    expect(account).not.toBeNull();
    session = await loginWithClientCredentials(account!);
    let credentialPatchBody = '';
    const authenticatedFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (
        request.method === 'PATCH'
        && new URL(request.url).pathname.endsWith('/settings/credentials.ttl')
      ) {
        credentialPatchBody = await request.clone().text();
      }
      return session!.fetch(input, init);
    };
    const authSession: SolidAuthSession = {
      info: session.info,
      fetch: authenticatedFetch,
    };
    const database = drizzle(authSession, {
      podUrl: account!.podUrl,
      schema: {
        aiModel: aiModelResource,
        aiProvider: aiProviderResource,
        credential: credentialResource,
      },
      autoConnect: false,
      resourcePreparation: 'off',
    }) as unknown as SolidDatabase;
    const store = createXpodAiConnectionsPodStore({
      database,
      authenticatedFetch,
      webId: account!.webId,
      podUrl: account!.podUrl,
    });
    if (!store.createApiKeyCredential) throw new Error('UI store is missing API key credential creation');
    const created = await store.createApiKeyCredential('deepseek', {
      offeringId: 'api-platform',
      apiKey: 'qlever-credential-smoke-key',
      label: 'QLever credential smoke',
    });
    if (!created || typeof created !== 'object' || !('id' in created) || typeof created.id !== 'string') {
      throw new Error('UI credential creation did not return a resource id');
    }
    expect(credentialPatchBody).toContain('\\"algorithm\\"');
    const rawCredentialResponse = await authenticatedFetch(
      new URL('settings/credentials.ttl', account!.podUrl),
      { headers: { accept: 'text/turtle' } },
    );
    expect(rawCredentialResponse.ok).toBe(true);
    const rawCredentialDocument = await rawCredentialResponse.text();
    expect(rawCredentialDocument).toContain('PLAINTEXT');
    expect(rawCredentialDocument).toContain('base64');
    expect(await store.readCredentialSecret?.('deepseek', created.id)).toMatchObject({
      apiKey: 'qlever-credential-smoke-key',
    });
    const directRows = await database
      .select()
      .from(credentialResource)
      .execute() as Array<Record<string, unknown>>;
    expect(directRows).toHaveLength(1);
    expect(directRows[0]).toMatchObject({
      id: created.id,
      service: 'ai',
      status: 'active',
    });
    expect(directRows[0]?.createdAt).toBeInstanceOf(Date);
    expect(typeof directRows[0]?.encryptedSecret).toBe('string');
    expect(() => JSON.parse(directRows[0]?.encryptedSecret as string)).not.toThrow();

    const gatewayCredential = alias(credentialResource, 'gatewayCredential');
    gatewayCredential.setSparqlEndpoint(`${account!.podUrl.replace(/\/$/u, '')}/settings/-/sparql`);
    const gatewayDatabase = drizzle(authSession, {
      podUrl: account!.podUrl,
      schema: { credential: gatewayCredential },
      autoConnect: false,
      resourcePreparation: 'off',
    }) as unknown as SolidDatabase;
    const gatewayRows = await gatewayDatabase
      .select()
      .from(gatewayCredential)
      .where(eq(gatewayCredential.service, 'ai'))
      .execute() as Array<Record<string, unknown>>;
    expect(gatewayRows).toHaveLength(1);
    expect(gatewayRows[0]).toMatchObject({
      id: created.id,
      provider: directRows[0]?.provider,
      service: 'ai',
      status: 'active',
      encryptedSecret: directRows[0]?.encryptedSecret,
    });

    // The Gateway reaches the Pod through its standard interface, authenticated with the owner's
    // own interface key: the same client credentials the session above holds. Only the key store's
    // persistence is in-memory here; the key exchange and every Pod request below are real.
    const { podAccess } = await createInterfaceKeyPodAccess({
      webId: account!.webId,
      clientId: account!.clientId,
      clientSecret: account!.clientSecret,
      tokenEndpoint: new URL('.oidc/token', account!.issuer).toString(),
      publicBaseUrl: account!.issuer,
    });
    const repository = new PodConnectedCredentialRepository({
      podAccess,
      podBaseUrlResolver: async () => account!.podUrl,
      providerIds: ['deepseek'],
    });
    const credentials = await repository.listCredentials({
      webId: account!.webId,
      deployment: 'local',
      auth: {
        type: 'solid',
        webId: account!.webId,
        internalInvocation: true,
        tokenType: 'Bearer',
      },
    });

    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({
      id: created.id,
      provider: 'deepseek',
      authMode: 'apiKey',
      enabled: true,
      accountLabel: 'QLever credential smoke',
    });
    expect(credentials[0]?.encryptedSecret).toMatchObject({
      algorithm: 'PLAINTEXT',
      webId: account!.webId,
    });
    // The provider is keyed per owner: a WebID that never granted an interface key gets no fetch.
    await expect(podAccess.getPodFetch('https://id.example/other/profile/card#me'))
      .resolves.toBeUndefined();

    // Version 0.2.53 wrote this exact resource without dcterms:created. Remove
    // only that additive field to lock compatibility with existing user Pods.
    const legacyResponse = await authenticatedFetch(
      new URL('settings/credentials.ttl', account!.podUrl),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/sparql-update' },
        body: `DELETE WHERE { <${credentialResource.buildIri(account!.podUrl, { id: created.id })}> <http://purl.org/dc/terms/created> ?created . }`,
      },
    );
    expect(legacyResponse.ok).toBe(true);
    const legacyDocumentResponse = await authenticatedFetch(new URL('settings/credentials.ttl', account!.podUrl), {
      headers: { accept: 'text/turtle' },
    });
    expect(legacyDocumentResponse.ok).toBe(true);
    const legacyQuads = new Parser().parse(await legacyDocumentResponse.text());
    expect(legacyQuads.filter((quad) => quad.predicate.value === 'http://purl.org/dc/terms/created')).toHaveLength(0);
    const legacyRows = await database.select().from(credentialResource).execute() as Array<Record<string, unknown>>;
    expect(legacyRows).toHaveLength(1);
    expect(legacyRows[0]?.createdAt == null).toBe(true);
    expect(legacyRows[0]).toMatchObject({ id: created.id, service: 'ai', status: 'active' });
    const legacyCredentials = await repository.listCredentials({
      webId: account!.webId,
      deployment: 'local',
      auth: { type: 'solid', webId: account!.webId, internalInvocation: true, tokenType: 'Bearer' },
    });
    expect(legacyCredentials).toHaveLength(1);
    expect(legacyCredentials[0]).toMatchObject({ id: created.id, provider: 'deepseek', enabled: true });
    expect(legacyCredentials[0]?.encryptedSecret).toEqual(credentials[0]?.encryptedSecret);
    expect(await store.readCredentialSecret?.('deepseek', created.id)).toMatchObject({ apiKey: 'qlever-credential-smoke-key' });
  }, 60_000);
});
