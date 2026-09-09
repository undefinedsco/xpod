import {
  booleanValue,
  extractExtension,
  extractText,
  type GatewayEvent,
  type GatewayEventSerializer,
  type GatewayMessage,
  type GatewayProtocolFrontend,
  type GatewayRequest,
  mapGatewayUsageToAnthropic,
  normalizeContentParts,
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
        ? record.messages.flatMap(normalizeAnthropicMessage)
        : [],
      tools: Array.isArray(record.tools)
        ? record.tools.map(normalizeToolFromAnthropic).filter((tool) => tool !== undefined)
        : [],
      reasoning: thinking
        ? {
            effort: thinking.budget_tokens === undefined ? undefined : String(thinking.budget_tokens),
        }
        : undefined,
      maxOutputTokens: numberOrUndefined(record.max_tokens),
      stream: booleanValue(record.stream),
      protocolExtensions: extractExtension(record, this.protocol, MESSAGES_NORMALIZED_KEYS),
    };
  }

  public createEventSerializer(): GatewayEventSerializer {
    return new MessagesEventSerializer();
  }
}

function normalizeAnthropicMessage(message: unknown): GatewayMessage[] {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return [];
  const record = message as Record<string, unknown>;
  const role = stringOrUndefined(record.role);
  const content = Array.isArray(record.content) ? record.content : undefined;
  if (!role || !content) {
    const normalized = normalizeMessage(message, 'anthropic');
    return normalized ? [normalized] : [];
  }

  const ordinaryContent = content.filter((part) => {
    if (!part || typeof part !== 'object') return true;
    const type = (part as Record<string, unknown>).type;
    return type !== 'tool_use' && type !== 'tool_result';
  });
  const messages: GatewayMessage[] = [];
  const normalizedContent = normalizeContentParts(ordinaryContent, 'anthropic');

  if (role === 'assistant') {
    const toolCalls = content.flatMap((part) => {
      if (!part || typeof part !== 'object') return [];
      const toolUse = part as Record<string, unknown>;
      if (toolUse.type !== 'tool_use') return [];
      const id = stringOrUndefined(toolUse.id);
      const name = stringOrUndefined(toolUse.name);
      if (!id || !name) return [];
      return [{
        id,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(
            toolUse.input && typeof toolUse.input === 'object' ? toolUse.input : {},
          ),
        },
      }];
    });
    messages.push({
      role: 'assistant',
      content: normalizedContent,
      ...(toolCalls.length > 0 ? { protocolExtensions: { tool_calls: toolCalls } } : {}),
    });
    return messages;
  }

  if (role === 'user') {
    let ordinaryContentChunk: unknown[] = [];
    const flushOrdinaryContent = (): void => {
      const chunk = normalizeContentParts(ordinaryContentChunk, 'anthropic');
      if (chunk.length > 0) {
        messages.push({ role: 'user', content: chunk });
      }
      ordinaryContentChunk = [];
    };

    for (const part of content) {
      if (!part || typeof part !== 'object') {
        ordinaryContentChunk.push(part);
        continue;
      }
      const toolResult = part as Record<string, unknown>;
      if (toolResult.type !== 'tool_result') {
        ordinaryContentChunk.push(part);
        continue;
      }
      const callId = stringOrUndefined(toolResult.tool_use_id);
      if (!callId) continue;
      flushOrdinaryContent();
      messages.push({
        role: 'tool',
        toolCallId: callId,
        content: normalizeContentParts(toolResult.content, 'anthropic'),
      });
    }
    flushOrdinaryContent();
    return messages;
  }

  if (normalizedContent.length > 0) {
    messages.push({ role: role as GatewayMessage['role'], content: normalizedContent });
  }
  return messages;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
      case 'reasoning.signature':
        return {
          type: 'content_block_delta',
          delta: { type: 'signature_delta', signature: event.signature },
          index: 0,
        };
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
