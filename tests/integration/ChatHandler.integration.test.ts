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
    toTextStreamResponse: () => new Response('STREAM OK', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
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
    // AI SDK v6 uses toTextStreamResponse which returns text/plain
    expect(contentType).toContain('text/plain');
    const text = await response.text();
    expect(text).toContain('STREAM OK');
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


describe('ChatHandler smart pipeline', () => {
  let server: ApiServer;
  const port = 3113;
  const baseUrl = `http://localhost:${port}`;

  const chatService = {
    complete: vi.fn(),
    stream: vi.fn(),
    listModels: vi.fn(),
  };

  const recognitionService = {
    recognizeIntent: vi.fn().mockResolvedValue({
      intent: 'ai_config',
      confidence: 0.99,
      data: { provider: 'openrouter', apiKey: 'sk-test-12345678901234567890', model: 'stepfun/step-3.5-flash:free' },
    }),
  };

  const storageService = {
    storeIntent: vi.fn().mockResolvedValue({
      success: true,
      message: '已保存 AI 配置',
      location: '/settings/ai/',
    }),
  };

  beforeAll(async () => {
    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, {
      chatService: chatService as any,
      recognitionService: recognitionService as any,
      storageService: storageService as any,
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('stores smart input before delegating to chat service', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({
        model: 'stepfun/step-3.5-flash:free',
        messages: [{ role: 'user', content: '我的 key 是 sk-test-12345678901234567890' }],
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.model).toBe('intent-recognition');
    expect(data.choices[0].message.content).toContain('已保存');
    expect(storageService.storeIntent).toHaveBeenCalledTimes(1);
    expect(chatService.complete).not.toHaveBeenCalled();
  });
});
