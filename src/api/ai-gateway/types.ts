import { GatewayProtocolError } from './errors';

export type GatewayProtocol = 'responses' | 'anthropic' | 'chatCompletions';

export type GatewayMessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export type GatewayContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; imageUrl?: string; mediaType?: string; data?: string; detail?: string };

export interface GatewayMessage {
  role: GatewayMessageRole;
  content: GatewayContentPart[];
  name?: string;
  toolCallId?: string;
  protocolExtensions?: Record<string, unknown>;
}

export interface GatewayFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  protocolExtensions?: Record<string, unknown>;
}

export interface GatewayWebSearchTool {
  type: 'web_search';
  protocolExtensions?: Record<string, unknown>;
}

export type GatewayTool = GatewayFunctionTool | GatewayWebSearchTool;

export type GatewayTextAnnotation = Record<string, unknown>;

export interface GatewayReasoningOptions {
  effort?: string;
  exposeSummary?: boolean;
}

export interface GatewayUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface GatewayRequest {
  model: string;
  instructions?: string;
  messages: GatewayMessage[];
  tools: GatewayTool[];
  reasoning?: GatewayReasoningOptions;
  maxOutputTokens?: number;
  previousResponseId?: string;
  stream: boolean;
  protocolExtensions: Partial<Record<GatewayProtocol, Record<string, unknown>>>;
}

export type GatewayEvent =
  | { type: 'response.started'; id: string }
  | { type: 'text.delta'; text: string }
  | { type: 'text.annotations'; annotations: GatewayTextAnnotation[] }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'reasoning.signature'; provider: string; signature: string }
  | { type: 'tool.started'; callId: string; name: string }
  | { type: 'tool.arguments.delta'; callId: string; delta: string }
  | { type: 'tool.completed'; callId: string }
  | { type: 'usage'; usage: GatewayUsage }
  | { type: 'response.completed'; finishReason: string };

export interface GatewayEventSerializer {
  serializeEvent(event: GatewayEvent): Record<string, unknown> | Record<string, unknown>[];
}

export interface GatewayProtocolFrontend {
  readonly protocol: GatewayProtocol;
  parseRequest(body: unknown): GatewayRequest;
  createEventSerializer(): GatewayEventSerializer;
}

export function requireObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayProtocolError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function booleanValue(value: unknown): boolean {
  return value === true;
}

export function extractExtension(
  body: Record<string, unknown>,
  protocol: GatewayProtocol,
  normalizedKeys: readonly string[],
): Partial<Record<GatewayProtocol, Record<string, unknown>>> {
  const normalized = new Set(normalizedKeys);
  const extension: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!normalized.has(key)) {
      extension[key] = value;
    }
  }
  return Object.keys(extension).length > 0 ? { [protocol]: extension } : {};
}

export function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
          return (item as { text: string }).text;
        }
        return undefined;
      })
      .filter((item): item is string => item !== undefined);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  if (value == null) {
    return undefined;
  }
  return String(value);
}

export function normalizeContentParts(content: unknown, protocol: GatewayProtocol): GatewayContentPart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  if (!Array.isArray(content)) {
    if (content && typeof content === 'object') {
      return normalizeContentParts([content], protocol);
    }
    const text = extractText(content);
    return text ? [{ type: 'text', text }] : [];
  }

  return content.flatMap((part): GatewayContentPart[] => {
    if (typeof part === 'string') {
      return [{ type: 'text', text: part }];
    }
    if (!part || typeof part !== 'object') {
      return [];
    }
    const record = part as Record<string, unknown>;
    const type = record.type;
    if (
      type === 'text'
      || type === 'input_text'
      || type === 'output_text'
    ) {
      const text = stringOrUndefined(record.text);
      return text ? [{ type: 'text', text }] : [];
    }

    if (type === 'image_url') {
      const imageUrl = record.image_url;
      if (typeof imageUrl === 'string') {
        return [{ type: 'image', imageUrl }];
      }
      if (imageUrl && typeof imageUrl === 'object') {
        const image = imageUrl as Record<string, unknown>;
        return [{
          type: 'image',
          imageUrl: stringOrUndefined(image.url),
          detail: stringOrUndefined(image.detail),
        }];
      }
    }

    if (type === 'input_image') {
      return [{
        type: 'image',
        imageUrl: stringOrUndefined(record.image_url) ?? stringOrUndefined(record.file_id),
        detail: stringOrUndefined(record.detail),
      }];
    }

    if (type === 'image' && protocol === 'anthropic') {
      const source = record.source;
      if (source && typeof source === 'object') {
        const image = source as Record<string, unknown>;
        return [{
          type: 'image',
          mediaType: stringOrUndefined(image.media_type),
          data: stringOrUndefined(image.data),
        }];
      }
    }

    return [];
  });
}

export function normalizeToolFromResponses(tool: unknown): GatewayTool | undefined {
  if (!tool || typeof tool !== 'object') {
    return undefined;
  }
  const record = tool as Record<string, unknown>;
  if (record.type === 'web_search' || record.type === 'web_search_preview') {
    return {
      type: 'web_search',
      protocolExtensions: {
        responses: { ...record, type: 'web_search' },
      },
    };
  }
  const name = stringOrUndefined(record.name);
  if (!name) {
    return undefined;
  }
  return {
    type: 'function',
    name,
    description: stringOrUndefined(record.description),
    inputSchema: record.parameters && typeof record.parameters === 'object'
      ? record.parameters as Record<string, unknown>
      : undefined,
  };
}

export function normalizeToolFromAnthropic(tool: unknown): GatewayTool | undefined {
  if (!tool || typeof tool !== 'object') {
    return undefined;
  }
  const record = tool as Record<string, unknown>;
  const name = stringOrUndefined(record.name);
  if (!name) {
    return undefined;
  }
  return {
    type: 'function',
    name,
    description: stringOrUndefined(record.description),
    inputSchema: record.input_schema && typeof record.input_schema === 'object'
      ? record.input_schema as Record<string, unknown>
      : undefined,
  };
}

export function normalizeToolFromChat(tool: unknown): GatewayTool | undefined {
  if (!tool || typeof tool !== 'object') {
    return undefined;
  }
  const record = tool as Record<string, unknown>;
  const fn = record.function;
  if (!fn || typeof fn !== 'object') {
    return undefined;
  }
  const functionRecord = fn as Record<string, unknown>;
  const name = stringOrUndefined(functionRecord.name);
  if (!name) {
    return undefined;
  }
  return {
    type: 'function',
    name,
    description: stringOrUndefined(functionRecord.description),
    inputSchema: functionRecord.parameters && typeof functionRecord.parameters === 'object'
      ? functionRecord.parameters as Record<string, unknown>
      : undefined,
  };
}

export function normalizeMessage(message: unknown, protocol: GatewayProtocol): GatewayMessage | undefined {
  if (!message || typeof message !== 'object') {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  const role = stringOrUndefined(record.role);
  if (!role) {
    return undefined;
  }
  return {
    role: role as GatewayMessage['role'],
    content: normalizeContentParts(record.content, protocol),
    name: stringOrUndefined(record.name),
    toolCallId: stringOrUndefined(record.tool_call_id) ?? stringOrUndefined(record.tool_use_id),
  };
}

export function mapGatewayUsageToOpenAi(usage: GatewayUsage): Record<string, unknown> {
  return {
    ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { output_tokens: usage.outputTokens } : {}),
    ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}),
    ...(
      usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined
        ? {
            input_tokens_details: {
              ...(usage.cacheReadTokens !== undefined ? { cached_tokens: usage.cacheReadTokens } : {}),
              ...(usage.cacheWriteTokens !== undefined ? { cache_write_tokens: usage.cacheWriteTokens } : {}),
            },
          }
        : {}
    ),
  };
}

export function mapGatewayUsageToChatCompletions(usage: GatewayUsage): Record<string, unknown> {
  return {
    ...(usage.inputTokens !== undefined ? { prompt_tokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { completion_tokens: usage.outputTokens } : {}),
    ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}),
    ...(
      usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined
        ? {
            prompt_tokens_details: {
              ...(usage.cacheReadTokens !== undefined ? { cached_tokens: usage.cacheReadTokens } : {}),
              ...(usage.cacheWriteTokens !== undefined ? { cache_write_tokens: usage.cacheWriteTokens } : {}),
            },
          }
        : {}
    ),
  };
}

export function mapGatewayUsageToAnthropic(usage: GatewayUsage): Record<string, unknown> {
  return {
    ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { output_tokens: usage.outputTokens } : {}),
    ...(usage.cacheReadTokens !== undefined ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cache_creation_input_tokens: usage.cacheWriteTokens } : {}),
  };
}

export class ToolArgumentTracker {
  private readonly chunks = new Map<string, string>();
  private readonly toolIndexes = new Map<string, number>();
  private nextIndex = 0;

  public reset(): void {
    this.chunks.clear();
    this.toolIndexes.clear();
    this.nextIndex = 0;
  }

  public start(callId: string): number {
    if (!this.toolIndexes.has(callId)) {
      this.toolIndexes.set(callId, this.nextIndex);
      this.nextIndex += 1;
    }
    if (!this.chunks.has(callId)) {
      this.chunks.set(callId, '');
    }
    return this.toolIndexes.get(callId) ?? 0;
  }

  public append(callId: string, delta: string): number {
    const index = this.requireStarted(callId);
    this.chunks.set(callId, `${this.chunks.get(callId) ?? ''}${delta}`);
    return index;
  }

  public argumentsFor(callId: string): string {
    this.requireStarted(callId);
    return this.chunks.get(callId) ?? '';
  }

  public complete(callId: string): number {
    const index = this.requireStarted(callId);
    const value = this.chunks.get(callId) ?? '';
    try {
      JSON.parse(value || '{}');
    } catch (error) {
      throw new GatewayProtocolError('Completed tool arguments must be valid JSON', {
        code: 'invalid_tool_arguments',
        status: 400,
        details: { callId },
        cause: error,
      });
    }
    this.chunks.delete(callId);
    this.toolIndexes.delete(callId);
    return index;
  }

  private requireStarted(callId: string): number {
    const index = this.toolIndexes.get(callId);
    if (index === undefined || !this.chunks.has(callId)) {
      throw new GatewayProtocolError('Tool arguments event received before tool start', {
        code: 'invalid_tool_arguments',
        status: 400,
        details: { callId },
      });
    }
    return index;
  }
}

export function unsupportedEvent(event: GatewayEvent): never {
  throw new GatewayProtocolError(`Unsupported gateway event: ${event.type}`, {
    code: 'unsupported_protocol_event',
    status: 500,
  });
}
