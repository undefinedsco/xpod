import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ApiServer } from '../../src/api/ApiServer';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import { registerChatRoutes, type ChatCompletionResponse } from '../../src/api/handlers/ChatHandler';
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

function streamResponse(text: string): any {
  return {
    toTextStreamResponse: () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${text}\n\n`));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ),
  };
}

describe('ChatHandler Integration', () => {
  let server: ApiServer;
  let port: number;
  let baseUrl: string;

  const chatService = {
    complete: vi.fn(),
    stream: vi.fn(),
    responses: vi.fn(),
    messages: vi.fn(),
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
    chatService.responses.mockReset();
    chatService.messages.mockReset();
    chatService.listModels.mockReset();
    chatService.complete.mockResolvedValue(defaultCompletion);
    chatService.stream.mockResolvedValue(streamResponse('STREAM OK'));
    chatService.responses.mockResolvedValue({
      id: 'resp-1',
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'response ok' }] }],
    });
    chatService.messages.mockResolvedValue({
      id: 'msg-1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'message ok' }],
    });
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
    expect(contentType).toContain('text/event-stream');
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
    expect(chatService.complete.mock.calls[0]?.[0]).toMatchObject(body);
  });

  it('should handle responses, messages, chat completions and models through chatService', async () => {
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
    expect(chatService.responses).toHaveBeenCalledOnce();
    expect(chatService.messages).toHaveBeenCalledOnce();
    expect(chatService.complete).toHaveBeenCalledOnce();
    expect(chatService.listModels).toHaveBeenCalledOnce();
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
  it('keeps public v1 routes installed and returns service errors at request time', async () => {
    const port = await getFreePort(13000);
    const server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, {});
    await server.start();

    try {
      const response = await fetch(`http://localhost:${port}/v1/models`, {
        headers: { 'Authorization': 'Bearer test-token' },
      });
      expect(response.status).toBe(503);
      const data = await response.json() as any;
      expect(data.error).toBe('Chat service not configured');
    } finally {
      await server.stop();
    }
  });
});
