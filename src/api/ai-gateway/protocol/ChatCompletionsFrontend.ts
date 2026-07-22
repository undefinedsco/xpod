import {
  booleanValue,
  extractExtension,
  extractText,
  type GatewayEvent,
  type GatewayEventSerializer,
  type GatewayMessage,
  type GatewayProtocolFrontend,
  type GatewayRequest,
  mapGatewayUsageToChatCompletions,
  normalizeMessage,
  normalizeToolFromChat,
  requireObject,
  stringOrUndefined,
  ToolArgumentTracker,
  unsupportedEvent,
} from '../types';

const CHAT_COMPLETIONS_NORMALIZED_KEYS = [
  'model',
  'messages',
  'tools',
  'reasoning_effort',
  'stream',
] as const;

export class ChatCompletionsFrontend implements GatewayProtocolFrontend {
  public readonly protocol = 'chatCompletions' as const;

  public parseRequest(body: unknown): GatewayRequest {
    const record = requireObject(body, 'Chat Completions request');
    const normalizedMessages = Array.isArray(record.messages)
      ? record.messages.map((message) => normalizeMessage(message, this.protocol)).filter((message) => message !== undefined)
      : [];
    const instructions = normalizedMessages
      .filter((message) => message.role === 'system' || message.role === 'developer')
      .map((message) => extractText(message.content.map((part) => part.type === 'text' ? { text: part.text } : undefined)))
      .filter((item): item is string => !!item)
      .join('\n');
    const messages = normalizedMessages
      .filter((message): message is GatewayMessage => message.role !== 'system' && message.role !== 'developer');

    return {
      model: stringOrUndefined(record.model) ?? '',
      instructions: instructions || undefined,
      messages,
      tools: Array.isArray(record.tools)
        ? record.tools.map(normalizeToolFromChat).filter((tool) => tool !== undefined)
        : [],
      reasoning: record.reasoning_effort === undefined
        ? undefined
        : { effort: String(record.reasoning_effort) },
      stream: booleanValue(record.stream),
      protocolExtensions: extractExtension(record, this.protocol, CHAT_COMPLETIONS_NORMALIZED_KEYS),
    };
  }

  public createEventSerializer(): GatewayEventSerializer {
    return new ChatCompletionsEventSerializer();
  }
}

class ChatCompletionsEventSerializer implements GatewayEventSerializer {
  private readonly toolArguments = new ToolArgumentTracker();

  public serializeEvent(event: GatewayEvent): Record<string, unknown> {
    switch (event.type) {
      case 'response.started':
        this.toolArguments.reset();
        return { id: event.id, choices: [{ index: 0, delta: { role: 'assistant' } }] };
      case 'text.delta':
        return { choices: [{ index: 0, delta: { content: event.text } }] };
      case 'reasoning.delta':
        return { choices: [{ index: 0, delta: { reasoning_content: event.text } }] };
      case 'tool.started': {
        const index = this.toolArguments.start(event.callId);
        return {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index,
                id: event.callId,
                type: 'function',
                function: { name: event.name, arguments: '' },
              }],
            },
          }],
        };
      }
      case 'tool.arguments.delta': {
        const index = this.toolArguments.append(event.callId, event.delta);
        return {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index,
                function: { arguments: event.delta },
              }],
            },
          }],
        };
      }
      case 'tool.completed':
        this.toolArguments.complete(event.callId);
        return { choices: [{ index: 0, delta: {} }] };
      case 'usage':
        return { usage: mapGatewayUsageToChatCompletions(event.usage) };
      case 'response.completed':
        this.toolArguments.reset();
        return { choices: [{ index: 0, delta: {}, finish_reason: event.finishReason }] };
      default:
        return unsupportedEvent(event);
    }
  }
}
