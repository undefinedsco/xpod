import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ApiServer } from '../../src/api/ApiServer';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import { registerChatRoutes, type ChatCompletionResponse } from '../../src/api/handlers/ChatHandler';
import { InMemoryStore } from '../../src/api/chatkit/store';
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
  const chatStore = new InMemoryStore();
  const storeContext = { userId: 'https://example.com/user#me' };

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

  const makeStreamResult = () => ({
    toTextStreamResponse: () => new Response('STREAM OK', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    }),
  });

  beforeAll(async () => {
    port = await getFreePort(10000);
    baseUrl = `http://localhost:${port}`;
    server = new ApiServer({ port, authMiddleware });
    registerChatRoutes(server, { chatService: chatService as any, chatStore });
    await server.start();
  });

  beforeEach(() => {
    chatService.complete.mockReset();
    chatService.stream.mockReset();
    chatService.responses.mockReset();
    chatService.messages.mockReset();
    chatService.listModels.mockReset();
    chatService.complete.mockResolvedValue(defaultCompletion);
    chatService.stream.mockResolvedValue(makeStreamResult());
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
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'message ok' }],
    });
    chatService.listModels.mockResolvedValue([{ id: 'xpod-default', object: 'model' }]);
    chatStore.clear();
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

    const threadId = response.headers.get('x-xpod-thread-id');
    expect(threadId).toBeTruthy();
    const items = await chatStore.loadThreadItems({ thread_id: threadId! }, undefined, 10, 'asc', storeContext);
    expect(items.data.map((item) => item.type)).toEqual(['user_message', 'assistant_message']);
    expect((items.data[1] as any).content[0].text).toBe('STREAM OK');
  });

  it('persists assistant text from an OpenAI SSE stream', async () => {
    chatService.stream.mockResolvedValueOnce({
      toTextStreamResponse: () => new Response([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''), {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    });

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({
        model: 'xpod-default',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });

    await response.text();
    const threadId = response.headers.get('x-xpod-thread-id')!;
    const items = await chatStore.loadThreadItems({ thread_id: threadId }, undefined, 10, 'asc', storeContext);
    expect((items.data[1] as any).content[0].text).toBe('Hello');
  });

  it('persists a completion and reuses the requested Xpod thread', async () => {
    const firstResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({
        model: 'xpod-default',
        messages: [{ role: 'user', content: 'first' }],
      }),
    });

    expect(firstResponse.status).toBe(200);
    const threadId = firstResponse.headers.get('x-xpod-thread-id');
    expect(threadId).toMatch(/^chat\/default\/index\.ttl#thread_/);

    const secondResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token',
        'X-Xpod-Thread-Id': threadId!,
      },
      body: JSON.stringify({
        model: 'xpod-default',
        messages: [{ role: 'user', content: 'second' }],
      }),
    });

    expect(secondResponse.status).toBe(200);
    expect(secondResponse.headers.get('x-xpod-thread-id')).toBe(threadId);
    const threads = await chatStore.loadThreads(10, undefined, 'asc', storeContext);
    expect(threads.data).toHaveLength(1);
    const items = await chatStore.loadThreadItems({ thread_id: threadId! }, undefined, 10, 'asc', storeContext);
    expect(items.data.map((item) => item.type)).toEqual([
      'user_message',
      'assistant_message',
      'user_message',
      'assistant_message',
    ]);
    expect((items.data[0] as any).content[0].text).toBe('first');
    expect((items.data[2] as any).content[0].text).toBe('second');
  });

  it('keeps the user message when completion generation fails', async () => {
    chatService.complete.mockRejectedValueOnce(new Error('provider unavailable'));

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({
        model: 'xpod-default',
        messages: [{ role: 'user', content: 'keep me' }],
      }),
    });

    expect(response.status).toBe(500);
    const threadId = response.headers.get('x-xpod-thread-id')!;
    const items = await chatStore.loadThreadItems({ thread_id: threadId }, undefined, 10, 'asc', storeContext);
    expect(items.data.map((item) => item.type)).toEqual(['user_message']);
    expect((items.data[0] as any).content[0].text).toBe('keep me');
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

  it('persists OpenAI Responses input and output', async () => {
    const body = { model: 'xpod-default', input: 'response input' };
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(chatService.responses).toHaveBeenCalledWith(body, expect.anything());
    const threadId = response.headers.get('x-xpod-thread-id')!;
    const items = await chatStore.loadThreadItems({ thread_id: threadId }, undefined, 10, 'asc', storeContext);
    expect(items.data.map((item) => item.type)).toEqual(['user_message', 'assistant_message']);
    expect((items.data[0] as any).content[0].text).toBe('response input');
    expect((items.data[1] as any).content[0].text).toBe('response ok');
  });

  it('persists Anthropic Messages input, output, and tool calls in an existing thread', async () => {
    chatService.messages.mockResolvedValueOnce({
      id: 'msg-tool',
      type: 'message',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'using tool' },
        { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'pwd' } },
      ],
    });
    const first = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
      body: JSON.stringify({ model: 'xpod-default', input: 'start' }),
    });
    const threadId = first.headers.get('x-xpod-thread-id')!;
    const body = { model: 'claude-test', max_tokens: 100, messages: [{ role: 'user', content: 'next' }] };
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token',
        'X-Xpod-Thread-Id': threadId,
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-xpod-thread-id')).toBe(threadId);
    expect(chatService.messages).toHaveBeenCalledWith(body, expect.anything());
    const items = await chatStore.loadThreadItems({ thread_id: threadId }, undefined, 10, 'asc', storeContext);
    expect(items.data.map((item) => item.type)).toEqual([
      'user_message',
      'assistant_message',
      'user_message',
      'assistant_message',
      'client_tool_call',
    ]);
    expect((items.data[2] as any).content[0].text).toBe('next');
    expect((items.data[3] as any).content[0].text).toBe('using tool');
    expect((items.data[4] as any).name).toBe('bash');
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
