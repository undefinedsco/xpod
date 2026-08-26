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

  const chatService = {
    complete: vi.fn(),
    stream: vi.fn(),
    responses: vi.fn(),
    messages: vi.fn(),
    listModels: vi.fn(),
  };

  beforeAll(async () => {
    const port = await getFreePort();
    baseUrl = 'http://localhost:' + port;
    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, { chatService: chatService as any });
    await server.start();
  });

  beforeEach(() => {
    chatService.complete.mockReset();
    chatService.stream.mockReset();
    chatService.responses.mockReset();
    chatService.messages.mockReset();
    chatService.listModels.mockReset();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should handle POST /v1/responses', async () => {
    chatService.responses.mockResolvedValue({ id: 'resp-1', object: 'response' });

    const body = { prompt: '我的 key 是 sk-test-12345678901234567890' };
    const response = await fetch(baseUrl + '/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ id: 'resp-1', object: 'response' });
    expect(chatService.responses).toHaveBeenCalledWith(
      body,
      expect.objectContaining({ webId: 'https://example.com/user#me' }),
    );
  });

  it('should preserve optional vector_store_ids for downstream service handling', async () => {
    chatService.responses.mockResolvedValue({ id: 'resp-2', object: 'response' });

    const body = {
      model: 'linx-lite',
      input: 'hello',
      vector_store_ids: ['vs_123'],
    };
    const response = await fetch(baseUrl + '/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(chatService.responses).toHaveBeenCalledWith(
      body,
      expect.objectContaining({ webId: 'https://example.com/user#me' }),
    );
  });

  it('should handle POST /v1/messages', async () => {
    chatService.messages.mockResolvedValue({ id: 'msg-1', role: 'assistant' });

    const body = { role: 'user', content: '保存一下 key sk-test-abcdefghijk1234567890' };
    const response = await fetch(baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ id: 'msg-1', role: 'assistant' });
    expect(chatService.messages).toHaveBeenCalledWith(
      body,
      expect.objectContaining({ webId: 'https://example.com/user#me' }),
    );
  });

  it.each([
    { path: '/v1/responses', service: 'responses' as const, body: { model: 'user-model', input: 'hello' } },
    { path: '/v1/messages', service: 'messages' as const, body: { model: 'user-model', messages: [] } },
  ])('should map model_not_configured from $path to 400', async ({ path, service, body }) => {
    const error = new Error('No user AI provider configured in Pod for this model.');
    (error as Error & { code: string }).code = 'model_not_configured';
    chatService[service].mockRejectedValue(error);

    const response = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: error.message,
        type: 'invalid_request_error',
        code: 'model_not_configured',
      },
    });
  });
});

describe('AiHandler Integration (registration contract)', () => {
  it('keeps routes installable without a configured chat service', async () => {
    const port = await getFreePort();
    const server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, {});
    await server.start();

    try {
      const response = await fetch(`http://localhost:${port}/v1/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
        body: JSON.stringify({ input: 'hi' }),
      });
      expect(response.status).toBe(501);
    } finally {
      await server.stop();
    }
  });
});
