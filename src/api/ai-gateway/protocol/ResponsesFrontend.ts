import {
  booleanValue,
  extractExtension,
  type GatewayEvent,
  type GatewayEventSerializer,
  type GatewayProtocolFrontend,
  type GatewayRequest,
  mapGatewayUsageToOpenAi,
  normalizeContentParts,
  normalizeMessage,
  normalizeToolFromResponses,
  requireObject,
  stringOrUndefined,
  ToolArgumentTracker,
  unsupportedEvent,
} from '../types';

const RESPONSES_NORMALIZED_KEYS = [
  'model',
  'instructions',
  'input',
  'tools',
  'reasoning',
  'previous_response_id',
  'stream',
] as const;

export class ResponsesFrontend implements GatewayProtocolFrontend {
  public readonly protocol = 'responses' as const;

  public parseRequest(body: unknown): GatewayRequest {
    const record = requireObject(body, 'Responses request');
    const input = record.input;
    const inputContent = normalizeContentParts(input, this.protocol);
    const messages = Array.isArray(input)
      ? input.map((message) => normalizeMessage(message, this.protocol)).filter((message) => message !== undefined)
      : inputContent.length > 0
        ? [{ role: 'user' as const, content: inputContent }]
        : [];
    const reasoning = record.reasoning && typeof record.reasoning === 'object'
      ? record.reasoning as Record<string, unknown>
      : undefined;

    return {
      model: stringOrUndefined(record.model) ?? '',
      instructions: stringOrUndefined(record.instructions),
      messages,
      tools: Array.isArray(record.tools)
        ? record.tools.map(normalizeToolFromResponses).filter((tool) => tool !== undefined)
        : [],
      reasoning: reasoning
        ? {
            effort: stringOrUndefined(reasoning.effort),
            exposeSummary: reasoning.summary !== undefined && reasoning.summary !== false,
          }
        : undefined,
      previousResponseId: stringOrUndefined(record.previous_response_id),
      stream: booleanValue(record.stream),
      protocolExtensions: extractExtension(record, this.protocol, RESPONSES_NORMALIZED_KEYS),
    };
  }

  public createEventSerializer(): GatewayEventSerializer {
    return new ResponsesEventSerializer();
  }
}

class ResponsesEventSerializer implements GatewayEventSerializer {
  private readonly toolArguments = new ToolArgumentTracker();

  public serializeEvent(event: GatewayEvent): Record<string, unknown> {
    switch (event.type) {
      case 'response.started':
        this.toolArguments.reset();
        return { type: 'response.created', response: { id: event.id } };
      case 'text.delta':
        return { type: 'response.output_text.delta', delta: event.text };
      case 'reasoning.delta':
        return { type: 'response.reasoning_summary_text.delta', delta: event.text };
      case 'tool.started':
        this.toolArguments.start(event.callId);
        return {
          type: 'response.output_item.added',
          item: { type: 'function_call', call_id: event.callId, name: event.name },
        };
      case 'tool.arguments.delta':
        this.toolArguments.append(event.callId, event.delta);
        return {
          type: 'response.function_call_arguments.delta',
          call_id: event.callId,
          delta: event.delta,
        };
      case 'tool.completed':
        this.toolArguments.complete(event.callId);
        return { type: 'response.output_item.done', call_id: event.callId };
      case 'usage':
        return { type: 'response.usage', usage: mapGatewayUsageToOpenAi(event.usage) };
      case 'response.completed':
        this.toolArguments.reset();
        return {
          type: 'response.completed',
          response: { status: 'completed', finish_reason: event.finishReason },
        };
      default:
        return unsupportedEvent(event);
    }
  }
}
