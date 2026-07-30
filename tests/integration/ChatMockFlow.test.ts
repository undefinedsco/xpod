import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ApiServer } from '../../src/api/ApiServer';
import { getFreePort } from '../../src/runtime/port-finder';
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
  let port: number;
  let baseUrl: string;
  let gatewayComplete: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    port = await getFreePort(10000);
    baseUrl = `http://127.0.0.1:${port}`;

    gatewayComplete = vi.fn().mockResolvedValue({
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
    });

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
    registerChatRoutes(server, {
      aiGatewayService: {
        complete: gatewayComplete,
        execute: vi.fn(),
        listModels: vi.fn(),
      } as any,
    });

    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should verify the complete logic chain: Request -> AiGatewayService', async () => {
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

    expect(gatewayComplete).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'chatCompletions',
      body: {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }]
      },
    }));
  }, 15000);
});
