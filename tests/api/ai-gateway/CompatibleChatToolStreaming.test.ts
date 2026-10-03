import { streamOpenAICompletions, type Model, type Tool } from '@mariozechner/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatCompletionsFrontend } from '../../../src/api/ai-gateway/protocol/ChatCompletionsFrontend';
import { parseCompatibleChatSse, toChatCompletionsBody } from '../../../src/api/ai-gateway/providers/ProviderRuntimeAdapter';
import type { GatewayEvent } from '../../../src/api/ai-gateway/types';

const approval = {
  target: 'https://pod.example/workspace/marker.txt',
  action: 'http://www.w3.org/ns/odrl/2/write',
  risk: 'low',
  description: 'Write one marker line',
};
const parameters = {
  type: 'object',
  properties: Object.fromEntries(Object.keys(approval).map(key => [key, { type: 'string' }])),
  required: Object.keys(approval),
  additionalProperties: false,
} as const;

async function* toolResponse(id: string | undefined, repeatedRole: boolean) {
  yield { data: JSON.stringify({ id, choices: [{ delta: {
    role: 'assistant',
    tool_calls: [{ index: 0, id: 'call_approval', type: 'function', function: { name: 'request_approval' } }],
  } }] }) };
  // Compatible providers may repeat the same role and response ID on every delta.
  // Continuation chunks identify a tool by index only, without its ID or name.
  for (const fragment of JSON.stringify(approval).match(/.{1,7}/gu) ?? []) {
    yield { data: JSON.stringify({ id, choices: [{ delta: {
      ...(repeatedRole ? { role: 'assistant' } : {}),
      tool_calls: [{ index: 0, function: { arguments: fragment } }],
    } }] }) };
  }
  yield { data: JSON.stringify({ id, choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('Compatible Chat tool streaming through the Pi SDK', () => {
  it.each([
    { repeatedRole: false, responseId: 'response_1' },
    { repeatedRole: true, responseId: 'response_1' },
    { repeatedRole: true, responseId: undefined },
  ])('preserves required arguments (repeatedRole=$repeatedRole, responseId=$responseId)', async ({ repeatedRole, responseId }) => {
    const frontend = new ChatCompletionsFrontend();
    const serializer = frontend.createEventSerializer();
    const events: GatewayEvent[] = [];
    const chunks: Record<string, unknown>[] = [];
    for await (const event of parseCompatibleChatSse(toolResponse(responseId, repeatedRole))) {
      events.push(event);
      const serialized = serializer.serializeEvent(event);
      chunks.push(...(Array.isArray(serialized) ? serialized : [serialized]));
    }
    let forwardedTools: unknown;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = frontend.parseRequest(JSON.parse(String(init?.body)));
      forwardedTools = toChatCompletionsBody(request, {}).tools;
      return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    }));
    const model: Model<'openai-completions'> = {
      id: 'synthetic-model', name: 'Synthetic model', api: 'openai-completions', provider: 'custom',
      baseUrl: 'https://gateway.example/v1', reasoning: false, input: ['text'],
      contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const result = await streamOpenAICompletions(model, {
      messages: [{ role: 'user', content: 'Request approval.', timestamp: 0 }],
      // The runtime supplies JSON Schema directly; Pi's transport preserves that schema.
      tools: [{ name: 'request_approval', description: 'Request approval', parameters: parameters as unknown as Tool['parameters'] }],
    }, { apiKey: 'synthetic-key' }).result();

    expect(result.stopReason).toBe('toolUse');
    expect(result.content).toEqual([{ type: 'toolCall', id: 'call_approval', name: 'request_approval', arguments: approval }]);
    expect(events.filter(event => event.type === 'response.started')).toHaveLength(responseId ? 1 : 0);
    expect(events.filter(event => event.type === 'tool.completed')).toHaveLength(1);
    expect(forwardedTools).toEqual([{ type: 'function', function: { name: 'request_approval', description: 'Request approval', parameters } }]);
  });

  it('starts fresh tool state when a subsequent response has a different identity', async () => {
    async function* responses() {
      yield* toolResponse('response_1', true);
      yield* toolResponse('response_2', true);
    }
    const events: GatewayEvent[] = [];
    for await (const event of parseCompatibleChatSse(responses())) events.push(event);
    expect(events.filter(event => event.type === 'response.started')).toEqual([
      { type: 'response.started', id: 'response_1' },
      { type: 'response.started', id: 'response_2' },
    ]);
    expect(events.filter(event => event.type === 'tool.completed')).toHaveLength(2);
  });
});
