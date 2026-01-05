import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { ApiServer } from '../../src/api/ApiServer';
import { registerSignalRoutes } from '../../src/api/handlers/SignalHandler';
import { EdgeNodeRepository } from '../../src/identity/drizzle/EdgeNodeRepository';
import { getIdentityDatabase, closeAllIdentityConnections } from '../../src/identity/drizzle/db';
import type { Authenticator, AuthResult } from '../../src/api/auth/Authenticator';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';

describe('SignalHandler Integration', () => {
  let server: ApiServer;
  let repo: EdgeNodeRepository;
  const port = 3101;
  const baseUrl = `http://localhost:${port}`;
  const dbUrl = 'sqlite::memory:';

  beforeAll(async () => {
    // IdentityDatabase with memory SQLite
    const db = getIdentityDatabase(dbUrl);
    repo = new EdgeNodeRepository(db);

    class MockAuthenticator implements Authenticator {
      public canAuthenticate(_request: IncomingMessage): boolean {
        return true;
      }

      public async authenticate(request: IncomingMessage): Promise<AuthResult> {
        const authHeader = request.headers.authorization;
        if (authHeader === 'Bearer valid-token') {
          return {
            success: true,
            context: {
              type: 'solid',
              webId: 'https://user.example/profile#me',
              accountId: 'account-1',
            },
          };
        }
        return { success: false, error: 'Invalid token' };
      }
    }

    const authMiddleware = new AuthMiddleware({
      authenticator: new MockAuthenticator(),
    });

    server = new ApiServer({
      port,
      authMiddleware,
    });

    registerSignalRoutes(server, { repository: repo });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    await closeAllIdentityConnections();
  });

  it('should accept signal from registered node and update heartbeat', async () => {
    // 1. Create a node in DB
    const node = await repo.createNode('Test Node', 'account-1');
    const nodeId = node.nodeId;

    // 2. Send signal
    const response = await fetch(`${baseUrl}/v1/signal`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-token',
      },
      body: JSON.stringify({
        nodeId,
        version: '1.0.0',
        status: 'online',
        pods: ['https://pod1.example.com/', 'https://pod2.example.com/']
      })
    });

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.status).toBe('ok');
    expect(data.metadata.version).toBe('1.0.0');

    // 3. Verify DB update
    const metadata = await repo.getNodeMetadata(nodeId);
    expect(metadata?.metadata?.status).toBe('online');
    expect(metadata?.lastSeen).toBeDefined();

    // 4. Verify Pod list summary
    const summary = await repo.listNodes();
    const nodeSummary = summary.find(n => n.nodeId === nodeId);
    expect(nodeSummary?.podCount).toBe(2);
  });

  it('should return 403 for node owned by another account', async () => {
    const node = await repo.createNode('Other Node', 'account-2');
    const response = await fetch(`${baseUrl}/v1/signal`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-token',
      },
      body: JSON.stringify({
        nodeId: node.nodeId,
        status: 'online',
      }),
    });

    expect(response.status).toBe(403);
  });

  it('should return 401 for invalid credentials', async () => {
    const response = await fetch(`${baseUrl}/v1/signal`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': 'Bearer invalid-token',
      },
      body: JSON.stringify({
        nodeId: 'irrelevant',
      }),
    });

    expect(response.status).toBe(401);
  });

  it('should return 400 for invalid request body', async () => {
    const response = await fetch(`${baseUrl}/v1/signal`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-token',
      },
      body: 'invalid-json',
    });

    expect(response.status).toBe(400);
  });
});
