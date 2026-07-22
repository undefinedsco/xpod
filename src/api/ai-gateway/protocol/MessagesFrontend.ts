import {
  booleanValue,
  extractExtension,
  extractText,
  type GatewayEvent,
  type GatewayEventSerializer,
  type GatewayProtocolFrontend,
  type GatewayRequest,
  mapGatewayUsageToAnthropic,
  normalizeMessage,
  normalizeToolFromAnthropic,
  requireObject,
  stringOrUndefined,
  ToolArgumentTracker,
  unsupportedEvent,
} from '../types';

const MESSAGES_NORMALIZED_KEYS = [
  'model',
  'system',
  'messages',
  'tools',
  'thinking',
  'stream',
  'max_tokens',
] as const;

export class MessagesFrontend implements GatewayProtocolFrontend {
  public readonly protocol = 'anthropic' as const;

  public parseRequest(body: unknown): GatewayRequest {
    const record = requireObject(body, 'Messages request');
    const thinking = record.thinking && typeof record.thinking === 'object'
      ? record.thinking as Record<string, unknown>
      : undefined;

    return {
      model: stringOrUndefined(record.model) ?? '',
      instructions: extractText(record.system),
      messages: Array.isArray(record.messages)
        ? record.messages.map((message) => normalizeMessage(message, this.protocol)).filter((message) => message !== undefined)
        : [],
      tools: Array.isArray(record.tools)
        ? record.tools.map(normalizeToolFromAnthropic).filter((tool) => tool !== undefined)
        : [],
      reasoning: thinking
        ? {
            effort: thinking.budget_tokens === undefined ? undefined : String(thinking.budget_tokens),
          }
        : undefined,
      stream: booleanValue(record.stream),
      protocolExtensions: extractExtension(record, this.protocol, MESSAGES_NORMALIZED_KEYS),
    };
  }

  public createEventSerializer(): GatewayEventSerializer {
    return new MessagesEventSerializer();
  }
}

class MessagesEventSerializer implements GatewayEventSerializer {
  private readonly toolArguments = new ToolArgumentTracker();

  public serializeEvent(event: GatewayEvent): Record<string, unknown> {
    switch (event.type) {
      case 'response.started':
        this.toolArguments.reset();
        return { type: 'message_start', message: { id: event.id, type: 'message', role: 'assistant' } };
      case 'text.delta':
        return { type: 'content_block_delta', delta: { type: 'text_delta', text: event.text }, index: 0 };
      case 'reasoning.delta':
        return { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: event.text }, index: 0 };
      case 'tool.started': {
        const index = this.toolArguments.start(event.callId);
        return {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: event.callId, name: event.name, input: {} },
        };
      }
      case 'tool.arguments.delta': {
        const index = this.toolArguments.append(event.callId, event.delta);
        return {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: event.delta },
          index,
        };
      }
      case 'tool.completed': {
        const index = this.toolArguments.complete(event.callId);
        return { type: 'content_block_stop', index };
      }
      case 'usage':
        return { type: 'message_delta', usage: mapGatewayUsageToAnthropic(event.usage) };
      case 'response.completed':
        this.toolArguments.reset();
        return { type: 'message_stop', stop_reason: event.finishReason };
      default:
        return unsupportedEvent(event);
    }
  }
}
