import { expect, it } from 'vitest';
import { ChatCompletionsFrontend } from '../../src/api/ai-gateway/protocol/ChatCompletionsFrontend';
import { ResponsesFrontend } from '../../src/api/ai-gateway/protocol/ResponsesFrontend';
import { MessagesFrontend } from '../../src/api/ai-gateway/protocol/MessagesFrontend';
import type { GatewayEvent, GatewayProtocolFrontend } from '../../src/api/ai-gateway/types';
import { CHAT_ACCEPTANCE_MAX_OUTPUT_TOKENS, chatCompletionBodyMatches, streamedChatBodyMatches } from '../../scripts/helpers/chat-acceptance';

const marker = 'XPOD_OK';
const protocols: GatewayProtocolFrontend[] = [new ChatCompletionsFrontend(), new ResponsesFrontend(), new MessagesFrontend()];
function stream(frontend: GatewayProtocolFrontend, events: GatewayEvent[]): string {
  const serializer = frontend.createEventSerializer();
  return events.flatMap(event => [serializer.serializeEvent(event)].flat()).map(event => 'data: ' + JSON.stringify(event)).join('\n\n');
}
it('uses a bounded budget that covers the observed reasoning-model response', () => {
  expect(CHAT_ACCEPTANCE_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(512);
  expect(CHAT_ACCEPTANCE_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(1024);
});
it('requires a completed JSON assistant response, not reasoning or a truncated answer', () => {
  const body = (content: unknown, finish_reason: string) => ({ choices: [{ message: { content, reasoning_content: marker }, finish_reason }] });
  expect(chatCompletionBodyMatches(body(marker, 'stop'), marker)).toBe(true);
  for (const value of [body(marker, 'length'), body(null, 'stop'), body('other', 'stop'), {}, { error: marker }]) {
    expect(chatCompletionBodyMatches(value, marker)).toBe(false);
  }
});
it.each(protocols)('checks actual $protocol serializer output without accepting reasoning or incomplete streams', frontend => {
  const started: GatewayEvent = { type: 'response.started', id: 'acceptance' };
  const text: GatewayEvent = { type: 'text.delta', text: marker };
  const completed: GatewayEvent = { type: 'response.completed', finishReason: 'stop' };
  const matches = (events: GatewayEvent[]) => streamedChatBodyMatches(stream(frontend, events), frontend.protocol, marker);
  expect(matches([started, text, completed])).toBe(true);
  expect(matches([started, { type: 'reasoning.delta', text: marker }, completed])).toBe(false);
  expect(matches([started, text])).toBe(false);
  expect(matches([started, text, { type: 'response.completed', finishReason: 'length' }])).toBe(false);
  expect(streamedChatBodyMatches(stream(frontend, [started, text, completed]) + '\ndata: {"type":"error"}', frontend.protocol, marker)).toBe(false);
});


it('accepts standard terminal events and rejects malformed or mixed-protocol evidence', () => {
  const data = (...events: unknown[]) => events.map(event => 'data: ' + JSON.stringify(event)).join('\n');
  expect(streamedChatBodyMatches(data(
    { type: 'content_block_delta', delta: { type: 'text_delta', text: marker } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
  ), 'anthropic', marker)).toBe(true);
  expect(streamedChatBodyMatches(data({ type: 'response.output_text.delta', delta: marker },
    { type: 'response.completed', response: { status: 'completed' } }), 'responses', marker)).toBe(true);
  expect(streamedChatBodyMatches(data({ type: 'response.output_text.delta', delta: marker },
    { type: 'response.incomplete', response: { status: 'incomplete' } }), 'responses', marker)).toBe(false);
  expect(streamedChatBodyMatches(data({ type: 'response.output_text.delta', delta: marker },
    { type: 'response.completed', response: { status: 'completed' } }), 'chatCompletions', marker)).toBe(false);
  expect(streamedChatBodyMatches('data: invalid-json', 'chatCompletions', marker)).toBe(false);
  expect(chatCompletionBodyMatches({ choices: [{ message: { content: [{ type: 'text', text: marker }] }, finish_reason: 'stop' }] }, marker)).toBe(true);
});
