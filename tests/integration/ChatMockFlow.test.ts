import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ApiServer } from '../../src/api/ApiServer';
import { getFreePort } from '../../src/runtime/port-finder';
import { registerChatRoutes } from '../../src/api/handlers/ChatHandler';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';

describe('Chat Mock Logic Flow', () => {
  let server: ApiServer;
  let port: number;
  let baseUrl: string;
  let complete: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    port = await getFreePort(10000);
    baseUrl = `http://127.0.0.1:${port}`;

    complete = vi.fn().mockResolvedValue({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'gpt-4',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Mock AI Success',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const authMiddleware = new AuthMiddleware({
      authenticator: {
        canAuthenticate: () => true,
        authenticate: async () => ({
          success: true,
          context: {
            type: 'solid',
            clientId: 'test-client',
            clientSecret: 'test-secret',
            webId: 'http://localhost:3000/test/profile/card#me',
            accessToken: 'pod-token',
            tokenType: 'Bearer',
          },
        }),
      } as any,
    });

    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, {
      chatService: {
        complete,
        stream: vi.fn(),
        listModels: vi.fn(),
      } as any,
    });

    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should verify the complete logic chain: Request -> ChatService', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer any' },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    const data = await response.json() as any;

    expect(response.status).toBe(200);
    expect(data.choices[0].message.content).toBe('Mock AI Success');
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
      }),
      expect.objectContaining({ webId: 'http://localhost:3000/test/profile/card#me' }),
    );
  }, 15000);
});
