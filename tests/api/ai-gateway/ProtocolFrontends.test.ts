import { describe, expect, it } from 'vitest';
import {
  ChatCompletionsFrontend,
  MessagesFrontend,
  ResponsesFrontend,
} from '../../../src/api/ai-gateway/protocol';
import { GatewayProtocolError } from '../../../src/api/ai-gateway/errors';
import type { GatewayEvent } from '../../../src/api/ai-gateway/types';

describe('AI Gateway protocol frontends', () => {
  it('parses OpenAI Responses requests into the common contract without dropping native fields', () => {
    const request = new ResponsesFrontend().parseRequest({
      model: 'gpt-5.1',
      instructions: 'Be precise.',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Describe this image' },
            { type: 'input_image', image_url: 'https://example.test/image.png', detail: 'high' },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Lookup a value',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      ],
      reasoning: { effort: 'high', summary: 'auto' },
      previous_response_id: 'resp_previous',
      stream: true,
      store: false,
      metadata: { project: 'xpod' },
    });

    expect(request).toMatchObject({
      model: 'gpt-5.1',
      instructions: 'Be precise.',
      stream: true,
      previousResponseId: 'resp_previous',
      reasoning: { effort: 'high', exposeSummary: true },
    });
    expect(request.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image' },
        { type: 'image', imageUrl: 'https://example.test/image.png', detail: 'high' },
      ],
    });
    expect(request.tools[0]).toMatchObject({
      type: 'function',
      name: 'lookup',
      inputSchema: { type: 'object' },
    });
    expect(request.protocolExtensions.responses).toEqual({
      store: false,
      metadata: { project: 'xpod' },
    });
  });

  it('parses Anthropic Messages requests and preserves Anthropic-only fields', () => {
    const request = new MessagesFrontend().parseRequest({
      model: 'claude-sonnet-4.5',
      system: [{ type: 'text', text: 'Use terse output.' }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this file?' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'iVBORw0KGgo=',
              },
            },
          ],
        },
      ],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          input_schema: { type: 'object', required: ['path'] },
        },
      ],
      thinking: { type: 'enabled', budget_tokens: 4096 },
      stream: true,
      top_k: 5,
    });

    expect(request.model).toBe('claude-sonnet-4.5');
    expect(request.instructions).toBe('Use terse output.');
    expect(request.reasoning).toEqual({ effort: '4096' });
    expect(request.messages[0].content).toEqual([
      { type: 'text', text: 'What is in this file?' },
      {
        type: 'image',
        mediaType: 'image/png',
        data: 'iVBORw0KGgo=',
      },
    ]);
    expect(request.tools[0]).toMatchObject({
      type: 'function',
      name: 'read_file',
      inputSchema: { type: 'object', required: ['path'] },
    });
    expect(request.protocolExtensions.anthropic).toEqual({ top_k: 5 });
  });

  it('parses Chat Completions requests with developer/system messages, images, tools and native extensions', () => {
    const request = new ChatCompletionsFrontend().parseRequest({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'System instruction.' },
        { role: 'developer', content: 'Developer instruction.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'low' } },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'inspect',
            description: 'Inspect an image',
            parameters: { type: 'object', properties: { image: { type: 'string' } } },
          },
        },
      ],
      reasoning_effort: 'medium',
      stream: true,
      parallel_tool_calls: true,
      response_format: { type: 'json_object' },
    });

    expect(request).toMatchObject({
      model: 'deepseek-chat',
      instructions: 'System instruction.\nDeveloper instruction.',
      stream: true,
      reasoning: { effort: 'medium' },
    });
    expect(request.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'inspect' },
          { type: 'image', imageUrl: 'data:image/png;base64,abc', detail: 'low' },
        ],
      },
    ]);
    expect(request.tools[0]).toMatchObject({
      type: 'function',
      name: 'inspect',
      inputSchema: { type: 'object' },
    });
    expect(request.protocolExtensions.chatCompletions).toEqual({
      parallel_tool_calls: true,
      response_format: { type: 'json_object' },
    });
  });

  it('serializes gateway events for each native protocol and validates completed tool arguments only', () => {
    const events: GatewayEvent[] = [
      { type: 'response.started', id: 'resp_1' },
      { type: 'text.delta', text: '{"not buffered text"' },
      { type: 'reasoning.delta', text: 'reasoning chunk' },
      { type: 'tool.started', callId: 'call_1', name: 'lookup' },
      { type: 'tool.arguments.delta', callId: 'call_1', delta: '{"q":' },
      { type: 'tool.arguments.delta', callId: 'call_1', delta: '"xpod"}' },
      { type: 'tool.completed', callId: 'call_1' },
      {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 7,
          totalTokens: 17,
          cacheReadTokens: 3,
        },
      },
      { type: 'response.completed', finishReason: 'stop' },
    ];

    const responses = new ResponsesFrontend();
    const messages = new MessagesFrontend();
    const chat = new ChatCompletionsFrontend();

    expect(events.map((event) => responses.serializeEvent(event))).toEqual([
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_text.delta', delta: '{"not buffered text"' },
      { type: 'response.reasoning_summary_text.delta', delta: 'reasoning chunk' },
      { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_1', name: 'lookup' } },
      { type: 'response.function_call_arguments.delta', call_id: 'call_1', delta: '{"q":' },
      { type: 'response.function_call_arguments.delta', call_id: 'call_1', delta: '"xpod"}' },
      { type: 'response.output_item.done', call_id: 'call_1' },
      {
        type: 'response.usage',
        usage: {
          input_tokens: 10,
          output_tokens: 7,
          total_tokens: 17,
          input_tokens_details: { cached_tokens: 3 },
        },
      },
      { type: 'response.completed', response: { status: 'completed', finish_reason: 'stop' } },
    ]);

    expect(events.map((event) => messages.serializeEvent(event))).toContainEqual({
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json: '{"q":' },
      index: 0,
    });
    expect(events.map((event) => chat.serializeEvent(event))).toContainEqual({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '' },
              },
            ],
          },
        },
      ],
    });

    const invalid = new ChatCompletionsFrontend();
    invalid.serializeEvent({ type: 'tool.started', callId: 'bad_call', name: 'bad' });
    invalid.serializeEvent({ type: 'tool.arguments.delta', callId: 'bad_call', delta: '{"broken":' });
    expect(() => invalid.serializeEvent({ type: 'tool.completed', callId: 'bad_call' }))
      .toThrow(GatewayProtocolError);
  });
});
