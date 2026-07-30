import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer } from 'node:net';
import { ApiServer } from '../../src/api/ApiServer';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import { registerChatRoutes } from '../../src/api/handlers/ChatHandler';

const authMiddleware = new AuthMiddleware({
  authenticator: {
    canAuthenticate: () => true,
    authenticate: async () => ({
      success: true,
      context: { type: 'solid', webId: 'https://example.com/user#me', accountId: 'user-1' },
    }),
  } as any,
});

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const tester = createServer();
    tester.once('error', reject);
    tester.listen(0, '127.0.0.1', () => {
      const address = tester.address();
      if (!address || typeof address === 'string') {
        tester.close(() => reject(new Error('Failed to resolve free port')));
        return;
      }
      const port = address.port;
      tester.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

describe('AiHandler Integration (Responses & Messages)', () => {
  let server: ApiServer;
  let baseUrl: string;

  const aiGatewayService = {
    complete: vi.fn(),
    execute: vi.fn(),
    listModels: vi.fn(),
  };


  beforeAll(async () => {
    const port = await getFreePort();
    baseUrl = 'http://localhost:' + port;
    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, {
      aiGatewayService: aiGatewayService as any,
    });
    await server.start();
  });

  beforeEach(() => {
    aiGatewayService.complete.mockReset();
    aiGatewayService.execute.mockReset();
    aiGatewayService.listModels.mockReset();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should handle POST /v1/responses', async () => {
    aiGatewayService.complete.mockResolvedValue({ id: 'resp-1', object: 'response' });

    const response = await fetch(baseUrl + '/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({ prompt: '我的 key 是 sk-test-12345678901234567890' }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ id: 'resp-1', object: 'response' });
    expect(aiGatewayService.complete).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'responses',
      body: { prompt: '我的 key 是 sk-test-12345678901234567890' },
    }));
  });

  it('should preserve optional vector_store_ids for downstream service handling', async () => {
    aiGatewayService.complete.mockResolvedValue({ id: 'resp-2', object: 'response' });

    const response = await fetch(baseUrl + '/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({
        model: 'linx-lite',
        input: 'hello',
        vector_store_ids: ['vs_123'],
      }),
    });

    expect(response.status).toBe(200);
    expect(aiGatewayService.complete).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'responses',
      body: {
        model: 'linx-lite',
        input: 'hello',
        vector_store_ids: ['vs_123'],
      },
    }));
  });

  it('should handle POST /v1/messages', async () => {
    aiGatewayService.complete.mockResolvedValue({ id: 'msg-1', role: 'assistant' });

    const response = await fetch(baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({ role: 'user', content: '保存一下 key sk-test-abcdefghijk1234567890' }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ id: 'msg-1', role: 'assistant' });
    expect(aiGatewayService.complete).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'anthropic',
      body: { role: 'user', content: '保存一下 key sk-test-abcdefghijk1234567890' },
    }));
  });
});

describe('AiHandler Integration (registration contract)', () => {
  it('requires AiGatewayService at registration time', () => {
    const server = new ApiServer({ port: 0, authMiddleware });
    expect(() => registerChatRoutes(server, {})).toThrow(/AiGatewayService/);
  });
});
