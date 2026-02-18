import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiServer } from '../../src/api/ApiServer';
import { VercelChatService } from '../../src/api/service/VercelChatService';
import { registerChatRoutes } from '../../src/api/handlers/ChatHandler';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import { setupAccount, type AccountSetup } from './helpers/solidAccount';
import { PodChatKitStore } from '../../src/api/chatkit/pod-store';
import type { StoreContext } from '../../src/api/chatkit/store';
import { Provider } from '../../src/ai/schema/provider';
import { Credential } from '../../src/credential/schema/tables';
import { CredentialStatus, ServiceType } from '../../src/credential/schema/types';

const RUN_INTEGRATION_TESTS = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
// Business env vars (preferred):
// - DEFAULT_API_KEY / DEFAULT_API_BASE / DEFAULT_MODEL
const AI_API_KEY = process.env.DEFAULT_API_KEY;
const AI_MODEL = process.env.DEFAULT_MODEL || 'stepfun/step-3.5-flash:free';

function resolveDefaultBaseUrl(provider?: string): string {
  const normalized = (provider || 'openrouter').toLowerCase();
  const urls: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai',
    anthropic: 'https://api.anthropic.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    ollama: 'http://localhost:11434/v1',
    mistral: 'https://api.mistral.ai/v1',
    cohere: 'https://api.cohere.ai/v1',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  };
  return urls[normalized] || urls.openrouter;
}

// Default to OpenRouter since the default E2E model id is OpenRouter-style.
// Allow overriding baseUrl explicitly when testing other providers.
const AI_BASE_URL =
  process.env.DEFAULT_API_BASE ||
  resolveDefaultBaseUrl(process.env.DEFAULT_PROVIDER);
const shouldRun = RUN_INTEGRATION_TESTS && Boolean(AI_API_KEY);
const suite = shouldRun ? describe : describe.skip;

const solidBaseUrl = (process.env.CSS_BASE_URL ?? 'http://localhost:5739').replace(/\/$/, '');

suite('Chat Pod E2E Integration (Real Network)', () => {
  let server: ApiServer;
  const port = 3107;
  const baseUrl = `http://localhost:${port}`;
  let account: AccountSetup;

  beforeAll(async () => {
    const createdAccount = await setupAccount(solidBaseUrl, 'chat-e2e');
    if (!createdAccount) {
      throw new Error(`Failed to setup account on ${solidBaseUrl}`);
    }
    account = createdAccount;

    const store = new PodChatKitStore({
      tokenEndpoint: `${account.issuer.replace(/\/$/, '')}/.oidc/token`,
    });

    const storeContext: StoreContext = {
      userId: account.webId,
      auth: {
        type: 'solid',
        webId: account.webId,
        clientId: account.clientId,
        clientSecret: account.clientSecret,
        viaApiKey: true,
      } as any,
    };

    const db = await (store as any).getDb(storeContext);
    if (!db) {
      throw new Error('Failed to initialize Pod DB for ChatPodE2E test');
    }

    const providerId = 'chat-e2e-provider';
    await db.insert(Provider).values({
      id: providerId,
      displayName: 'Chat E2E Provider',
      baseUrl: AI_BASE_URL!,
    });

    await db.insert(Credential).values({
      id: 'chat-e2e-credential',
      provider: `${account.podUrl}settings/ai/providers.ttl#${providerId}`,
      service: ServiceType.AI,
      status: CredentialStatus.ACTIVE,
      apiKey: AI_API_KEY!,
      label: 'Chat E2E credential',
      baseUrl: AI_BASE_URL!,
    });

    const chatService = new VercelChatService(store);
    const authMiddleware = new AuthMiddleware({
      authenticator: {
        canAuthenticate: () => true,
        authenticate: async () => ({
          success: true,
          context: {
            type: 'solid',
            clientId: account.clientId,
            clientSecret: account.clientSecret,
            webId: account.webId,
            viaApiKey: true,
          },
        }),
      } as any,
    });

    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, { chatService });
    await server.start();
  }, 60000);

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  }, 60000);

  it('should complete chat with real provider config in Pod', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer any' },
      body: JSON.stringify({ model: AI_MODEL, messages: [{ role: 'user', content: 'ping' }] }),
    });

    if (response.status !== 200) {
      const errBody = await response.text();
      console.error('[ChatPodE2E error]', errBody);
    }

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.choices?.[0]?.message?.content).toBeTruthy();
  }, 60000);
});
