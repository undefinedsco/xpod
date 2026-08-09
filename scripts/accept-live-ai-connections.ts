import { drizzle, type SolidAuthSession, type SolidDatabase } from '@undefineds.co/drizzle-solid';
import { aiModelResource, aiProviderResource, credentialResource } from '@undefineds.co/models';
import { XpodTestStack } from '../tests/helpers/XpodTestStack';
import { loginWithClientCredentials, setupAccount } from '../tests/integration/helpers/solidAccount';
import { createXpodAiConnectionsClient } from '../ui/src/api/ai-connections';
import { createXpodAiConnectionsPodStore } from '../ui/src/extensions/XpodAiConnectionsPodStore';

const deepseekApiKey = process.env.DEEPSEEK_API_KEY?.trim();
const kimiApiKey = process.env.KIMI_API_KEY?.trim();

if (!deepseekApiKey || !kimiApiKey) {
  throw new Error('DEEPSEEK_API_KEY and KIMI_API_KEY are required');
}

const stack = new XpodTestStack();

try {
  await stack.start('local', {
    transport: 'port',
    open: false,
    apiOpen: false,
    envFile: undefined,
    logLevel: 'error',
  });
  const account = await setupAccount(stack.baseUrl, `live-ai-${Date.now().toString(36)}`);
  if (!account) throw new Error('Failed to create the live AI acceptance account');

  const session = await loginWithClientCredentials(account);
  const authSession: SolidAuthSession = {
    info: session.info,
    fetch: session.fetch,
  };
  const database = drizzle(authSession, {
    podUrl: account.podUrl,
    schema: {
      aiModel: aiModelResource,
      aiProvider: aiProviderResource,
      credential: credentialResource,
    },
    autoConnect: false,
    resourcePreparation: 'off',
  }) as unknown as SolidDatabase;
  const podStore = createXpodAiConnectionsPodStore({
    database,
    webId: account.webId,
    podUrl: account.podUrl,
  });
  const client = createXpodAiConnectionsClient({
    webId: account.webId,
    podUrl: stack.baseUrl,
    authenticatedFetch: session.fetch,
    invocationFetch: fetch,
  });

  const providers = [
    {
      id: 'deepseek' as const,
      offeringId: 'api-platform',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: deepseekApiKey,
      expectedModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    },
    {
      id: 'kimi' as const,
      offeringId: 'official-subscription',
      baseUrl: 'https://api.kimi.com/coding/v1',
      apiKey: kimiApiKey,
      expectedModels: ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'k3-256k'],
    },
  ];

  for (const provider of providers) {
    const credential = await podStore.createApiKeyCredential!(provider.id, {
      offeringId: provider.offeringId,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      label: 'Live acceptance',
    });
    const discovery = await client.discoverModels(provider.id, {
      credentialId: credential.id,
      offeringId: provider.offeringId,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
    });
    const modelIds = discovery.models.map((model) => model.id);
    for (const expected of provider.expectedModels) {
      if (!modelIds.includes(expected)) {
        throw new Error(`${provider.id} discovery did not return ${expected}`);
      }
    }
    await podStore.saveDiscoveredModels(provider.id, credential.id, discovery.models);
    await podStore.saveModelSelection(provider.id, provider.expectedModels);
    console.log(JSON.stringify({
      provider: provider.id,
      step: 'xpod-model-discovery',
      count: modelIds.length,
      models: modelIds,
    }));
  }

  const clientApiKey = `sk-${Buffer.from(`${account.clientId}:${account.clientSecret}`).toString('base64')}`;
  const gatewayHeaders = {
    Authorization: `Bearer ${clientApiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const modelsResponse = await stack.runtimeFetch('/v1/models', { headers: gatewayHeaders });
  const modelsPayload = await readJson(modelsResponse, 'GET /v1/models') as { data?: Array<{ id?: string }> };
  const projectedModelIds = (modelsPayload.data ?? []).flatMap((model) => model.id ? [model.id] : []);
  for (const required of [...providers[0].expectedModels, ...providers[1].expectedModels]) {
    if (!projectedModelIds.includes(required)) {
      throw new Error(`Xpod /v1/models did not project ${required}`);
    }
  }
  console.log(JSON.stringify({ step: 'xpod-models', status: modelsResponse.status, models: projectedModelIds }));

  for (const model of ['deepseek-v4-flash', 'kimi-for-coding']) {
    const chatResponse = await stack.runtimeFetch('/v1/chat/completions', {
      method: 'POST',
      headers: gatewayHeaders,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: XPOD_OK' }],
        max_tokens: 128,
        temperature: 0,
        stream: true,
      }),
    });
    const chatText = await readText(chatResponse, `POST /v1/chat/completions (${model})`);
    assertSemanticSuccess(chatText, `chat/completions ${model}`);
    console.log(JSON.stringify({ step: 'xpod-chat', status: chatResponse.status, model, ok: true }));

    const responsesResponse = await stack.runtimeFetch('/v1/responses', {
      method: 'POST',
      headers: gatewayHeaders,
      body: JSON.stringify({
        model,
        input: 'Reply with exactly: XPOD_OK',
        max_output_tokens: 128,
        stream: true,
      }),
    });
    const responsesText = await readText(responsesResponse, `POST /v1/responses (${model})`);
    assertSemanticSuccess(responsesText, `responses ${model}`);
    console.log(JSON.stringify({ step: 'xpod-responses', status: responsesResponse.status, model, ok: true }));
  }
} finally {
  await stack.stop();
}

async function readJson(response: Response, operation: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${operation} failed with HTTP ${response.status}: ${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : undefined;
}

async function readText(response: Response, operation: string): Promise<string> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${operation} failed with HTTP ${response.status}: ${text.slice(0, 240)}`);
  return text;
}

function assertSemanticSuccess(text: string, operation: string): void {
  const semanticText = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .flatMap((line) => {
      try {
        const event = JSON.parse(line.slice(6)) as Record<string, any>;
        return [
          event.choices?.[0]?.delta?.content,
          event.choices?.[0]?.delta?.reasoning_content,
          event.delta,
          event.text,
        ].filter((value): value is string => typeof value === 'string');
      } catch {
        return [];
      }
    })
    .join('');
  if (!semanticText.includes('XPOD_OK')) {
    throw new Error(`${operation} did not contain the expected semantic response: ${text.slice(0, 800)}`);
  }
}
