import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ApiServer } from '../../src/api/ApiServer';
import { PodChatKitStore } from '../../src/api/chatkit/pod-store';
import { getFreePort } from '../../src/runtime/port-finder';
import { VercelChatService } from '../../src/api/service/VercelChatService';
import { registerChatRoutes } from '../../src/api/handlers/ChatHandler';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';

// Mock the Session class from Inrupt to avoid real network calls
vi.mock('@inrupt/solid-client-authn-node', () => {
  return {
    Session: vi.fn().mockImplementation(() => ({
      login: vi.fn().mockResolvedValue(undefined),
      fetch: vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        const target = url.toString();
        if (target.includes('/-/sparql')) {
          const method = init?.method?.toUpperCase() ?? 'GET';
          const queryFromUrl = (() => {
            try {
              return new URL(target).searchParams.get('query') ?? '';
            } catch {
              return '';
            }
          })();
          const body = (() => {
            const raw = init?.body;
            if (typeof raw === 'string') {
              return raw;
            }
            if (raw instanceof URLSearchParams) {
              return raw.toString();
            }
            if (raw instanceof Uint8Array) {
              return Buffer.from(raw).toString('utf8');
            }
            return '';
          })();
          const combined = `${queryFromUrl} ${body}`.toUpperCase();
          if (combined.includes('ASK') || method === 'HEAD') {
            return new Response(JSON.stringify({ boolean: true }), {
              headers: { 'Content-Type': 'application/sparql-results+json' }
            });
          }
          // Mock SPARQL JSON Result
          return new Response(JSON.stringify({
            head: { vars: ['subject', 'id', 'enabled', 'apiKey', 'baseUrl', 'models', 'updatedAt'] },
            results: {
              bindings: [{
                subject: { type: 'uri', value: 'http://localhost:3000/test/.data/model-providers/openai#it' },
                id: { type: 'literal', value: 'openai' },
                enabled: { type: 'literal', value: 'true', datatype: 'http://www.w3.org/2001/XMLSchema#boolean' },
                apiKey: { type: 'literal', value: 'sk-mock-key-from-pod' },
                baseUrl: { type: 'literal', value: 'http://127.0.0.1:4003/v1' },
                models: { type: 'literal', value: '[]' },
                updatedAt: { type: 'literal', value: new Date().toISOString(), datatype: 'http://www.w3.org/2001/XMLSchema#dateTime' }
              }]
            }
          }), { headers: { 'Content-Type': 'application/sparql-results+json' } });
        }
        return new Response('{}');
      }),
      info: { isLoggedIn: true, webId: 'http://localhost:3000/test/profile/card#me' }
    }))
  };
});

describe('Chat Mock Logic Flow', () => {
  let server: ApiServer;
  let store: PodChatKitStore;
  let port: number;
  let aiPort: number;
  let baseUrl: string;

  let aiRequestHeaders: any = null;
  let originalFetch: typeof fetch;

  beforeAll(async () => {
    port = await getFreePort(10000);
    aiPort = await getFreePort(port + 1);
    baseUrl = `http://127.0.0.1:${port}`;

    // 1. Mock AI Backend fetch
    originalFetch = global.fetch;
    global.fetch = async (url, init) => {
      const target = typeof url === 'string'
        ? url
        : url instanceof URL
          ? url.toString()
          : url.url;
      if (target.startsWith(`http://127.0.0.1:${aiPort}/v1`)) {
        const headerSource = init?.headers ?? (url instanceof Request ? url.headers : undefined);
        aiRequestHeaders = Object.fromEntries(new Headers(headerSource).entries());
        // Return OpenAI Chat Completions API format (not Responses API)
        return new Response(JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'gpt-4',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Mock AI Success'
              },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url, init);
    };

    // 2. Setup Services with PodChatKitStore
    store = new PodChatKitStore({
      tokenEndpoint: 'http://localhost:3000/.oidc/token',
    });

    // Mock getAiConfig to return test config
    store.getAiConfig = async () => ({
      providerId: 'openai',
      apiKey: 'sk-mock-key-from-pod',
      baseUrl: `http://127.0.0.1:${aiPort}/v1`,
      credentialId: 'test-cred',
    });

    const chatService = new VercelChatService(store);

    // 3. Setup API Server
    const authMiddleware = new AuthMiddleware({
      authenticator: {
        canAuthenticate: () => true,
        authenticate: async () => ({
          success: true,
          context: { type: 'solid', clientId: 'test-client', clientSecret: 'test-secret', webId: 'http://localhost:3000/test/profile/card#me', viaApiKey: true }
        })
      } as any
    });

    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, { chatService });

    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    global.fetch = originalFetch;
  });

  it('should verify the complete logic chain: Request -> Pod Config -> AI Call', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer any' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });

    const data = await response.json() as any;

    // Check final output
    expect(response.status).toBe(200);
    expect(data.choices[0].message.content).toBe('Mock AI Success');

    // VERIFY THE MAGIC: Did the AI SDK use the apiKey we mocked in the Turtle data?
    expect(aiRequestHeaders.authorization).toBe('Bearer sk-mock-key-from-pod');
  }, 15000);
});
