import {
  booleanValue,
  extractExtension,
  type GatewayEvent,
  type GatewayEventSerializer,
  type GatewayProtocolFrontend,
  type GatewayRequest,
  type GatewayTextAnnotation,
  mapGatewayUsageToOpenAi,
  normalizeContentParts,
  normalizeMessage,
  normalizeToolFromResponses,
  requireObject,
  stringOrUndefined,
  ToolArgumentTracker,
  unsupportedEvent,
} from '../types';
import { GatewayProtocolError } from '../errors';

const RESPONSES_NORMALIZED_KEYS = [
  'model',
  'instructions',
  'input',
  'tools',
  'reasoning',
  'max_output_tokens',
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
      maxOutputTokens: numberOrUndefined(record.max_output_tokens),
      previousResponseId: stringOrUndefined(record.previous_response_id),
      stream: booleanValue(record.stream),
      protocolExtensions: extractExtension(record, this.protocol, RESPONSES_NORMALIZED_KEYS),
    };
  }

  public createEventSerializer(): GatewayEventSerializer {
    return new ResponsesEventSerializer();
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

class ResponsesEventSerializer implements GatewayEventSerializer {
  private readonly toolArguments = new ToolArgumentTracker();
  private readonly toolNames = new Map<string, string>();
  private readonly toolOutputIndexes = new Map<string, number>();
  private responseId = 'response';
  private messageId: string | undefined;
  private messageOutputIndex: number | undefined;
  private nextOutputIndex = 0;
  private text = '';
  private annotations: GatewayTextAnnotation[] = [];
  private textPartOpen = false;

  public serializeEvent(event: GatewayEvent): Record<string, unknown> | Record<string, unknown>[] {
    switch (event.type) {
      case 'response.started':
        this.toolArguments.reset();
        this.toolNames.clear();
        this.toolOutputIndexes.clear();
        this.responseId = event.id;
        this.messageId = undefined;
        this.messageOutputIndex = undefined;
        this.nextOutputIndex = 0;
        this.text = '';
        this.annotations = [];
        this.textPartOpen = false;
        return { type: 'response.created', response: { id: event.id } };
      case 'text.delta':
        this.text += event.text;
        return [
          ...this.ensureMessageTextPart(),
          {
            type: 'response.output_text.delta',
            item_id: this.messageId,
            output_index: this.messageOutputIndex,
            content_index: 0,
            delta: event.text,
          },
        ];
      case 'text.annotations':
        this.annotations = mergeAnnotations(this.annotations, event.annotations);
        return [];
      case 'reasoning.delta':
        return { type: 'response.reasoning_summary_text.delta', delta: event.text };
      case 'reasoning.signature':
        return {
          type: 'response.reasoning_signature.delta',
          provider: event.provider,
          signature: event.signature,
        };
      case 'tool.started':
        this.toolArguments.start(event.callId);
        this.toolNames.set(event.callId, event.name);
        this.toolOutputIndexes.set(event.callId, this.nextOutputIndex++);
        return {
          type: 'response.output_item.added',
          output_index: this.requireToolOutputIndex(event.callId),
          item: {
            id: this.toolItemId(event.callId),
            type: 'function_call',
            call_id: event.callId,
            name: event.name,
            arguments: '',
          },
        };
      case 'tool.arguments.delta':
        this.toolArguments.append(event.callId, event.delta);
        return {
          type: 'response.function_call_arguments.delta',
          item_id: this.toolItemId(event.callId),
          output_index: this.requireToolOutputIndex(event.callId),
          delta: event.delta,
        };
      case 'tool.completed':
        {
          const argumentsJson = this.toolArguments.argumentsFor(event.callId);
          const name = this.toolNames.get(event.callId);
          const outputIndex = this.requireToolOutputIndex(event.callId);
          this.toolArguments.complete(event.callId);
          this.toolNames.delete(event.callId);
          this.toolOutputIndexes.delete(event.callId);
          return [
            {
              type: 'response.function_call_arguments.done',
              item_id: this.toolItemId(event.callId),
              output_index: outputIndex,
              ...(name ? { name } : {}),
              arguments: argumentsJson,
            },
            {
              type: 'response.output_item.done',
              output_index: outputIndex,
              item: {
                id: this.toolItemId(event.callId),
                type: 'function_call',
                call_id: event.callId,
                ...(name ? { name } : {}),
                arguments: argumentsJson,
              },
            },
          ];
        }
      case 'usage':
        return { type: 'response.usage', usage: mapGatewayUsageToOpenAi(event.usage) };
      case 'response.completed':
      {
        const closeText = this.textPartOpen && this.messageId ? [
          {
            type: 'response.content_part.done',
            item_id: this.messageId,
            output_index: this.messageOutputIndex,
            content_index: 0,
            part: {
              type: 'output_text',
              text: this.text,
              ...(this.annotations.length > 0 ? { annotations: this.annotations } : {}),
            },
          },
          {
            type: 'response.output_item.done',
            output_index: this.messageOutputIndex,
            item: {
              id: this.messageId,
              type: 'message',
              role: 'assistant',
              content: [{
                type: 'output_text',
                text: this.text,
                ...(this.annotations.length > 0 ? { annotations: this.annotations } : {}),
              }],
            },
          },
        ] : [];
        this.toolArguments.reset();
        this.toolNames.clear();
        this.toolOutputIndexes.clear();
        this.messageId = undefined;
        this.messageOutputIndex = undefined;
        this.text = '';
        this.annotations = [];
        this.textPartOpen = false;
        return [
          ...closeText,
          {
            type: 'response.completed',
            response: { id: this.responseId, status: 'completed', finish_reason: event.finishReason },
          },
        ];
      }
      default:
        return unsupportedEvent(event);
    }
  }

  private ensureMessageTextPart(): Record<string, unknown>[] {
    if (this.textPartOpen && this.messageId) {
      return [];
    }
    this.messageId = this.messageId ?? 'msg_0';
    this.messageOutputIndex = this.messageOutputIndex ?? this.nextOutputIndex++;
    this.textPartOpen = true;
    return [
      {
        type: 'response.output_item.added',
        output_index: this.messageOutputIndex,
        item: { id: this.messageId, type: 'message', role: 'assistant', content: [] },
      },
      {
        type: 'response.content_part.added',
        item_id: this.messageId,
        output_index: this.messageOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      },
    ];
  }

  private toolItemId(callId: string): string {
    return `fc_${callId}`;
  }

  private requireToolOutputIndex(callId: string): number {
    const outputIndex = this.toolOutputIndexes.get(callId);
    if (outputIndex === undefined) {
      throw new GatewayProtocolError(`Unknown tool call ${callId}`, {
        code: 'invalid_request',
        status: 500,
      });
    }
    return outputIndex;
  }
}

function mergeAnnotations(
  current: GatewayTextAnnotation[],
  incoming: GatewayTextAnnotation[],
): GatewayTextAnnotation[] {
  const merged = new Map(current.map((annotation) => [JSON.stringify(annotation), annotation]));
  for (const annotation of incoming) {
    merged.set(JSON.stringify(annotation), annotation);
  }
  return Array.from(merged.values());
}
