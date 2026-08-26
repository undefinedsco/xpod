import { Buffer } from 'node:buffer';
import { drizzle, type SolidDatabase } from '@undefineds.co/drizzle-solid';
import {
  aiModelResource,
  aiProviderResource,
  credentialResource,
  solidSchema,
} from '@undefineds.co/models';
import { createAiConnectionsClient } from '../../packages/ai-connections/src/ai-connections-client';
import { createSparqlEndpointQueryEngine } from '../../ui/src/solid/SparqlEndpointQueryEngine';
import {
  loginWithClientCredentials,
  setupAccount,
  type AccountSetup,
} from './helpers/solidAccount';

const baseUrl = process.env.XPOD_REAL_AI_CONNECTIONS_BASE_URL?.trim();
const providerBaseUrl = process.env.XPOD_REAL_AI_CONNECTIONS_PROVIDER_BASE_URL?.trim();
const providerApiKey = process.env.XPOD_REAL_AI_CONNECTIONS_PROVIDER_API_KEY?.trim();
const expectedModel = process.env.XPOD_REAL_AI_CONNECTIONS_MODEL?.trim() || 'xpod-fixture-chat';
const expectedReply = process.env.XPOD_REAL_AI_CONNECTIONS_REPLY?.trim() || 'XPOD_OK';
const shouldRun = Boolean(baseUrl && providerBaseUrl && providerApiKey);

describe.skipIf(!shouldRun)('Web AI Connections on a real Xpod Gateway', () => {
  it('persists, reloads, updates, lists and chats through the Web product path', async () => {
    const account = await setupAccount(baseUrl!, 'web-ai');
    expect(account).not.toBeNull();

    const session = await loginWithClientCredentials(account!);
    const authenticatedFetch: typeof fetch = async (input, init) => {
      return await session.fetch(input, init);
    };
    const databaseSession = { fetch: authenticatedFetch, info: session.info };
    const makeDatabase = (): SolidDatabase => drizzle(databaseSession, {
      podUrl: account!.podUrl,
      schema: solidSchema,
      autoConnect: false,
      resourcePreparation: 'off',
      sparql: { createQueryEngine: createSparqlEndpointQueryEngine },
    }) as unknown as SolidDatabase;
    const makeClient = (database = makeDatabase()) => createAiConnectionsClient({
      webId: account!.webId,
      podBaseUrl: account!.podUrl,
      authenticatedFetch,
      database,
    });

    const firstClient = makeClient();
    const attempt = await firstClient.beginConnect('openai', 'browserAssistedApiKey');
    await firstClient.completeApiKey(
      'openai',
      attempt,
      providerApiKey!,
      'Real Web acceptance',
      providerBaseUrl!,
    );

    const reloadedClient = makeClient();
    expect((await reloadedClient.listProviders()).find(({ provider }) => provider === 'openai'))
      .toMatchObject({ status: 'connected', accountLabel: 'Real Web acceptance' });

    await reloadedClient.completeApiKey(
      'openai',
      attempt,
      `${providerApiKey!}-updated`,
      'Real Web acceptance updated',
      providerBaseUrl!,
    );
    const credentialDocumentResponse = await authenticatedFetch(
      new URL('settings/credentials.ttl', account!.podUrl).toString(),
    );
    expect(credentialDocumentResponse.status).toBe(200);
    const credentialDocument = sanitizeTurtleLiterals(await credentialDocumentResponse.text());
    expect(credentialDocument).toContain('https://undefineds.co/ns#Credential');
    expect(credentialDocument).toContain('https://undefineds.co/ns#provider');
    expect(credentialDocument).toContain('https://undefineds.co/ns#service');
    expect(credentialDocument).toContain('https://undefineds.co/ns#status');
    const reloadedDatabase = makeDatabase();
    await (reloadedDatabase as any).init(aiProviderResource, credentialResource, aiModelResource);
    const credentials = await reloadedDatabase.select().from(credentialResource).execute();
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({
      provider: new URL('settings/providers/openai.ttl', account!.podUrl).toString(),
      status: 'active',
      label: 'Real Web acceptance updated',
    });
    expect(credentials[0]?.apiKey).toBe(`${providerApiKey!}-updated`);

    const modelDiscovery = await makeClient(reloadedDatabase).discoverModels('openai');
    expect(modelDiscovery.models.some(({ id }) => id === expectedModel)).toBe(true);
    await makeClient(reloadedDatabase).saveProviderModel('openai', {
      id: expectedModel,
      displayName: 'Xpod real acceptance model',
      inputModalities: [ 'text' ],
      outputModalities: [ 'text' ],
      capabilities: [ 'chat' ],
    });

    const gatewayApiKey = encodeGatewayApiKey(account!);
    const modelsResponse = await fetch(new URL('/v1/models', baseUrl!).toString(), {
      headers: { Authorization: `Bearer ${gatewayApiKey}` },
    });
    expect(modelsResponse.status).toBe(200);
    const modelsPayload = await modelsResponse.json() as { data?: Array<{ id?: string }> };
    expect(modelsPayload.data?.some(({ id }) => id === expectedModel)).toBe(true);

    const chatResponse = await fetch(new URL('/v1/chat/completions', baseUrl!).toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gatewayApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: expectedModel,
        messages: [ { role: 'user', content: 'Reply with the configured acceptance response.' } ],
      }),
    });
    expect(chatResponse.status).toBe(200);
    const chatPayload = await chatResponse.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    expect(chatPayload.choices?.[0]?.message?.content).toContain(expectedReply);
  }, 120_000);
});

function encodeGatewayApiKey(account: AccountSetup): string {
  return `sk-${Buffer.from(`${account.clientId}:${account.clientSecret}`, 'utf8').toString('base64')}`;
}

function sanitizeTurtleLiterals(turtle: string): string {
  return turtle.replace(/"(?:[^"\\]|\\.)*"/gu, '"<literal>"');
}
