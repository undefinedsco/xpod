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
    listModels: vi.fn(),
    responses: vi.fn(),
    messages: vi.fn(),
  };

  const smartInputPipeline = {
    processText: vi.fn().mockResolvedValue(null),
  };

  beforeAll(async () => {
    const port = await getFreePort();
    baseUrl = 'http://localhost:' + port;
    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, {
      chatService: chatService as any,
      smartInputPipeline: smartInputPipeline as any,
    });
    await server.start();
  });

  beforeEach(() => {
    chatService.complete.mockReset();
    chatService.stream.mockReset();
    chatService.listModels.mockReset();
    chatService.responses.mockReset();
    chatService.messages.mockReset();
    smartInputPipeline.processText.mockReset();
    smartInputPipeline.processText.mockResolvedValue(null);
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should handle POST /v1/responses and run smart input pipeline', async () => {
    chatService.responses.mockResolvedValue({ id: 'resp-1', object: 'response' });

    const response = await fetch(baseUrl + '/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({ prompt: '我的 key 是 sk-test-12345678901234567890' }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ id: 'resp-1', object: 'response' });
    expect(chatService.responses).toHaveBeenCalledWith({ prompt: '我的 key 是 sk-test-12345678901234567890' }, expect.anything());
    expect(smartInputPipeline.processText).toHaveBeenCalledWith('我的 key 是 sk-test-12345678901234567890', expect.anything());
  });

  it('should handle POST /v1/messages and run smart input pipeline', async () => {
    chatService.messages.mockResolvedValue({ id: 'msg-1', role: 'assistant' });

    const response = await fetch(baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({ role: 'user', content: '保存一下 key sk-test-abcdefghijk1234567890' }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ id: 'msg-1', role: 'assistant' });
    expect(chatService.messages).toHaveBeenCalledWith({ role: 'user', content: '保存一下 key sk-test-abcdefghijk1234567890' }, expect.anything());
    expect(smartInputPipeline.processText).toHaveBeenCalledWith('保存一下 key sk-test-abcdefghijk1234567890', expect.anything());
  });
});

describe('AiHandler Integration (Not Implemented)', () => {
  let server: ApiServer;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await getFreePort();
    baseUrl = 'http://localhost:' + port;
    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, { chatService: {} as any }); // No responses/messages methods
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should return 501 if responses is not implemented', async () => {
    const response = await fetch(baseUrl + '/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(501);
  });

  it('should return 501 if messages is not implemented', async () => {
    const response = await fetch(baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(501);
  });
});
