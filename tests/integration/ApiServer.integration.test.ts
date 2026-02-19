import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ApiServer } from '../../src/api/ApiServer';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import type { Authenticator, AuthResult } from '../../src/api/auth/Authenticator';
import { getFreePort } from '../../src/runtime/port-finder';

class MockAuthenticator implements Authenticator {
  public async authenticate(request: any): Promise<AuthResult> {
    const authHeader = request.headers.authorization;
    if (authHeader === 'Bearer valid-token') {
      return {
        success: true,
        context: {
          type: 'solid',
          webId: 'https://example.com/user#me',
          accountId: 'user-123',
        },
      };
    }
    return { success: false, error: 'Invalid token' };
  }
}

describe('ApiServer Integration', () => {
  let server: ApiServer;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    port = await getFreePort(10000);
    baseUrl = `http://localhost:${port}`;

    const authMiddleware = new AuthMiddleware({
      authenticator: new MockAuthenticator(),
    });

    server = new ApiServer({
      port,
      authMiddleware,
    });

    // Add some test routes
    server.get('/health', async (_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok' }));
    }, { public: true });

    server.get('/protected', async (req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ message: 'Welcome!', user: req.auth?.webId }));
    });

    server.post('/data/:id', async (_req, res, params) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: params.id }));
    });

    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should return 200 for public health check', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.status).toBe('ok');
  });

  it('should return 401 for protected route without token', async () => {
    const response = await fetch(`${baseUrl}/protected`);
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('should return 200 for protected route with valid token', async () => {
    const response = await fetch(`${baseUrl}/protected`, {
      headers: { 'Authorization': 'Bearer valid-token' }
    });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.message).toBe('Welcome!');
    expect(data.user).toBe('https://example.com/user#me');
  });

  it('should parse path parameters correctly', async () => {
    const response = await fetch(`${baseUrl}/data/test-123`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer valid-token' }
    });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe('test-123');
  });

  it('should return 404 for unknown route', async () => {
    const response = await fetch(`${baseUrl}/unknown`);
    expect(response.status).toBe(404);
  });
});
