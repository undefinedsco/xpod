import { expect, it } from 'vitest';
import { parseOpenAiResponsesSse } from '../../../src/api/ai-gateway/providers/ProviderRuntimeAdapter';
import { ResponsesFrontend } from '../../../src/api/ai-gateway/protocol/ResponsesFrontend';
import { ChatCompletionsFrontend } from '../../../src/api/ai-gateway/protocol/ChatCompletionsFrontend';
import type { GatewayEvent } from '../../../src/api/ai-gateway/types';

async function collect(payloads: Array<Record<string, unknown>>, secret?: string): Promise<GatewayEvent[]> {
  async function* source() {
    for (const payload of payloads) yield { data: JSON.stringify(payload) };
  }
  const result: GatewayEvent[] = [];
  for await (const event of parseOpenAiResponsesSse(source(), secret)) result.push(event);
  return result;
}

function chatFinish(events: GatewayEvent[]): unknown {
  const serializer = new ChatCompletionsFrontend().createEventSerializer();
  const chunks = events.flatMap<Record<string, unknown>>(event => serializer.serializeEvent(event));
  return chunks.flatMap(chunk => (chunk.choices ?? []) as Array<{ finish_reason?: unknown }>)
    .filter(choice => choice.finish_reason !== undefined).map(choice => choice.finish_reason);
}

it('projects successful Responses text as the Chat Completions stop reason', async () => {
  const events = await collect([
    { type: 'response.created', response: { id: 'response-text' } },
    { type: 'response.output_text.delta', delta: 'actual answer' },
    { type: 'response.completed', response: { status: 'completed' } },
  ]);
  expect(events).toContainEqual({ type: 'text.delta', text: 'actual answer' });
  expect(chatFinish(events)).toEqual(['stop']);
});

it('projects a completed function call as tool_calls rather than a response status', async () => {
  const events = await collect([
    { type: 'response.created', response: { id: 'response-tool' } },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'lookup' } },
    { type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '{}' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'item-1', call_id: 'call-1' } },
    { type: 'response.completed', response: { status: 'completed' } },
  ]);
  expect(events).toContainEqual({ type: 'tool.completed', callId: 'call-1' });
  expect(chatFinish(events)).toEqual(['tool_calls']);
});

it.each([['max_output_tokens', 'length'], ['content_filter', 'content_filter']])(
  'preserves incomplete Responses outcome %s without reporting a successful stop', async (reason, finish) => {
    const events = await collect([
      { type: 'response.created', response: { id: 'response-incomplete' } },
      { type: 'response.output_text.delta', delta: 'partial answer' },
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason },
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } },
    ]);
    expect(chatFinish(events)).toEqual([finish]);
    const responses = new ResponsesFrontend().createEventSerializer();
    const terminal = events.flatMap<Record<string, unknown>>(event => responses.serializeEvent(event)).filter(event => event.type === 'response.incomplete');
    expect(terminal).toEqual([{ type: 'response.incomplete', response: { id: 'response-incomplete', status: 'incomplete',
      incomplete_details: { reason }, finish_reason: finish } }]);
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } });
  },
);

it('rejects a failed Responses terminal event and redacts the configured secret', async () => {
  await expect(collect([
    { type: 'response.created', response: { id: 'response-failed' } },
    { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error',
      message: 'upstream rejected fixture-secret' } } },
  ], 'fixture-secret')).rejects.toMatchObject({ code: 'provider_error', status: 502 });
  await expect(collect([
    { type: 'response.failed', response: { error: { message: 'fixture-secret' } } },
  ], 'fixture-secret')).rejects.not.toThrow('fixture-secret');
});

it('resets tool-call termination state for a subsequent response in the stream', async () => {
  const events = await collect([
    { type: 'response.created', response: { id: 'response-one' } },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'lookup' } },
    { type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '{}' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'item-1', call_id: 'call-1' } },
    { type: 'response.completed', response: { status: 'completed' } },
    { type: 'response.created', response: { id: 'response-two' } },
    { type: 'response.output_text.delta', delta: 'answer' },
    { type: 'response.completed', response: { status: 'completed' } },
  ]);
  expect(chatFinish(events)).toEqual(['tool_calls', 'stop']);
});
