import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ApiServer } from '../../src/api/ApiServer';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import { registerChatRoutes, type ChatCompletionResponse } from '../../src/api/handlers/ChatHandler';

const authMiddleware = new AuthMiddleware({
  authenticator: {
    canAuthenticate: () => true,
    authenticate: async () => ({
      success: true,
      context: { type: 'solid', webId: 'https://example.com/user#me', accountId: 'user-1' },
    }),
  } as any,
});

describe('ChatHandler Integration', () => {
  let server: ApiServer;
  const port = 3111;
  const baseUrl = `http://localhost:${port}`;

  const chatService = {
    complete: vi.fn(),
    stream: vi.fn(),
    listModels: vi.fn(),
  };

  const defaultCompletion: ChatCompletionResponse = {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'xpod-default',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };

  const makeStreamResult = () => ({
    toDataStreamResponse: () => new Response('data: hello\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  });

  beforeAll(async () => {
    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, { chatService: chatService as any });
    await server.start();
  });

  beforeEach(() => {
    chatService.complete.mockReset();
    chatService.stream.mockReset();
    chatService.listModels.mockReset();
    chatService.complete.mockResolvedValue(defaultCompletion);
    chatService.stream.mockResolvedValue(makeStreamResult());
    chatService.listModels.mockResolvedValue([{ id: 'xpod-default', object: 'model' }]);
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should reject invalid JSON body', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: '{',
    });
    expect(response.status).toBe(400);
    const data = await response.json() as any;
    expect(data.error.code).toBe('invalid_body');
  });

  it('should require model', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(400);
    const data = await response.json() as any;
    expect(data.error.code).toBe('missing_model');
  });

  it('should require non-empty messages array', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({ model: 'xpod-default', messages: [] }),
    });
    expect(response.status).toBe(400);
    const data = await response.json() as any;
    expect(data.error.code).toBe('missing_messages');
  });

  it('should map model_not_configured to 400', async () => {
    const error = new Error('Model gpt-4 is not configured');
    (error as any).code = 'model_not_configured';
    chatService.complete.mockRejectedValueOnce(error);

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(400);
    const data = await response.json() as any;
    expect(data.error.code).toBe('model_not_configured');
  });

  it('should stream responses when stream=true', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({
        model: 'xpod-default',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    expect(response.status).toBe(200);
    const contentType = response.headers.get('content-type') ?? '';
    expect(contentType).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('data: hello');
    expect(chatService.stream).toHaveBeenCalled();
  });

  it('should list models', async () => {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { 'Authorization': 'Bearer test-token' },
    });
    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.object).toBe('list');
    expect(data.data[0].id).toBe('xpod-default');
  });
});

describe('ChatHandler without service', () => {
  let server: ApiServer;
  const port = 3112;
  const baseUrl = `http://localhost:${port}`;

  beforeAll(async () => {
    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, {});
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should return 503 when chat service is not configured', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({ model: 'xpod-default', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(503);
    const data = await response.json() as any;
    expect(data.error.code).toBe('service_not_configured');
  });

  it('should return 503 for models when chat service is not configured', async () => {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { 'Authorization': 'Bearer test-token' },
    });
    expect(response.status).toBe(503);
    const data = await response.json() as any;
    expect(data.error).toBe('Chat service not configured');
  });
});
