import { describe, expect, it } from 'vitest';

import { GatewayProtocolError } from '../../../src/api/ai-gateway/errors';
import type { GatewayEvent, GatewayRequest } from '../../../src/api/ai-gateway/types';
import { AnthropicRuntimeAdapter } from '../../../src/api/ai-gateway/providers/AnthropicRuntimeAdapter';
import { BailianRuntimeAdapter } from '../../../src/api/ai-gateway/providers/BailianRuntimeAdapter';
import { DeepSeekRuntimeAdapter } from '../../../src/api/ai-gateway/providers/DeepSeekRuntimeAdapter';
import { KimiRuntimeAdapter } from '../../../src/api/ai-gateway/providers/KimiRuntimeAdapter';
import { OpenAiRuntimeAdapter } from '../../../src/api/ai-gateway/providers/OpenAiRuntimeAdapter';
import { ProviderHttpTransport } from '../../../src/api/service/provider-http-transport';

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

function fetchFixture(response: Response): { fetch: typeof fetch; captured: CapturedRequest[] } {
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
      return response;
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
  it('streams OpenAI Responses events without buffering and preserves tools, reasoning, usage and image input', async () => {
    const fixture = fetchFixture(new Response(jsonSse([
      { type: 'response.created', response: { id: 'resp_openai' } },
      { type: 'response.output_text.delta', delta: 'hel' },
      { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', call_id: 'call_1', name: 'lookup' },
      },
      { type: 'response.function_call_arguments.delta', call_id: 'call_1', delta: '{"q":' },
      { type: 'response.function_call_arguments.delta', call_id: 'call_1', delta: '"xpod"}' },
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1' } },
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
  });

  it('handles Kimi OpenAI-compatible chat deltas, reasoning effort policy and upstream error classification', async () => {
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
    const adapter = new KimiRuntimeAdapter({ transport: new ProviderHttpTransport({ fetch: fixture.fetch }) });

    await expect(collect(adapter.execute({
      request: baseRequest({ model: 'kimi-k2', reasoning: { effort: 'high' } }),
      apiKey: 'sk-kimi-secret',
    }))).resolves.toContainEqual({ type: 'reasoning.delta', text: 'think' });
    expect(fixture.captured[0].url).toBe('https://api.moonshot.ai/v1/chat/completions');
    expect(fixture.captured[0].headers.get('Authorization')).toBe('Bearer sk-kimi-secret');
    expect(fixture.captured[0].body).toMatchObject({
      model: 'kimi-k2',
      reasoning_effort: 'high',
    });
    expect(fixture.captured[0].body.messages[0]).toEqual({
      role: 'system',
      content: 'Use strict JSON when tools are called.',
    });

    const rateLimit = fetchFixture(new Response('do not leak sk-kimi-secret', {
      status: 429,
      headers: { 'Retry-After': '12' },
    }));
    const rateLimitAdapter = new KimiRuntimeAdapter({ transport: new ProviderHttpTransport({ fetch: rateLimit.fetch }) });
    await expect(collect(rateLimitAdapter.execute({
      request: baseRequest({ model: 'kimi-k2' }),
      apiKey: 'sk-kimi-secret',
    }))).rejects.toMatchObject({
      code: 'provider_error',
      status: 429,
      details: { retryAfter: '12', providerStatusCode: 429 },
    });
    await expect(collect(rateLimitAdapter.execute({
      request: baseRequest({ model: 'kimi-k2' }),
      apiKey: 'sk-kimi-secret',
    }))).rejects.not.toThrow(/sk-kimi-secret/);
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
      apiKey: 'cp-bailian',
      credential: {
        keyType: 'codingPlan',
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      },
    }));
    expect(codingPlan.captured[0].url).toBe('https://dashscope.aliyuncs.com/api/v1/messages');
    expect(codingPlan.captured[0].headers.get('x-api-key')).toBe('cp-bailian');

    await expect(collect(adapter.execute({
      request: baseRequest({ model: 'qwen-max' }),
      apiKey: 'cp-bailian',
      credential: { keyType: 'codingPlan' },
    }))).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });
  });

  it('enforces DeepSeek policies, maps 402 quota errors and preserves reasoning_content across tool replay', async () => {
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
      reasoning_effort: 'medium',
    });

    await expect(collect(adapter.execute({
      request: baseRequest({
        model: 'deepseek-chat',
        messages: [{ role: 'developer', content: [{ type: 'text', text: 'not supported' }] }],
      }),
      apiKey: 'sk-deepseek',
    }))).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });

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

    const insufficientBalance = fetchFixture(new Response('insufficient balance sk-deepseek', { status: 402 }));
    const insufficientAdapter = new DeepSeekRuntimeAdapter({ transport: new ProviderHttpTransport({ fetch: insufficientBalance.fetch }) });
    await expect(collect(insufficientAdapter.execute({
      request: baseRequest({
        model: 'deepseek-chat',
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
        messages: [{ role: 'user', content: [{ type: 'text', text: 'balance check' }] }],
      }),
      apiKey: 'sk-deepseek',
    }))).rejects.not.toThrow(/sk-deepseek/);
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
    expect(fixture.captured[0].init.signal).toBe(controller.signal);

    await expect(collect(adapter.execute({
      request: baseRequest({ model: 'gpt-5' }),
      apiKey: 'sk-openai-secret',
      credential: { baseUrl: 'https://evil.example/v1' },
    }))).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });
  });
});
