import { describe, expect, it } from 'vitest';

import { GatewayProtocolError } from '../../../src/api/ai-gateway/errors';
import type { GatewayEvent, GatewayRequest } from '../../../src/api/ai-gateway/types';
import { ChatCompletionsFrontend } from '../../../src/api/ai-gateway/protocol/ChatCompletionsFrontend';
import { ResponsesFrontend } from '../../../src/api/ai-gateway/protocol/ResponsesFrontend';
import { AnthropicRuntimeAdapter } from '../../../src/api/ai-gateway/providers/AnthropicRuntimeAdapter';
import { BailianRuntimeAdapter } from '../../../src/api/ai-gateway/providers/BailianRuntimeAdapter';
import { DeepSeekRuntimeAdapter } from '../../../src/api/ai-gateway/providers/DeepSeekRuntimeAdapter';
import { KimiRuntimeAdapter } from '../../../src/api/ai-gateway/providers/KimiRuntimeAdapter';
import { OpenAiRuntimeAdapter } from '../../../src/api/ai-gateway/providers/OpenAiRuntimeAdapter';
import { CustomRuntimeAdapter } from '../../../src/api/ai-gateway/providers/CustomRuntimeAdapter';
import { ProviderRuntimeRegistry } from '../../../src/api/ai-gateway/providers/ProviderRuntimeRegistry';
import {
  createDefaultProviderRegistry,
  ProviderRegistry,
} from '../../../src/api/ai-gateway/providers/ProviderRegistry';
import { OpenAiCompatibleRuntimeAdapter } from '../../../src/api/ai-gateway/providers/ProviderRuntimeAdapter';
import {
  ProviderHttpTransport,
  normalizeProviderProxyUrl,
  parseSseStream,
} from '../../../src/api/service/provider-http-transport';

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, any>;
  headers: Headers;
}

function baseRequest(overrides: Partial<GatewayRequest> = {}): GatewayRequest {
  return {
    model: 'model-under-test',
    instructions: 'Use strict JSON when tools are called.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', imageUrl: 'https://example.test/image.png', detail: 'low' },
        ],
      },
    ],
    tools: [
      {
        type: 'function',
        name: 'lookup',
        description: 'Lookup data',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ],
    reasoning: { effort: 'medium', exposeSummary: true },
    stream: true,
    protocolExtensions: {},
    ...overrides,
  };
}

function sse(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

function jsonSse(events: Array<Record<string, unknown> | '[DONE]'>): ReadableStream<Uint8Array> {
  return sse(events.map((event) => event === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(event)}\n\n`));
}

function fetchFixture(response: Response | (() => Response)): { fetch: typeof fetch; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  return {
    captured,
    fetch: (async(url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const rawBody = typeof init?.body === 'string' ? init.body : '{}';
      captured.push({
        url: String(url),
        init: init ?? {},
        body: JSON.parse(rawBody),
        headers,
      });
      return typeof response === 'function' ? response() : response;
    }) as typeof fetch,
  };
}

async function collect(iterable: AsyncIterable<GatewayEvent>): Promise<GatewayEvent[]> {
  const events: GatewayEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe('Provider runtime adapters', () => {
  it('creates adapters by provider id through a shared runtime registry and fails unknown providers', async () => {
    const fixture = fetchFixture(() => new Response(jsonSse([
      { id: 'chatcmpl_factory', choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]), { status: 200 }));
    const transport = new ProviderHttpTransport({ fetch: fixture.fetch });
    const runtimes = new ProviderRuntimeRegistry({
      registry: createDefaultProviderRegistry(),
      transport,
    });

    await expect(collect(runtimes.get('kimi').execute({
      request: baseRequest({ model: 'kimi-k2' }),
      apiKey: 'sk-kimi',
    }))).resolves.toContainEqual({ type: 'text.delta', text: 'ok' });
    expect(fixture.captured[0].url).toBe('https://api.moonshot.ai/v1/chat/completions');
    expect(runtimes.list().map((adapter) => adapter.provider).sort()).toEqual([
      'anthropic',
      'bailian',
      'custom',
      'deepseek',
      'kimi',
      'ollama',
      'openai',
      'zhipu',
    ]);
    expect(() => runtimes.get('unknown')).toThrow(GatewayProtocolError);
  });

  it('routes custom OpenAI-compatible providers through the credential base URL', async () => {
    const fixture = fetchFixture(() => new Response(jsonSse([
      { id: 'chatcmpl_custom', choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { content: 'custom-ok' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]), { status: 200 }));
    const runtimes = new ProviderRuntimeRegistry({
      registry: createDefaultProviderRegistry(),
      transport: new ProviderHttpTransport({ fetch: fixture.fetch }),
    });

    await expect(collect(runtimes.get('custom').execute({
      request: baseRequest({ model: 'gpt-5.6-sol' }),
      apiKey: 'sk-custom-secret',
      credential: { baseUrl: 'https://timicc.example' },
    }))).resolves.toContainEqual({ type: 'text.delta', text: 'custom-ok' });

    expect(fixture.captured[0].url).toBe('https://timicc.example/v1/chat/completions');
    expect(fixture.captured[0].headers.get('Authorization')).toBe('Bearer sk-custom-secret');
  });

  it('routes explicit Anthropic-compatible custom providers through /messages', async () => {
    const fixture = fetchFixture(() => new Response(jsonSse([
      { type: 'message_start', message: { id: 'msg_custom', usage: { input_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'anthropic-ok' } },
      { type: 'message_stop' },
    ]), { status: 200 }));
    const runtimes = new ProviderRuntimeRegistry({
      registry: createDefaultProviderRegistry(),
      transport: new ProviderHttpTransport({ fetch: fixture.fetch }),
    });

    await expect(collect(runtimes.get('custom').execute({
      request: baseRequest({ model: 'claude-compatible' }),
      apiKey: 'custom-secret',
      credential: { baseUrl: 'https://custom.example', compatibility: 'anthropic' },
    }))).resolves.toContainEqual({ type: 'text.delta', text: 'anthropic-ok' });
    expect(fixture.captured[0].url).toBe('https://custom.example/v1/messages');
    expect(fixture.captured[0].headers.get('x-api-key')).toBe('custom-secret');
  });

  it('routes Ollama local chat completions without an Authorization header', async () => {
    const fixture = fetchFixture(() => new Response(jsonSse([
      { id: 'chatcmpl_ollama', choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { content: 'local-ok' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]), { status: 200 }));
    const runtimes = new ProviderRuntimeRegistry({
      registry: createDefaultProviderRegistry(),
      transport: new ProviderHttpTransport({ fetch: fixture.fetch }),
    });

    await expect(collect(runtimes.get('ollama').execute({
      request: baseRequest({
        model: 'llama3.2:latest',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [],
        reasoning: undefined,
      }),
      apiKey: '',
    }))).resolves.toContainEqual({ type: 'text.delta', text: 'local-ok' });

    expect(fixture.captured[0].url).toBe('http://localhost:11434/v1/chat/completions');
    expect(fixture.captured[0].headers.has('Authorization')).toBe(false);
  });

  it('uses the OpenAI provider descriptor allowlist when routing to a configured fixture endpoint', async () => {
    const fixture = fetchFixture(new Response(jsonSse([
      { type: 'response.created', response: { id: 'resp_fixture' } },
      { type: 'response.output_text.delta', delta: 'fixture-ok' },
      { type: 'response.completed', response: { status: 'completed' } },
      '[DONE]',
    ]), { status: 200 }));
    const registry = createDefaultProviderRegistry();
    registry.register({
      ...registry.requireProvider('openai'),
      defaultBaseUrl: 'https://fixture.example/v1',
      safeBaseUrls: ['https://fixture.example/v1'],
    });
    const runtimes = new ProviderRuntimeRegistry({
      registry,
      transport: new ProviderHttpTransport({ fetch: fixture.fetch }),
    });

    await expect(collect(runtimes.get('openai').execute({
      request: baseRequest({ model: 'gpt-5' }),
      apiKey: 'fixture-provider-token',
    }))).resolves.toContainEqual({ type: 'text.delta', text: 'fixture-ok' });

    expect(fixture.captured[0].url).toBe('https://fixture.example/v1/responses');
    expect(fixture.captured[0].headers.get('Authorization')).toBe('Bearer fixture-provider-token');
  });

  it('streams OpenAI Responses events without buffering and preserves tools, reasoning, usage and image input', async () => {
    const fixture = fetchFixture(new Response(jsonSse([
      { type: 'response.created', response: { id: 'resp_openai' } },
      { type: 'response.output_text.delta', delta: 'hel' },
      { type: 'response.output_item.done', item: { id: 'msg_1', type: 'message' } },
      { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'lookup' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"q":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '"xpod"}' },
      {
        type: 'response.function_call_arguments.done',
        item_id: 'fc_1',
        output_index: 1,
        arguments: '{"q":"xpod"}',
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"xpod"}' },
      },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
        },
      },
      '[DONE]',
    ]), { status: 200 }));
    const adapter = new OpenAiRuntimeAdapter({ transport: new ProviderHttpTransport({ fetch: fixture.fetch }) });

    await expect(collect(adapter.execute({
      request: baseRequest({ model: 'gpt-5' }),
      apiKey: 'sk-openai-secret',
    }))).resolves.toEqual([
      { type: 'response.started', id: 'resp_openai' },
      { type: 'text.delta', text: 'hel' },
      { type: 'reasoning.delta', text: 'thinking' },
      { type: 'tool.started', callId: 'call_1', name: 'lookup' },
      { type: 'tool.arguments.delta', callId: 'call_1', delta: '{"q":' },
      { type: 'tool.arguments.delta', callId: 'call_1', delta: '"xpod"}' },
      { type: 'tool.completed', callId: 'call_1' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } },
      { type: 'response.completed', finishReason: 'completed' },
    ]);

    expect(fixture.captured[0].url).toBe('https://api.openai.com/v1/responses');
    expect(fixture.captured[0].headers.get('Authorization')).toBe('Bearer sk-openai-secret');
    expect(fixture.captured[0].body).toMatchObject({
      model: 'gpt-5',
      stream: true,
      reasoning: { effort: 'medium' },
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'hello' },
            { type: 'input_image', image_url: 'https://example.test/image.png', detail: 'low' },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          parameters: { type: 'object' },
        },
      ],
    });
  });

  it('projects a Chat Completions frontend request onto the OpenAI Responses upstream', async () => {
    const frontend = new ChatCompletionsFrontend();
    const fixture = fetchFixture(new Response(jsonSse([
      { type: 'response.created', response: { id: 'resp_chat_projection' } },
      { type: 'response.output_text.delta', delta: 'projected' },
      { type: 'response.completed', response: { status: 'completed' } },
      '[DONE]',
    ]), { status: 200 }));
    const adapter = new OpenAiRuntimeAdapter({
      transport: new ProviderHttpTransport({ fetch: fixture.fetch }),
    });

    const request = frontend.parseRequest({
      model: 'gpt-5',
      messages: [
        { role: 'system', content: 'Answer with strict JSON.' },
        { role: 'user', content: 'hello from chat completions' },
      ],
      stream: true,
    });
    await expect(collect(adapter.execute({
      request,
      apiKey: 'sk-openai-chat-projection',
    }))).resolves.toContainEqual({ type: 'text.delta', text: 'projected' });

    expect(fixture.captured[0].url).toBe('https://api.openai.com/v1/responses');
    expect(fixture.captured[0].body).toMatchObject({
      model: 'gpt-5',
      stream: true,
      instructions: 'Answer with strict JSON.',
      input: [{
        role: 'user',
        content: [{ type: 'input_text', text: 'hello from chat completions' }],
      }],
    });
    expect(fixture.captured[0].body).not.toHaveProperty('messages');
  });

  it('replays native Responses tool history as typed upstream input items', async () => {
    const frontend = new ResponsesFrontend();
    const fixture = fetchFixture(new Response(jsonSse([
      { type: 'response.created', response: { id: 'resp_tool_replay' } },
      { type: 'response.completed', response: { status: 'completed' } },
      '[DONE]',
    ]), { status: 200 }));
    const adapter = new OpenAiRuntimeAdapter({
      transport: new ProviderHttpTransport({ fetch: fixture.fetch }),
    });

    const request = frontend.parseRequest({
      model: 'gpt-5',
      input: [
        { role: 'user', content: 'Look up Xpod.' },
        {
          type: 'function_call',
          call_id: 'call_lookup',
          name: 'lookup',
          arguments: '{"q":"xpod"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_lookup',
          output: 'tool result',
        },
      ],
      stream: true,
    });
    await collect(adapter.execute({
      request,
      apiKey: 'sk-openai-tool-replay',
    }));

    expect(fixture.captured[0].body.input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'Look up Xpod.' }],
      },
      {
        type: 'function_call',
        call_id: 'call_lookup',
        name: 'lookup',
        arguments: '{"q":"xpod"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_lookup',
        output: 'tool result',
      },
    ]);
  });

  it('streams Anthropic Messages events including thinking, signatures, partial tool JSON, usage and midstream errors', async () => {
    const fixture = fetchFixture(new Response(jsonSse([
      { type: 'message_start', message: { id: 'msg_anthropic' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'chain' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"xpod"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', usage: { input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 2 } },
      { type: 'message_stop', stop_reason: 'tool_use' },
      '[DONE]',
    ]), { status: 200 }));
    const adapter = new AnthropicRuntimeAdapter({ transport: new ProviderHttpTransport({ fetch: fixture.fetch }) });

    await expect(collect(adapter.execute({
      request: baseRequest({ model: 'claude-sonnet-4-5-20250929' }),
      apiKey: 'sk-ant-secret',
    }))).resolves.toEqual([
      { type: 'response.started', id: 'msg_anthropic' },
      { type: 'text.delta', text: 'hi' },
      { type: 'reasoning.delta', text: 'chain' },
      { type: 'reasoning.signature', provider: 'anthropic', signature: 'sig' },
      { type: 'tool.started', callId: 'toolu_1', name: 'lookup' },
      { type: 'tool.arguments.delta', callId: 'toolu_1', delta: '{"q":' },
      { type: 'tool.arguments.delta', callId: 'toolu_1', delta: '"xpod"}' },
      { type: 'tool.completed', callId: 'toolu_1' },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 6, cacheReadTokens: 2 } },
      { type: 'response.completed', finishReason: 'tool_use' },
    ]);

    expect(fixture.captured[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(fixture.captured[0].headers.get('x-api-key')).toBe('sk-ant-secret');
    expect(fixture.captured[0].headers.get('anthropic-version')).toBeTruthy();
    expect(fixture.captured[0].body).toMatchObject({
      model: 'claude-sonnet-4-5-20250929',
      stream: true,
      system: 'Use strict JSON when tools are called.',
      thinking: { type: 'enabled', budget_tokens: 1024 },
    });

    const historyFixture = fetchFixture(new Response(jsonSse(['[DONE]']), { status: 200 }));
    const historyAdapter = new AnthropicRuntimeAdapter({
      transport: new ProviderHttpTransport({ fetch: historyFixture.fetch }),
    });
    await collect(historyAdapter.execute({
      request: baseRequest({
        model: 'claude-sonnet-4-5-20250929',
        instructions: undefined,
        reasoning: undefined,
        messages: [
          {
            role: 'assistant',
            content: [],
            protocolExtensions: {
              tool_calls: [{
                id: 'tool_read',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"fixture.txt"}' },
              }],
            },
          },
          {
            role: 'tool',
            toolCallId: 'tool_read',
            content: [{ type: 'text', text: 'fixture contents' }],
          },
        ],
      }),
      apiKey: 'sk-ant-secret',
    }));
    expect(historyFixture.captured[0].body.messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_read', name: 'read_file', input: { path: 'fixture.txt' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool_read', content: 'fixture contents' }],
      },
    ]);

    const errorFixture = fetchFixture(new Response(jsonSse([
      { type: 'message_start', message: { id: 'msg_error' } },
      { type: 'error', error: { type: 'overloaded_error', message: 'temporarily unavailable' } },
    ]), { status: 200 }));
    const errorAdapter = new AnthropicRuntimeAdapter({ transport: new ProviderHttpTransport({ fetch: errorFixture.fetch }) });
    await expect(collect(errorAdapter.execute({
      request: baseRequest({ model: 'claude-sonnet-4-5-20250929' }),
      apiKey: 'sk-ant-secret',
    }))).rejects.toMatchObject({
      code: 'provider_error',
      status: 503,
    });

    const stopReasonFixture = fetchFixture(new Response(jsonSse([
      { type: 'message_start', message: { id: 'msg_stop' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
      { type: 'message_stop' },
      '[DONE]',
    ]), { status: 200 }));
    const stopReasonAdapter = new AnthropicRuntimeAdapter({
      transport: new ProviderHttpTransport({ fetch: stopReasonFixture.fetch }),
    });
    await expect(collect(stopReasonAdapter.execute({
      request: baseRequest({ model: 'claude-sonnet-4-5-20250929' }),
      apiKey: 'sk-ant-secret',
    }))).resolves.toContainEqual({ type: 'response.completed', finishReason: 'max_tokens' });
  });

  it('rejects invalid Anthropic tool_use replay arguments instead of silently sending empty input', async () => {
    for (const argumentsValue of ['{"path":', '"primitive"', { path: 'not-a-json-string' }]) {
      const fixture = fetchFixture(new Response(jsonSse(['[DONE]']), { status: 200 }));
      const adapter = new AnthropicRuntimeAdapter({
        transport: new ProviderHttpTransport({ fetch: fixture.fetch }),
      });

      await expect(collect(adapter.execute({
        request: baseRequest({
          model: 'claude-sonnet-4-5-20250929',
          instructions: undefined,
          reasoning: undefined,
          messages: [
            {
              role: 'assistant',
              content: [],
              protocolExtensions: {
                tool_calls: [{
                  id: 'tool_read',
                  type: 'function',
                  function: { name: 'read_file', arguments: argumentsValue },
                }],
              },
            },
          ],
        }),
        apiKey: 'sk-ant-secret',
      }))).rejects.toMatchObject({
        code: 'invalid_request',
        status: 400,
      });
      expect(fixture.captured).toHaveLength(0);
    }
  });

  it('handles Kimi chat deltas and maps reasoning only when the live registry model allows it', async () => {
    const registry = createDefaultProviderRegistry();
    const fixture = fetchFixture(new Response(jsonSse([
      { id: 'chatcmpl_kimi', choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { reasoning_content: 'think' } }] },
      { choices: [{ delta: { content: 'answer' } }] },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_kimi',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":' },
            }],
          },
        }],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"xpod"}' } }] } }] },
      {
        choices: [{ finish_reason: 'tool_calls', delta: {} }],
        usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 },
      },
      '[DONE]',
    ]), { status: 200 }));
    const adapter = new KimiRuntimeAdapter({
      transport: new ProviderHttpTransport({ fetch: fixture.fetch }),
      provider: registry.requireProvider('kimi'),
    });

    await expect(collect(adapter.execute({
      request: baseRequest({ model: 'kimi-k3-thinking', reasoning: { effort: 'high' } }),
      apiKey: 'sk-kimi-secret',
    }))).resolves.toContainEqual({ type: 'reasoning.delta', text: 'think' });
    expect(fixture.captured[0].url).toBe('https://api.moonshot.ai/v1/chat/completions');
    expect(fixture.captured[0].headers.get('Authorization')).toBe('Bearer sk-kimi-secret');
    expect(fixture.captured[0].body).toMatchObject({
      model: 'kimi-k3-thinking',
      reasoning_effort: 'max',
    });
    expect(fixture.captured[0].body.messages[0]).toEqual({
      role: 'system',
      content: 'Use strict JSON when tools are called.',
    });

    const k2 = fetchFixture(new Response(jsonSse(['[DONE]']), { status: 200 }));
    const k2Adapter = new KimiRuntimeAdapter({
      transport: new ProviderHttpTransport({ fetch: k2.fetch }),
      provider: registry.requireProvider('kimi'),
    });
    await collect(k2Adapter.execute({
      request: baseRequest({
        model: 'kimi-k2',
        reasoning: { effort: 'high' },
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'prior' }],
            protocolExtensions: { reasoning_content: 'preserved thinking' },
          },
        ],
      }),
      apiKey: 'sk-kimi-secret',
    }));
    expect(k2.captured[0].body).not.toHaveProperty('reasoning_effort');
    expect(k2.captured[0].body).toMatchObject({ thinking: { type: 'enabled' } });
    const k2Assistant = k2.captured[0].body.messages.find((message: Record<string, unknown>) =>
      message.role === 'assistant');
    expect(k2Assistant).toMatchObject({
      role: 'assistant',
      reasoning_content: 'preserved thinking',
    });

    await expect(collect(k2Adapter.execute({
      request: baseRequest({ model: 'kimi-dynamic-unknown', reasoning: { effort: 'high' } }),
      apiKey: 'sk-kimi-secret',
    }))).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: { capability: 'reasoningEffort' },
    });

    const officialSubscription = fetchFixture(new Response(jsonSse(['[DONE]']), { status: 200 }));
    const officialAdapter = new KimiRuntimeAdapter({
      transport: new ProviderHttpTransport({ fetch: officialSubscription.fetch }),
      provider: registry.requireProvider('kimi'),
    });
    await collect(officialAdapter.execute({
      request: baseRequest({
        model: 'kimi-for-coding',
        instructions: undefined,
        reasoning: undefined,
        messages: [{
          role: 'developer',
          content: [{ type: 'text', text: 'Follow the coding policy.' }],
        }],
        protocolExtensions: { chatCompletions: { temperature: 0 } },
      }),
      apiKey: 'sk-kimi-subscription',
      credential: { baseUrl: 'https://api.kimi.com/coding/v1' },
    }));
    expect(officialSubscription.captured[0].url).toBe('https://api.kimi.com/coding/v1/chat/completions');
    expect(officialSubscription.captured[0].body.temperature).toBe(1);
    expect(officialSubscription.captured[0].body.messages).toContainEqual({
      role: 'system',
      content: 'Follow the coding policy.',
    });

    await expect(collect(officialAdapter.execute({
      request: baseRequest({ model: 'kimi-k2', reasoning: undefined }),
      apiKey: 'sk-kimi-subscription',
      credential: { baseUrl: 'https://api.kimi.com/coding/v2' },
    }))).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });
  });

  it('selects Bailian standard and Coding Plan endpoints without mixing credential key types', async () => {
    const standard = fetchFixture(new Response(jsonSse([
      { id: 'chatcmpl_bailian', choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      '[DONE]',
    ]), { status: 200 }));
    const adapter = new BailianRuntimeAdapter({ transport: new ProviderHttpTransport({ fetch: standard.fetch }) });

    await collect(adapter.execute({
      request: baseRequest({ model: 'qwen-max' }),
      apiKey: 'sk-bailian-standard',
      credential: { keyType: 'dashscope' },
    }));
    expect(standard.captured[0].url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');

    const codingPlan = fetchFixture(new Response(jsonSse([
      { type: 'message_start', message: { id: 'msg_bailian' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_stop', stop_reason: 'end_turn' },
      '[DONE]',
    ]), { status: 200 }));
    const codingAdapter = new BailianRuntimeAdapter({ transport: new ProviderHttpTransport({ fetch: codingPlan.fetch }) });
    await collect(codingAdapter.execute({
      request: baseRequest({ model: 'qwen-coder-plus' }),
      apiKey: 'sk-sp-bailian',
      credential: {
        keyType: 'codingPlan',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      },
    }));
    expect(codingPlan.captured[0].url).toBe('https://coding.dashscope.aliyuncs.com/apps/anthropic/messages');
    expect(codingPlan.captured[0].headers.get('x-api-key')).toBe('sk-sp-bailian');

    const tokenPlan = fetchFixture(new Response(jsonSse([
      { id: 'chatcmpl_token_plan', choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]), { status: 200 }));
    const tokenAdapter = new BailianRuntimeAdapter({ transport: new ProviderHttpTransport({ fetch: tokenPlan.fetch }) });
    await collect(tokenAdapter.execute({
      request: baseRequest({ model: 'qwen-max' }),
      apiKey: 'sk-token-plan',
      credential: {
        keyType: 'tokenPlan',
        baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      },
    }));
    expect(tokenPlan.captured[0].url).toBe(
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions',
    );

    await expect(collect(adapter.execute({
      request: baseRequest({ model: 'qwen-max' }),
      apiKey: 'sk-sp-bailian',
      credential: { keyType: 'codingPlan' },
    }))).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });

    await expect(collect(codingAdapter.execute({
      request: baseRequest({ model: 'qwen-coder-plus' }),
      apiKey: 'dashscope-standard',
      credential: { keyType: 'codingPlan' },
    }))).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: { keyType: 'codingPlan' },
    });

    await expect(collect(adapter.execute({
      request: baseRequest({ model: 'qwen-max' }),
      apiKey: 'sk-bailian-standard',
      credential: {
        keyType: 'dashscope',
        baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      },
    }))).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });

    await expect(collect(tokenAdapter.execute({
      request: baseRequest({ model: 'qwen-max' }),
      apiKey: 'sk-token-plan',
      credential: {
        keyType: 'tokenPlan',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
    }))).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });
  });

  it('projects a Chat Completions frontend request onto the Bailian Coding Plan Anthropic Messages upstream', async () => {
    const frontend = new ChatCompletionsFrontend();
    const fixture = fetchFixture(new Response(jsonSse([
      { type: 'message_start', message: { id: 'msg_coding_projection' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'projected' } },
      { type: 'message_stop', stop_reason: 'end_turn' },
      '[DONE]',
    ]), { status: 200 }));
    const adapter = new BailianRuntimeAdapter({
      transport: new ProviderHttpTransport({ fetch: fixture.fetch }),
    });

    const request = frontend.parseRequest({
      model: 'qwen-coder-plus',
      messages: [
        { role: 'system', content: 'Follow the coding policy.' },
        { role: 'user', content: 'hello from chat completions' },
      ],
      stream: true,
    });
    await expect(collect(adapter.execute({
      request,
      apiKey: 'sk-sp-coding-projection',
      credential: {
        keyType: 'codingPlan',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      },
    }))).resolves.toContainEqual({ type: 'text.delta', text: 'projected' });

    expect(fixture.captured[0].url).toBe('https://coding.dashscope.aliyuncs.com/apps/anthropic/messages');
    expect(fixture.captured[0].headers.get('x-api-key')).toBe('sk-sp-coding-projection');
    expect(fixture.captured[0].body).toMatchObject({
      model: 'qwen-coder-plus',
      stream: true,
      system: 'Follow the coding policy.',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'hello from chat completions' }],
      }],
    });
    expect(fixture.captured[0].body).not.toHaveProperty('input');
  });

  it('constructs Bailian regional workspace endpoints from enums and rejects SSRF strings or endpoint/key mismatches', async () => {
    const cn = fetchFixture(new Response(jsonSse(['[DONE]']), { status: 200 }));
    const adapter = new BailianRuntimeAdapter({ transport: new ProviderHttpTransport({ fetch: cn.fetch }) });
    await collect(adapter.execute({
      request: baseRequest({ model: 'qwen-max' }),
      apiKey: 'sk-bailian-standard',
      credential: {
        keyType: 'dashscope',
        region: 'cn-beijing',
        workspaceId: 'ws_123ABC',
      },
    }));
    expect(cn.captured[0].url).toBe(
      'https://dashscope.aliyuncs.com/api/v1/workspaces/ws_123ABC/compatible-mode/v1/chat/completions',
    );

    const intl = fetchFixture(new Response(jsonSse(['[DONE]']), { status: 200 }));
    const intlAdapter = new BailianRuntimeAdapter({ transport: new ProviderHttpTransport({ fetch: intl.fetch }) });
    await collect(intlAdapter.execute({
      request: baseRequest({ model: 'qwen-max' }),
      apiKey: 'sk-bailian-standard',
      credential: {
        keyType: 'dashscope',
        region: 'intl',
        workspaceId: 'ws_SAFE_9',
      },
    }));
    expect(intl.captured[0].url).toBe(
      'https://dashscope-intl.aliyuncs.com/api/v1/workspaces/ws_SAFE_9/compatible-mode/v1/chat/completions',
    );

    await expect(collect(adapter.execute({
      request: baseRequest({ model: 'qwen-max' }),
      apiKey: 'sk-bailian-standard',
      credential: {
        keyType: 'dashscope',
        region: 'https://evil.example',
        workspaceId: 'ws_123ABC',
      },
    }))).rejects.toMatchObject({ code: 'invalid_request', status: 400 });

    await expect(collect(adapter.execute({
      request: baseRequest({ model: 'qwen-max' }),
      apiKey: 'sk-bailian-standard',
      credential: {
        keyType: 'dashscope',
        region: 'cn-beijing',
        workspaceId: '../evil',
      },
    }))).rejects.toMatchObject({ code: 'invalid_request', status: 400 });

    await expect(collect(adapter.execute({
      request: baseRequest({ model: 'qwen-max' }),
      apiKey: 'sk-bailian-standard',
      credential: {
        keyType: 'dashscope',
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      },
    }))).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
  });

  it('enforces DeepSeek policies, maps reasoning effort through capability gate and preserves reasoning_content replay', async () => {
    const fixture = fetchFixture(new Response(jsonSse([
      { id: 'chatcmpl_deepseek', choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { reasoning_content: 'reason' } }] },
      { choices: [{ delta: { content: 'final' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
      '[DONE]',
    ]), { status: 200 }));
    const adapter = new DeepSeekRuntimeAdapter({ transport: new ProviderHttpTransport({ fetch: fixture.fetch }) });

    await expect(collect(adapter.execute({
      request: baseRequest({
        model: 'deepseek-reasoner',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'tool replay answer' }],
            protocolExtensions: { reasoning_content: 'prior reasoning' },
          },
          {
            role: 'tool',
            toolCallId: 'call_1',
            content: [{ type: 'text', text: '{"result":1}' }],
          },
          { role: 'user', content: [{ type: 'text', text: 'continue' }] },
        ],
      }),
      apiKey: 'sk-deepseek',
    }))).resolves.toContainEqual({ type: 'reasoning.delta', text: 'reason' });
    expect(fixture.captured[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
    const replayMessage = fixture.captured[0].body.messages.find((message: Record<string, unknown>) =>
      message.role === 'assistant');
    expect(replayMessage).toMatchObject({
      role: 'assistant',
      content: 'tool replay answer',
      reasoning_content: 'prior reasoning',
    });
    expect(fixture.captured[0].body).toMatchObject({
      reasoning_effort: 'high',
    });

    const max = fetchFixture(new Response(jsonSse(['[DONE]']), { status: 200 }));
    const maxAdapter = new DeepSeekRuntimeAdapter({ transport: new ProviderHttpTransport({ fetch: max.fetch }) });
    await collect(maxAdapter.execute({
      request: baseRequest({
        model: 'deepseek-reasoner',
        reasoning: { effort: 'xhigh' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'think' }] }],
      }),
      apiKey: 'sk-deepseek',
    }));
    expect(max.captured[0].body).toMatchObject({ reasoning_effort: 'max' });

    await expect(collect(maxAdapter.execute({
      request: baseRequest({
        model: 'deepseek-chat',
        reasoning: { effort: 'high' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'think' }] }],
      }),
      apiKey: 'sk-deepseek',
    }))).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: { capability: 'reasoningEffort' },
    });

    const developerFixture = fetchFixture(new Response(jsonSse([
      { id: 'chatcmpl_deepseek_developer', choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { content: 'final' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]), { status: 200 }));
    const developerAdapter = new DeepSeekRuntimeAdapter({
      transport: new ProviderHttpTransport({ fetch: developerFixture.fetch }),
    });
    await expect(collect(developerAdapter.execute({
      request: baseRequest({
        model: 'deepseek-chat',
        instructions: undefined,
        reasoning: undefined,
        messages: [{ role: 'developer', content: [{ type: 'text', text: 'follow the coding policy' }] }],
      }),
      apiKey: 'sk-deepseek',
    }))).resolves.toContainEqual({ type: 'text.delta', text: 'final' });
    expect(developerFixture.captured[0].body.messages).toContainEqual({
      role: 'system',
      content: 'follow the coding policy',
    });

    const toolHistoryFixture = fetchFixture(new Response(jsonSse(['[DONE]']), { status: 200 }));
    const toolHistoryAdapter = new DeepSeekRuntimeAdapter({
      transport: new ProviderHttpTransport({ fetch: toolHistoryFixture.fetch }),
    });
    await collect(toolHistoryAdapter.execute({
      request: baseRequest({
        model: 'deepseek-chat',
        instructions: undefined,
        reasoning: undefined,
        messages: [
          {
            role: 'assistant',
            content: [],
            protocolExtensions: {
              tool_calls: [{
                id: 'call_lookup',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":"xpod"}' },
              }],
            },
          },
          {
            role: 'tool',
            toolCallId: 'call_lookup',
            content: [{ type: 'text', text: 'tool result' }],
          },
        ],
      }),
      apiKey: 'sk-deepseek',
    }));
    expect(toolHistoryFixture.captured[0].body.messages).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_lookup',
          type: 'function',
          function: { name: 'lookup', arguments: '{"q":"xpod"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_lookup', content: 'tool result' },
    ]);

    await expect(collect(adapter.execute({
      request: baseRequest({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'use a tool' }] }],
        protocolExtensions: { chatCompletions: { tool_choice: 'required' } },
      }),
      apiKey: 'sk-deepseek',
    }))).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });

    const insufficientBalance = fetchFixture(() => new Response('insufficient balance sk-deepseek', { status: 402 }));
    const insufficientAdapter = new DeepSeekRuntimeAdapter({ transport: new ProviderHttpTransport({ fetch: insufficientBalance.fetch }) });
    await expect(collect(insufficientAdapter.execute({
      request: baseRequest({
        model: 'deepseek-chat',
        reasoning: undefined,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'balance check' }] }],
      }),
      apiKey: 'sk-deepseek',
    }))).rejects.toMatchObject({
      code: 'provider_error',
      status: 402,
      details: { classification: 'quota_exhausted' },
    });
    await expect(collect(insufficientAdapter.execute({
      request: baseRequest({
        model: 'deepseek-chat',
        reasoning: undefined,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'balance check' }] }],
      }),
      apiKey: 'sk-deepseek',
    }))).rejects.not.toThrow(/sk-deepseek/);
  });

  it('classifies provider HTTP errors per adapter with Retry-After and secret redaction', async () => {
    const factories = [
      { provider: 'openai', adapter: (transport: ProviderHttpTransport) => new OpenAiRuntimeAdapter({ transport }), request: baseRequest({ model: 'gpt-5' }) },
      { provider: 'anthropic', adapter: (transport: ProviderHttpTransport) => new AnthropicRuntimeAdapter({ transport }), request: baseRequest({ model: 'claude-sonnet-4-5-20250929' }) },
      { provider: 'kimi', adapter: (transport: ProviderHttpTransport) => new KimiRuntimeAdapter({ transport }), request: baseRequest({ model: 'kimi-k2' }) },
      { provider: 'bailian', adapter: (transport: ProviderHttpTransport) => new BailianRuntimeAdapter({ transport }), request: baseRequest({ model: 'qwen-max' }) },
      {
        provider: 'deepseek',
        adapter: (transport: ProviderHttpTransport) => new DeepSeekRuntimeAdapter({ transport }),
        request: baseRequest({
          model: 'deepseek-chat',
          reasoning: undefined,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'no image' }] }],
        }),
      },
    ];
    const cases = [
      { status: 401, classification: 'authentication' },
      { status: 403, classification: 'authorization' },
      { status: 429, classification: 'rate_limited' },
      { status: 503, classification: 'upstream_unavailable', retryAfter: '9' },
    ];

    for (const factory of factories) {
      for (const item of cases) {
        const secret = `secret-${factory.provider}-${item.status}`;
        const fixture = fetchFixture(() => new Response(`body leaks ${secret}`, {
          status: item.status,
          headers: item.retryAfter ? { 'Retry-After': item.retryAfter } : {},
        }));
        const adapter = factory.adapter(new ProviderHttpTransport({ fetch: fixture.fetch }));
        await expect(collect(adapter.execute({
          request: factory.request,
          apiKey: secret,
        }))).rejects.toMatchObject({
          code: 'provider_error',
          status: item.status,
          details: {
            classification: item.classification,
            ...(item.retryAfter ? { retryAfter: item.retryAfter } : {}),
          },
        });
        await expect(collect(adapter.execute({
          request: factory.request,
          apiKey: secret,
        }))).rejects.not.toThrow(secret);
      }
    }
  });

  it('redacts secrets from streaming provider errors across native and OpenAI-compatible adapters', async () => {
    const fixture = fetchFixture(() => new Response(jsonSse([
      { type: 'error', error: { type: 'rate_limit_error', message: 'secret is sk-stream-secret' } },
    ]), { status: 200 }));
    const adapter = new AnthropicRuntimeAdapter({ transport: new ProviderHttpTransport({ fetch: fixture.fetch }) });

    await expect(collect(adapter.execute({
      request: baseRequest({ model: 'claude-sonnet-4-5-20250929' }),
      apiKey: 'sk-stream-secret',
    }))).rejects.not.toThrow(/sk-stream-secret/);

    for (const factory of [
      (transport: ProviderHttpTransport) => new KimiRuntimeAdapter({ transport }),
      (transport: ProviderHttpTransport) => new DeepSeekRuntimeAdapter({ transport }),
    ]) {
      const compatibleFixture = fetchFixture(() => new Response(jsonSse([
        { error: { type: 'rate_limit_error', message: 'secret is sk-compatible-secret' } },
      ]), { status: 200 }));
      const compatible = factory(new ProviderHttpTransport({ fetch: compatibleFixture.fetch }));
      await expect(collect(compatible.execute({
        request: baseRequest({
          model: compatible.provider === 'kimi' ? 'kimi-k2' : 'deepseek-chat',
          reasoning: undefined,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'no image' }] }],
        }),
        apiKey: 'sk-compatible-secret',
      }))).rejects.not.toThrow(/sk-compatible-secret/);
    }
  });

  it('reports sanitized diagnostics when both custom runtime protocols fail during automatic detection', async () => {
    const apiKey = 'custom-secret';
    const providerBodies = [
      `openai provider body ${apiKey} https://custom.example/v1/chat/completions`,
      `anthropic provider body ${apiKey} https://custom.example/v1/messages`,
    ];
    let probe = 0;
    const fixture = fetchFixture(() => {
      const status = probe++ === 0 ? 401 : 429;
      return new Response(providerBodies[probe - 1], {
        status,
        statusText: status === 401 ? 'Unauthorized' : 'Too Many Requests',
        headers: { 'content-type': 'application/json' },
      });
    });
    const registry = createDefaultProviderRegistry();
    const adapter = new CustomRuntimeAdapter({
      transport: new ProviderHttpTransport({ fetch: fixture.fetch }),
      descriptor: registry.requireProvider('custom'),
    });

    const error = await collect(adapter.execute({
      request: baseRequest({ model: 'custom-model' }),
      apiKey,
      credential: {
        baseUrl: 'https://custom.example/v1',
        compatibility: 'auto',
      },
    })).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: 'GatewayProtocolError',
      message: 'custom_protocol_detection_failed:openai_and_anthropic',
      code: 'provider_error',
      status: 502,
      details: {
        probes: {
          openai: {
            code: 'provider_error',
            status: 401,
            providerStatusCode: 401,
            classification: 'authentication',
          },
          anthropic: {
            code: 'provider_error',
            status: 429,
            providerStatusCode: 429,
            classification: 'rate_limited',
          },
        },
      },
    });
    expect(error).toBeInstanceOf(GatewayProtocolError);
    expect((error as GatewayProtocolError).details).not.toHaveProperty('probes.openai.body');
    expect((error as GatewayProtocolError).details).not.toHaveProperty('probes.anthropic.body');
    expect(JSON.stringify(error)).not.toContain(apiKey);
    expect(JSON.stringify(error)).not.toContain(providerBodies[0]);
    expect(JSON.stringify(error)).not.toContain(providerBodies[1]);
    expect(JSON.stringify(error)).not.toContain('https://custom.example/v1');
    expect(fixture.captured).toHaveLength(2);
  });

  it('normalizes max output tokens into provider request bodies and preserves unknown protocol extensions', async () => {
    const anthropicFixture = fetchFixture(new Response(jsonSse(['[DONE]']), { status: 200 }));
    const anthropic = new AnthropicRuntimeAdapter({
      transport: new ProviderHttpTransport({ fetch: anthropicFixture.fetch }),
      maxOutputTokensDefault: 2048,
    });
    await collect(anthropic.execute({
      request: baseRequest({
        model: 'claude-sonnet-4-5-20250929',
        maxOutputTokens: 777,
        protocolExtensions: { anthropic: { top_k: 5 } },
      }),
      apiKey: 'sk-ant-secret',
    }));
    expect(anthropicFixture.captured[0].body).toMatchObject({
      max_tokens: 777,
      top_k: 5,
    });

    const defaultFixture = fetchFixture(new Response(jsonSse(['[DONE]']), { status: 200 }));
    const defaultAnthropic = new AnthropicRuntimeAdapter({
      transport: new ProviderHttpTransport({ fetch: defaultFixture.fetch }),
      maxOutputTokensDefault: 4096,
    });
    await collect(defaultAnthropic.execute({
      request: baseRequest({ model: 'claude-sonnet-4-5-20250929', maxOutputTokens: undefined }),
      apiKey: 'sk-ant-secret',
    }));
    expect(defaultFixture.captured[0].body.max_tokens).toBe(4096);

    const bailianCoding = fetchFixture(new Response(jsonSse(['[DONE]']), { status: 200 }));
    const bailian = new BailianRuntimeAdapter({
      transport: new ProviderHttpTransport({ fetch: bailianCoding.fetch }),
      maxOutputTokensDefault: 1234,
    });
    await collect(bailian.execute({
      request: baseRequest({
        model: 'qwen-coder-plus',
        maxOutputTokens: undefined,
      }),
      apiKey: 'sk-sp-bailian',
      credential: {
        keyType: 'codingPlan',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      },
    }));
    expect(bailianCoding.captured[0].body.max_tokens).toBe(1234);
  });

  it('cancels the SSE reader when a consumer returns early', async () => {
    let canceled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"ok":true}\n\n'));
      },
      cancel() {
        canceled = true;
      },
    });

    const iterator = parseSseStream(stream)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { data: '{"ok":true}' },
    });
    await iterator.return?.();
    expect(canceled).toBe(true);
  });

  it('passes AbortSignal to upstream fetch and rejects unsafe configured provider endpoints', async () => {
    const controller = new AbortController();
    const fixture = fetchFixture(new Response(jsonSse(['[DONE]']), { status: 200 }));
    const adapter = new OpenAiRuntimeAdapter({ transport: new ProviderHttpTransport({ fetch: fixture.fetch }) });

    await collect(adapter.execute({
      request: baseRequest({ model: 'gpt-5' }),
      apiKey: 'sk-openai-secret',
      signal: controller.signal,
    }));
    expect(fixture.captured[0].init.signal).toBeInstanceOf(AbortSignal);
    expect((fixture.captured[0].init.signal as AbortSignal).aborted).toBe(false);

    await expect(collect(adapter.execute({
      request: baseRequest({ model: 'gpt-5' }),
      apiKey: 'sk-openai-secret',
      credential: { baseUrl: 'https://evil.example/v1' },
    }))).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });
  });

  it('normalizes an OpenAI-compatible root URL to the v1 chat endpoint', async () => {
    const fixture = fetchFixture(new Response(jsonSse([
      { id: 'chatcmpl_custom', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]), { status: 200 }));
    const adapter = new OpenAiCompatibleRuntimeAdapter({
      provider: 'custom',
      defaultBaseUrl: 'https://timicc.com/v1',
      safeBaseUrls: ['https://timicc.com/v1'],
      transport: new ProviderHttpTransport({ fetch: fixture.fetch }),
    });

    await expect(collect(adapter.execute({
      request: baseRequest({ model: 'gpt-4o-compatible' }),
      apiKey: 'sk-custom-secret',
      credential: { baseUrl: 'https://timicc.com' },
    }))).resolves.toContainEqual({ type: 'text.delta', text: 'ok' });

    expect(fixture.captured[0].url).toBe('https://timicc.com/v1/chat/completions');
  });

  it('accepts only HTTP proxy URLs for provider transport configuration', () => {
    expect(normalizeProviderProxyUrl(' https://proxy.example.test:8443/ ')).toBe('https://proxy.example.test:8443');
    expect(() => normalizeProviderProxyUrl('socks5://proxy.example.test:1080')).toThrow('invalid_proxy_url');
  });
});
