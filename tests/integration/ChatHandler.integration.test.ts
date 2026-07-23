import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ApiServer } from '../../src/api/ApiServer';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import { registerChatRoutes, type ChatCompletionResponse } from '../../src/api/handlers/ChatHandler';
import { ChatCompletionsFrontend, MessagesFrontend, ResponsesFrontend } from '../../src/api/ai-gateway/protocol';
import { getFreePort } from '../../src/runtime/port-finder';

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
  let port: number;
  let baseUrl: string;

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
    port = await getFreePort(10000);
    baseUrl = `http://localhost:${port}`;
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
  }, 10000);

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

  it('should preserve OpenAI tool-call fields at the chat completions boundary', async () => {
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'bash',
          arguments: '{"command":"pwd"}',
        },
      },
    ];
    const tools = [
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a shell command',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string' },
            },
            required: ['command'],
          },
        },
      },
    ];
    const body = {
      model: 'xpod-default',
      stream: false,
      messages: [
        { role: 'user', content: 'List the current directory using the bash tool.' },
        { role: 'assistant', content: null, tool_calls: toolCalls },
        { role: 'tool', tool_call_id: 'call_1', content: '/tmp/project' },
      ],
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
    };

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(chatService.complete).toHaveBeenCalledOnce();
    expect(chatService.complete.mock.calls[0]?.[0]).toEqual(body);
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
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    port = await getFreePort(11000);
    baseUrl = `http://localhost:${port}`;
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

describe('ChatHandler delegates public v1 AI routes to AiGatewayHandler when configured', () => {
  let server: ApiServer;
  let port: number;
  let baseUrl: string;

  const legacyChatService = {
    complete: vi.fn(),
    stream: vi.fn(),
    listModels: vi.fn(),
  };
  const aiGatewayService = {
    complete: vi.fn(async({ protocol }: any) => protocol === 'anthropic'
      ? {
          id: 'msg_gateway',
          type: 'message',
          role: 'assistant',
          model: 'gpt-5',
          content: [{ type: 'text', text: 'message ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      : protocol === 'responses'
        ? {
            id: 'resp_gateway',
            object: 'response',
            status: 'completed',
            model: 'gpt-5',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'response ok' }] }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }
        : {
            id: 'chatcmpl_gateway',
            object: 'chat.completion',
            created: 0,
            model: 'gpt-5',
            choices: [{ index: 0, message: { role: 'assistant', content: 'chat ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
    execute: vi.fn(async({ protocol }: any) => ({
      protocol,
      frontend: protocol === 'responses'
        ? new ResponsesFrontend()
        : protocol === 'anthropic'
          ? new MessagesFrontend()
          : new ChatCompletionsFrontend(),
      request: {
        model: 'gpt-5',
        messages: [],
        tools: [],
        stream: true,
        protocolExtensions: {},
      },
      route: {},
      events: (async function*() {
        yield { type: 'response.started', id: 'stream_gateway' };
        yield { type: 'text.delta', text: 'stream ok' };
        yield { type: 'response.completed', finishReason: 'stop' };
      })(),
    })),
    listModels: vi.fn(async() => [{ id: 'gpt-5', object: 'model', owned_by: 'openai' }]),
  };

  beforeAll(async () => {
    port = await getFreePort(12000);
    baseUrl = `http://localhost:${port}`;
    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, {
      chatService: legacyChatService as any,
      aiGatewayService: aiGatewayService as any,
    });
    await server.start();
  });

  beforeEach(() => {
    legacyChatService.complete.mockClear();
    legacyChatService.stream.mockClear();
    legacyChatService.listModels.mockClear();
    aiGatewayService.complete.mockClear();
    aiGatewayService.execute.mockClear();
    aiGatewayService.listModels.mockClear();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('delegates non-streaming responses, messages, chat completions and models to the gateway service', async () => {
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' };
    const [responses, messages, chat, models] = await Promise.all([
      fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'gpt-5', input: 'hi' }),
      }),
      fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'gpt-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
      }),
      fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }),
      }),
      fetch(`${baseUrl}/v1/models`, {
        headers: { 'Authorization': 'Bearer test-token' },
      }),
    ]);

    expect(responses.status).toBe(200);
    expect(messages.status).toBe(200);
    expect(chat.status).toBe(200);
    expect(models.status).toBe(200);
    expect(aiGatewayService.complete).toHaveBeenCalledTimes(3);
    expect(aiGatewayService.listModels).toHaveBeenCalledOnce();
    expect(legacyChatService.complete).not.toHaveBeenCalled();
    expect(legacyChatService.listModels).not.toHaveBeenCalled();
  });

  it('delegates streaming chat completions to gateway SSE serialization', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({ model: 'gpt-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('stream ok');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
    expect(aiGatewayService.execute).toHaveBeenCalledOnce();
    expect(legacyChatService.stream).not.toHaveBeenCalled();
  });
});
