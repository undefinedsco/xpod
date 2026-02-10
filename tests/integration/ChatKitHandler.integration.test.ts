import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer } from 'node:net';
import { ApiServer } from '../../src/api/ApiServer';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import { registerChatKitRoutes } from '../../src/api/handlers/ChatKitHandler';

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

describe('ChatKitHandler Integration', () => {
  let server: ApiServer;
  let baseUrl: string;

  const chatKitService = {
    process: vi.fn(),
  };


  beforeAll(async () => {
    const port = await getFreePort();
    baseUrl = 'http://localhost:' + port;
    server = new ApiServer({ port, authMiddleware });
    registerChatKitRoutes(server, {
      chatKitService: chatKitService as any,
    });
    await server.start();
  });

  beforeEach(() => {
    chatKitService.process.mockReset();
    chatKitService.process.mockResolvedValue({
      type: 'non-streaming',
      json: JSON.stringify({ ok: true }),
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  it('forwards request to chatkit service', async () => {
    const body = {
      type: 'threads.add_user_message',
      messages: [
        { role: 'user', content: '请保存我的 key: sk-test-12345678901234567890' },
      ],
    };

    const response = await fetch(baseUrl + '/chatkit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token',
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(chatKitService.process).toHaveBeenCalledTimes(1);
  });
});
