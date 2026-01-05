import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

describe('AiHandler Integration (Responses & Messages)', () => {
  let server: ApiServer;
  const port = 3113;
  const baseUrl = `http://localhost:${port}`;

  const chatService = {
    complete: vi.fn(),
    stream: vi.fn(),
    listModels: vi.fn(),
    responses: vi.fn(),
    messages: vi.fn(),
  };

  beforeAll(async () => {
    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, { chatService: chatService as any });
    await server.start();
  });

  beforeEach(() => {
    chatService.complete.mockReset();
    chatService.stream.mockReset();
    chatService.listModels.mockReset();
    chatService.responses.mockReset();
    chatService.messages.mockReset();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should handle POST /v1/responses', async () => {
    chatService.responses.mockResolvedValue({ id: 'resp-1', object: 'response' });

    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({ prompt: 'hello' }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ id: 'resp-1', object: 'response' });
    expect(chatService.responses).toHaveBeenCalledWith({ prompt: 'hello' }, expect.anything());
  });

  it('should handle POST /v1/messages', async () => {
    chatService.messages.mockResolvedValue({ id: 'msg-1', role: 'assistant' });

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({ role: 'user', content: 'hi' }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ id: 'msg-1', role: 'assistant' });
    expect(chatService.messages).toHaveBeenCalledWith({ role: 'user', content: 'hi' }, expect.anything());
  });
});

describe('AiHandler Integration (Not Implemented)', () => {
  let server: ApiServer;
  const port = 3114;
  const baseUrl = `http://localhost:${port}`;

  beforeAll(async () => {
    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, { chatService: {} as any }); // No responses/messages methods
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should return 501 if responses is not implemented', async () => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(501);
  });

  it('should return 501 if messages is not implemented', async () => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(501);
  });
});
