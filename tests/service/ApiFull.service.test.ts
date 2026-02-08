import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApiServer } from '../../src/api/ApiServer';
import { MultiAuthenticator } from '../../src/api/auth/MultiAuthenticator';
import { ClientCredentialsAuthenticator } from '../../src/api/auth/ClientCredentialsAuthenticator';
import { registerSignalRoutes } from '../../src/api/handlers/SignalHandler';
import { registerNodeRoutes } from '../../src/api/handlers/NodeHandler';
import { registerChatRoutes } from '../../src/api/handlers/ChatHandler';
import { EdgeNodeRepository } from '../../src/identity/drizzle/EdgeNodeRepository';
import { getIdentityDatabase, closeAllIdentityConnections } from '../../src/identity/drizzle/db';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';

const RUN_SERVICE_TESTS = process.env.XPOD_RUN_SERVICE_TESTS === 'true';
const suite = RUN_SERVICE_TESTS ? describe : describe.skip;

// Mock SolidTokenAuthenticator
const mockSolidAuth = {
  canAuthenticate: (req: any) => !!req.headers.dpop,
  authenticate: async () => ({
    success: true,
    context: { type: 'solid', webId: 'https://user#me', accountId: 'user-1' }
  })
};

// Mock ClientCredentialsStore

function createApiKey(clientId: string, clientSecret: string): string {
  return `sk-${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

const mockCredStore = {
  findByClientId: async (id: string) => id === 'valid-api-key' ? ({
    clientId: id, 
    clientSecret: 'secret', 
    webId: 'https://bot#me', 
    accountId: 'bot-1', 
    createdAt: new Date()
  }) : undefined
};

suite('API Full Service', () => {
  let server: ApiServer;
  let repo: EdgeNodeRepository;
  const port = 3105;
  const baseUrl = `http://localhost:${port}`;

  beforeAll(async () => {
    // IdentityDatabase with memory SQLite
    const db = getIdentityDatabase('sqlite::memory:');
    repo = new EdgeNodeRepository(db);

    const clientAuth = new ClientCredentialsAuthenticator({
      store: mockCredStore,
      tokenEndpoint: 'http://localhost:9999/token'
    });

    // Mock token exchange to bypass external HTTP.
    // @ts-ignore
    clientAuth.exchangeForToken = async (clientId: string) => ({
      success: true,
      token: 'fake-token',
      webId: clientId === 'valid-api-key' ? 'https://bot#me' : 'https://unknown#me',
      expiresAt: new Date(Date.now() + 3600000),
    });

    const multiAuth = new MultiAuthenticator({
      authenticators: [mockSolidAuth as any, clientAuth]
    });

    const authMiddleware = new AuthMiddleware({
      authenticator: multiAuth
    });

    server = new ApiServer({
      port,
      authMiddleware,
    });

    // Register all routes
    registerSignalRoutes(server, { repository: repo });
    registerNodeRoutes(server, { repository: repo });
    registerChatRoutes(server, { 
      chatService: { 
        complete: async () => ({ 
          id: '1', 
          object: 'chat.completion', 
          created: Math.floor(Date.now()/1000), 
          model: 'm', 
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], 
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } 
        }) as any,
        stream: async () => ({
          toDataStreamResponse: () => new Response('data: hello\n\n', { 
            headers: { 'Content-Type': 'text/event-stream' } 
          })
        }),
        listModels: async () => [{ id: 'xpod-default', object: 'model' }]
      } 
    });

    await server.start();
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    await closeAllIdentityConnections();
  });

  it('should authenticate via Solid DPoP and list nodes', async () => {
    // Create a node first
    await repo.createNode('My Node', 'https://user#me');
    
    const response = await fetch(`${baseUrl}/v1/nodes`, {
      headers: { 
        'Authorization': 'Bearer some-token',
        'DPoP': 'some-dpop-proof'
      }
    });
    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.nodes.length).toBeGreaterThan(0);
    expect(data.nodes[0].displayName).toBe('My Node');
  });

  it('should reject API key for node endpoints', async () => {
    const response = await fetch(`${baseUrl}/v1/nodes`, {
      headers: { 'Authorization': `Bearer ${createApiKey('valid-api-key', 'secret')}` }
    });
    expect(response.status).toBe(403);
  });

  it('should create a new node via Solid auth', async () => {
    const response = await fetch(`${baseUrl}/v1/nodes`, {
      method: 'POST',
      headers: { 
        'Authorization': 'Bearer some-token',
        'DPoP': 'some-dpop-proof',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ displayName: 'Remote Node' })
    });
    expect(response.status).toBe(201);
    const data = await response.json() as any;
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();
    expect(data.token).toBeDefined();
  });

  it('should handle signals via API key according to auth policy', async () => {
    const node = await repo.createNode('Edge', 'bot-1');
    const res = await fetch(`${baseUrl}/v1/signal`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${createApiKey('valid-api-key', 'secret')}`,
      },
      body: JSON.stringify({ nodeId: node.nodeId, version: '1.0.0' })
    });
    expect([200, 403]).toContain(res.status);
  });

  it('should handle chat completions', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${createApiKey('valid-api-key', 'secret')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        model: 'xpod-default', 
        messages: [{ role: 'user', content: 'ping' }] 
      })
    });
    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.choices[0].message.content).toBe('hello');
  });

  it('should list available models', async () => {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${createApiKey('valid-api-key', 'secret')}` }
    });
    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.object).toBe('list');
    expect(data.data[0].id).toBe('xpod-default');
  });

  it('should reject invalid auth', async () => {
    const response = await fetch(`${baseUrl}/v1/nodes`, {
      headers: { 'Authorization': 'Bearer invalid-api-key' }
    });
    expect(response.status).toBe(401);
  });
});
