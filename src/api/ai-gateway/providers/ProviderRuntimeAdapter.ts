import { GatewayProtocolError } from '../errors';
import {
  type GatewayContentPart,
  type GatewayEvent,
  type GatewayMessage,
  type GatewayRequest,
  type GatewayTool,
  type GatewayUsage,
  ToolArgumentTracker,
} from '../types';
import { type ProviderSseEvent, ProviderHttpTransport } from '../../service/provider-http-transport';
import type { ProviderDescriptor, ProviderModelDescriptor } from './ProviderRegistry';

export interface ProviderRuntimeCredential {
  baseUrl?: string;
  compatibility?: 'auto' | 'openai' | 'anthropic';
  keyType?: 'apiKey' | 'dashscope' | 'codingPlan' | string;
  supportsDeveloperMessages?: boolean;
  proxy?: string;
  region?: string;
  workspaceId?: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderRuntimeExecuteInput {
  request: GatewayRequest;
  apiKey: string;
  credential?: ProviderRuntimeCredential;
  signal?: AbortSignal;
}

export interface ProviderRuntimeAdapter {
  readonly provider: string;
  execute(input: ProviderRuntimeExecuteInput): AsyncIterable<GatewayEvent>;
}

export interface ProviderRuntimeAdapterOptions {
  transport?: ProviderHttpTransport;
  maxOutputTokensDefault?: number;
}

export interface CompatibleChatAdapterOptions extends ProviderRuntimeAdapterOptions {
  provider: string;
  defaultBaseUrl: string;
  safeBaseUrls: string[];
  allowCredentialBaseUrl?: boolean;
  allowPrivateNetwork?: boolean;
  descriptor?: ProviderDescriptor;
  supportsImages?: boolean;
  supportsDeveloperMessages?: boolean;
  allowToolChoiceRequired?: boolean;
  reasoningEffortMapper?: (effort: string, request: GatewayRequest, model?: ProviderModelDescriptor) => string | undefined;
  fallbackReasoningBody?: (effort: string, request: GatewayRequest, model?: ProviderModelDescriptor) => Record<string, unknown>;
  preserveReasoningContent?: boolean;
  chatBodyTransform?: (body: Record<string, unknown>, input: ProviderRuntimeExecuteInput) => Record<string, unknown>;
}

export abstract class BaseProviderRuntimeAdapter implements ProviderRuntimeAdapter {
  public abstract readonly provider: string;
  protected readonly transport: ProviderHttpTransport;
  protected readonly maxOutputTokensDefault: number;

  protected constructor(options: ProviderRuntimeAdapterOptions = {}) {
    this.transport = options.transport ?? new ProviderHttpTransport();
    this.maxOutputTokensDefault = options.maxOutputTokensDefault ?? 4096;
  }

  public abstract execute(input: ProviderRuntimeExecuteInput): AsyncIterable<GatewayEvent>;

  protected resolveBaseUrl(input: {
    configuredBaseUrl?: string;
    defaultBaseUrl: string;
    safeBaseUrls: string[];
    allowCredentialBaseUrl?: boolean;
  }): string {
    if (input.allowCredentialBaseUrl && input.configuredBaseUrl) {
      return normalizeRuntimeBaseUrl(input.configuredBaseUrl);
    }
    const candidate = normalizeRuntimeBaseUrl(input.configuredBaseUrl ?? input.defaultBaseUrl);
    if (!input.safeBaseUrls.map(trimTrailingSlash).includes(candidate)) {
      throw new GatewayProtocolError('Configured provider endpoint is not allowed', {
        code: 'invalid_request',
        status: 400,
        details: {
          provider: this.provider,
        },
      });
    }
    return candidate;
  }

  protected handleTransportError(error: unknown, secret: string): never {
    if (error instanceof GatewayProtocolError) {
      throw error;
    }

    const status = typeof (error as { status?: unknown })?.status === 'number'
      ? (error as { status: number }).status
      : 502;
    const headers = (error as { headers?: Headers })?.headers;
    const retryAfter = headers?.get('Retry-After') ?? headers?.get('retry-after') ?? undefined;
    const body = typeof (error as { body?: unknown })?.body === 'string'
      ? redactSecret((error as { body: string }).body, secret)
      : undefined;

    throw new GatewayProtocolError(`Provider request failed with status ${status}`, {
      code: 'provider_error',
      status,
      details: {
        provider: this.provider,
        providerStatusCode: status,
        classification: classifyProviderStatus(status),
        ...(retryAfter ? { retryAfter } : {}),
        ...(body ? { body } : {}),
      },
      cause: error,
    });
  }
}

export class OpenAiCompatibleRuntimeAdapter extends BaseProviderRuntimeAdapter {
  public readonly provider: string;
  private readonly defaultBaseUrl: string;
  private readonly safeBaseUrls: string[];
  private readonly allowCredentialBaseUrl: boolean;
  private readonly allowPrivateNetwork: boolean;
  private readonly supportsImages: boolean;
  private readonly supportsDeveloperMessages: boolean;
  private readonly allowToolChoiceRequired: boolean;
  private readonly descriptor?: ProviderDescriptor;
  private readonly reasoningEffortMapper?: CompatibleChatAdapterOptions['reasoningEffortMapper'];
  private readonly fallbackReasoningBody?: CompatibleChatAdapterOptions['fallbackReasoningBody'];
  private readonly preserveReasoningContent: boolean;
  private readonly chatBodyTransform?: CompatibleChatAdapterOptions['chatBodyTransform'];

  public constructor(options: CompatibleChatAdapterOptions) {
    super(options);
    this.provider = options.provider;
    this.defaultBaseUrl = options.defaultBaseUrl;
    this.safeBaseUrls = options.safeBaseUrls;
    this.allowCredentialBaseUrl = options.allowCredentialBaseUrl ?? false;
    this.allowPrivateNetwork = options.allowPrivateNetwork ?? false;
    this.supportsImages = options.supportsImages ?? true;
    this.supportsDeveloperMessages = options.supportsDeveloperMessages ?? true;
    this.allowToolChoiceRequired = options.allowToolChoiceRequired ?? true;
    this.descriptor = options.descriptor;
    this.reasoningEffortMapper = options.reasoningEffortMapper;
    this.fallbackReasoningBody = options.fallbackReasoningBody;
    this.preserveReasoningContent = options.preserveReasoningContent ?? false;
    this.chatBodyTransform = options.chatBodyTransform;
  }

  public async *execute(input: ProviderRuntimeExecuteInput): AsyncIterable<GatewayEvent> {
    const request = this.toProviderCompatibleRequest(input.request, input.credential);
    this.validateRequest(request);
    const baseUrl = this.resolveBaseUrl({
      configuredBaseUrl: input.credential?.baseUrl,
      defaultBaseUrl: this.defaultBaseUrl,
      safeBaseUrls: this.safeBaseUrls,
      allowCredentialBaseUrl: this.allowCredentialBaseUrl,
    });
    const model = this.findRegisteredModel(request.model);
    const compatibleBody = toChatCompletionsBody(request, {
      reasoningEffort: this.resolveReasoningEffort(request, model),
      extraReasoningBody: this.resolveFallbackReasoningBody(request, model),
      preserveReasoningContent: this.preserveReasoningContent,
    });
    const body = this.chatBodyTransform?.(compatibleBody, { ...input, request }) ?? compatibleBody;

    try {
      yield* parseCompatibleChatSse(this.transport.postSse({
        url: `${baseUrl}/chat/completions`,
        apiKey: input.apiKey,
        body,
        proxy: input.credential?.proxy,
        signal: input.signal,
        allowPrivateNetwork: this.allowPrivateNetwork,
      }), input.apiKey);
    } catch (error) {
      this.handleTransportError(error, input.apiKey);
    }
  }

  private validateRequest(request: GatewayRequest): void {
    if (!this.supportsImages && request.messages.some((message) => message.content.some((part) => part.type === 'image'))) {
      throw new GatewayProtocolError(`${this.provider} does not support image input through this gateway`, {
        code: 'invalid_request',
        status: 400,
        details: { provider: this.provider, capability: 'imageInput' },
      });
    }
    const chatExtensions = request.protocolExtensions.chatCompletions ?? {};
    if (!this.allowToolChoiceRequired && chatExtensions.tool_choice === 'required') {
      throw new GatewayProtocolError(`${this.provider} does not support required tool_choice`, {
        code: 'invalid_request',
        status: 400,
        details: { provider: this.provider, capability: 'tool_choice.required' },
      });
    }
  }

  private toProviderCompatibleRequest(
    request: GatewayRequest,
    credential?: ProviderRuntimeCredential,
  ): GatewayRequest {
    const supportsDeveloperMessages = credential?.supportsDeveloperMessages
      ?? this.supportsDeveloperMessages;
    if (supportsDeveloperMessages || !request.messages.some((message) => message.role === 'developer')) {
      return request;
    }
    return {
      ...request,
      messages: request.messages.map((message) => message.role === 'developer'
        ? { ...message, role: 'system' as const }
        : message),
    };
  }

  private findRegisteredModel(model: string): ProviderModelDescriptor | undefined {
    return this.descriptor?.models.find((candidate) => candidate.id === model);
  }

  private resolveReasoningEffort(
    request: GatewayRequest,
    model: ProviderModelDescriptor | undefined,
  ): string | undefined {
    const effort = request.reasoning?.effort;
    if (!effort) {
      return undefined;
    }
    if (this.reasoningEffortMapper) {
      return this.reasoningEffortMapper(effort, request, model);
    }
    return undefined;
  }

  private resolveFallbackReasoningBody(
    request: GatewayRequest,
    model: ProviderModelDescriptor | undefined,
  ): Record<string, unknown> {
    const effort = request.reasoning?.effort;
    if (!effort || !this.fallbackReasoningBody) {
      return {};
    }
    return this.fallbackReasoningBody(effort, request, model);
  }
}

export function toResponsesBody(request: GatewayRequest): Record<string, unknown> {
  return {
    ...request.protocolExtensions.responses,
    model: request.model,
    stream: true,
    ...(request.instructions ? { instructions: request.instructions } : {}),
    ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {}),
    ...(request.maxOutputTokens !== undefined ? { max_output_tokens: request.maxOutputTokens } : {}),
    ...(request.reasoning?.effort ? { reasoning: { effort: request.reasoning.effort } } : {}),
    input: request.messages.map((message) => ({
      role: message.role,
      content: message.content.flatMap(toOpenAiContentPart),
      ...(message.name ? { name: message.name } : {}),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    })),
    ...(request.tools.length > 0 ? { tools: request.tools.map(toOpenAiTool) } : {}),
  };
}

export function toAnthropicBody(request: GatewayRequest, options: { maxOutputTokensDefault?: number } = {}): Record<string, unknown> {
  const maxTokens = request.maxOutputTokens ?? options.maxOutputTokensDefault ?? 4096;
  return {
    ...request.protocolExtensions.anthropic,
    model: request.model,
    stream: true,
    max_tokens: maxTokens,
    ...(request.instructions ? { system: request.instructions } : {}),
    messages: request.messages.map((message) => ({
      role: message.role === 'tool' ? 'user' : message.role,
      content: message.role === 'tool'
        ? [{ type: 'tool_result', tool_use_id: message.toolCallId, content: contentToText(message.content) }]
        : [
            ...message.content.map(toAnthropicContentPart),
            ...anthropicToolUseParts(message),
          ],
    })),
    ...(request.tools.length > 0 ? { tools: request.tools.map(toAnthropicTool) } : {}),
    ...(request.reasoning?.effort
      ? {
          thinking: {
            type: 'enabled',
            budget_tokens: Number.isFinite(Number(request.reasoning.effort))
              ? Number(request.reasoning.effort)
              : 1024,
          },
        }
      : {}),
  };
}

function anthropicToolUseParts(message: GatewayMessage): Array<Record<string, unknown>> {
  if (message.role !== 'assistant' || !Array.isArray(message.protocolExtensions?.tool_calls)) {
    return [];
  }
  return message.protocolExtensions.tool_calls.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const toolCall = value as Record<string, unknown>;
    const fn = toolCall.function;
    if (!fn || typeof fn !== 'object') return [];
    const functionCall = fn as Record<string, unknown>;
    if (typeof toolCall.id !== 'string' || typeof functionCall.name !== 'string') return [];
    return [{
      type: 'tool_use',
      id: toolCall.id,
      name: functionCall.name,
      input: parseAnthropicToolUseInput(functionCall.arguments, {
        id: toolCall.id,
        name: functionCall.name,
      }),
    }];
  });
}

function parseAnthropicToolUseInput(
  rawArguments: unknown,
  toolCall: { id: string; name: string },
): Record<string, unknown> {
  if (rawArguments === undefined || rawArguments === null || rawArguments === '') {
    return {};
  }
  if (typeof rawArguments !== 'string') {
    throw new GatewayProtocolError('Anthropic tool replay arguments must be JSON object strings', {
      code: 'invalid_request',
      status: 400,
      details: {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      },
    });
  }
  if (!rawArguments.trim()) return {};
  let input: unknown;
  try {
    input = JSON.parse(rawArguments);
  } catch (error) {
    throw new GatewayProtocolError('Anthropic tool replay arguments must be valid JSON object strings', {
      code: 'invalid_request',
      status: 400,
      details: {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      },
      cause: error,
    });
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GatewayProtocolError('Anthropic tool replay arguments must be JSON objects', {
      code: 'invalid_request',
      status: 400,
      details: {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      },
    });
  }
  return input as Record<string, unknown>;
}

export function toChatCompletionsBody(
  request: GatewayRequest,
  options: { reasoningEffort?: string; extraReasoningBody?: Record<string, unknown>; preserveReasoningContent?: boolean },
): Record<string, unknown> {
  return {
    ...request.protocolExtensions.chatCompletions,
    ...options.extraReasoningBody,
    model: request.model,
    stream: true,
    ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
    ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
    messages: [
      ...(request.instructions ? [{ role: 'system', content: request.instructions }] : []),
      ...request.messages.map((message) => toChatMessage(message, options)),
    ],
    ...(request.tools.length > 0 ? { tools: request.tools.map(toChatTool) } : {}),
  };
}

export async function* parseOpenAiResponsesSse(events: AsyncIterable<ProviderSseEvent>, secret?: string): AsyncIterable<GatewayEvent> {
  const toolArguments = new ToolArgumentTracker();
  const itemCallIds = new Map<string, string>();
  for await (const event of events) {
    const payload = parseJsonSseData(event.data);
    if (!payload) {
      continue;
    }
    const type = stringField(payload, 'type');
    if (type === 'response.created' || type === 'response.in_progress') {
      const response = objectField(payload, 'response');
      const id = stringField(response, 'id');
      if (id) {
        toolArguments.reset();
        itemCallIds.clear();
        yield { type: 'response.started', id };
      }
    } else if (type === 'response.output_text.delta') {
      const delta = stringField(payload, 'delta');
      if (delta) {
        yield { type: 'text.delta', text: delta };
      }
    } else if (type === 'response.reasoning_summary_text.delta') {
      const delta = stringField(payload, 'delta');
      if (delta) {
        yield { type: 'reasoning.delta', text: delta };
      }
    } else if (type === 'response.output_item.added') {
      const item = objectField(payload, 'item');
      if (stringField(item, 'type') === 'function_call') {
        const callId = stringField(item, 'call_id') ?? stringField(item, 'id');
        const itemId = stringField(item, 'id');
        const name = stringField(item, 'name');
        if (callId && name) {
          toolArguments.start(callId);
          if (itemId) {
            itemCallIds.set(itemId, callId);
          }
          yield { type: 'tool.started', callId, name };
        }
      }
    } else if (type === 'response.function_call_arguments.delta') {
      const itemId = stringField(payload, 'item_id');
      const callId = stringField(payload, 'call_id') ?? (itemId ? itemCallIds.get(itemId) : undefined);
      const delta = stringField(payload, 'delta');
      if (callId && delta !== undefined) {
        toolArguments.append(callId, delta);
        yield { type: 'tool.arguments.delta', callId, delta };
      }
    } else if (type === 'response.output_item.done') {
      const item = objectField(payload, 'item');
      if (stringField(item, 'type') === 'function_call') {
        const callId = stringField(payload, 'call_id') ?? stringField(item, 'call_id') ?? stringField(item, 'id');
        if (callId) {
          toolArguments.complete(callId);
          const itemId = stringField(item, 'id');
          if (itemId) {
            itemCallIds.delete(itemId);
          }
          yield { type: 'tool.completed', callId };
        }
      } else {
        const callId = stringField(payload, 'call_id');
        if (!callId) {
          continue;
        }
        toolArguments.complete(callId);
        yield { type: 'tool.completed', callId };
      }
    } else if (type === 'response.completed') {
      const response = objectField(payload, 'response');
      const usage = parseOpenAiUsage(objectField(response, 'usage'));
      if (usage) {
        yield { type: 'usage', usage };
      }
      yield { type: 'response.completed', finishReason: stringField(response, 'finish_reason') ?? stringField(response, 'status') ?? 'stop' };
    } else if (type === 'error') {
      throw providerStreamError(payload, 502, secret);
    }
  }
}

export async function* parseAnthropicMessagesSse(events: AsyncIterable<ProviderSseEvent>, secret?: string): AsyncIterable<GatewayEvent> {
  const toolArguments = new ToolArgumentTracker();
  const toolBlocks = new Map<number, string>();
  let latestStopReason: string | undefined;
  for await (const event of events) {
    const payload = parseJsonSseData(event.data);
    if (!payload) {
      continue;
    }
    const type = stringField(payload, 'type');
    if (type === 'message_start') {
      const message = objectField(payload, 'message');
      const id = stringField(message, 'id');
      if (id) {
        toolArguments.reset();
        toolBlocks.clear();
        yield { type: 'response.started', id };
      }
    } else if (type === 'content_block_start') {
      const index = numberField(payload, 'index');
      const contentBlock = objectField(payload, 'content_block');
      if (index !== undefined && stringField(contentBlock, 'type') === 'tool_use') {
        const callId = stringField(contentBlock, 'id');
        const name = stringField(contentBlock, 'name');
        if (callId && name) {
          toolBlocks.set(index, callId);
          toolArguments.start(callId);
          yield { type: 'tool.started', callId, name };
        }
      }
    } else if (type === 'content_block_delta') {
      const index = numberField(payload, 'index');
      const delta = objectField(payload, 'delta');
      const deltaType = stringField(delta, 'type');
      if (deltaType === 'text_delta') {
        const text = stringField(delta, 'text');
        if (text) {
          yield { type: 'text.delta', text };
        }
      } else if (deltaType === 'thinking_delta') {
        const text = stringField(delta, 'thinking');
        if (text) {
          yield { type: 'reasoning.delta', text };
        }
      } else if (deltaType === 'signature_delta') {
        const signature = stringField(delta, 'signature');
        if (signature) {
          yield { type: 'reasoning.signature', provider: 'anthropic', signature };
        }
      } else if (deltaType === 'input_json_delta' && index !== undefined) {
        const callId = toolBlocks.get(index);
        const partialJson = stringField(delta, 'partial_json');
        if (callId && partialJson !== undefined) {
          toolArguments.append(callId, partialJson);
          yield { type: 'tool.arguments.delta', callId, delta: partialJson };
        }
      }
    } else if (type === 'content_block_stop') {
      const index = numberField(payload, 'index');
      const callId = index === undefined ? undefined : toolBlocks.get(index);
      if (callId) {
        toolArguments.complete(callId);
        toolBlocks.delete(index as number);
        yield { type: 'tool.completed', callId };
      }
    } else if (type === 'message_delta') {
      const delta = objectField(payload, 'delta');
      latestStopReason = stringField(delta, 'stop_reason') ?? latestStopReason;
      const usage = parseAnthropicUsage(objectField(payload, 'usage'));
      if (usage) {
        yield { type: 'usage', usage };
      }
    } else if (type === 'message_stop') {
      yield { type: 'response.completed', finishReason: stringField(payload, 'stop_reason') ?? latestStopReason ?? 'stop' };
    } else if (type === 'error') {
      throw providerStreamError(payload, anthopicErrorStatus(payload), secret);
    }
  }
}

export async function* parseCompatibleChatSse(events: AsyncIterable<ProviderSseEvent>, secret?: string): AsyncIterable<GatewayEvent> {
  const toolArguments = new ToolArgumentTracker();
  const callIdsByIndex = new Map<number, string>();
  const openCallIds = new Set<string>();
  for await (const event of events) {
    const payload = parseJsonSseData(event.data);
    if (!payload) {
      continue;
    }
    if (payload.error) {
      throw providerStreamError(payload, 502, secret);
    }
    const id = stringField(payload, 'id');
    const choices = Array.isArray(payload.choices) ? payload.choices as Record<string, unknown>[] : [];
    if (id && choices.some((choice) => objectField(choice, 'delta').role === 'assistant')) {
      toolArguments.reset();
      callIdsByIndex.clear();
      openCallIds.clear();
      yield { type: 'response.started', id };
    }
    for (const choice of choices) {
      const delta = objectField(choice, 'delta');
      const reasoning = stringField(delta, 'reasoning_content');
      if (reasoning) {
        yield { type: 'reasoning.delta', text: reasoning };
      }
      const content = stringField(delta, 'content');
      if (content) {
        yield { type: 'text.delta', text: content };
      }
      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls as Record<string, unknown>[] : [];
      for (const toolCall of toolCalls) {
        const index = numberField(toolCall, 'index') ?? 0;
        const fn = objectField(toolCall, 'function');
        const existingCallId = callIdsByIndex.get(index);
        const callId = stringField(toolCall, 'id') ?? existingCallId;
        const name = stringField(fn, 'name');
        if (callId && !existingCallId && name) {
          callIdsByIndex.set(index, callId);
          openCallIds.add(callId);
          toolArguments.start(callId);
          yield { type: 'tool.started', callId, name };
        }
        const targetCallId = callId ?? existingCallId;
        const args = stringField(fn, 'arguments');
        if (targetCallId && args !== undefined) {
          toolArguments.append(targetCallId, args);
          yield { type: 'tool.arguments.delta', callId: targetCallId, delta: args };
        }
      }
      const finishReason = stringField(choice, 'finish_reason');
      if (finishReason) {
        for (const callId of Array.from(openCallIds)) {
          toolArguments.complete(callId);
          openCallIds.delete(callId);
          yield { type: 'tool.completed', callId };
        }
      }
    }
    const usage = parseChatUsage(objectField(payload, 'usage'));
    if (usage) {
      yield { type: 'usage', usage };
    }
    const finishReason = choices.map((choice) => stringField(choice, 'finish_reason')).find((item) => item !== undefined);
    if (finishReason) {
      yield { type: 'response.completed', finishReason };
    }
  }
}

export function parseJsonSseData(data: string): Record<string, unknown> | undefined {
  if (data === '[DONE]') {
    return undefined;
  }
  const parsed = JSON.parse(data) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

export function parseOpenAiUsage(usage: Record<string, unknown>): GatewayUsage | undefined {
  return compactUsage({
    inputTokens: numberField(usage, 'input_tokens') ?? numberField(usage, 'prompt_tokens'),
    outputTokens: numberField(usage, 'output_tokens') ?? numberField(usage, 'completion_tokens'),
    totalTokens: numberField(usage, 'total_tokens'),
    cacheReadTokens: numberField(objectField(usage, 'input_tokens_details'), 'cached_tokens')
      ?? numberField(objectField(usage, 'prompt_tokens_details'), 'cached_tokens'),
    cacheWriteTokens: numberField(objectField(usage, 'input_tokens_details'), 'cache_write_tokens')
      ?? numberField(objectField(usage, 'prompt_tokens_details'), 'cache_write_tokens'),
  });
}

export function parseAnthropicUsage(usage: Record<string, unknown>): GatewayUsage | undefined {
  return compactUsage({
    inputTokens: numberField(usage, 'input_tokens'),
    outputTokens: numberField(usage, 'output_tokens'),
    cacheReadTokens: numberField(usage, 'cache_read_input_tokens'),
    cacheWriteTokens: numberField(usage, 'cache_creation_input_tokens'),
  });
}

export function parseChatUsage(usage: Record<string, unknown>): GatewayUsage | undefined {
  return compactUsage({
    inputTokens: numberField(usage, 'prompt_tokens'),
    outputTokens: numberField(usage, 'completion_tokens'),
    totalTokens: numberField(usage, 'total_tokens'),
    cacheReadTokens: numberField(objectField(usage, 'prompt_tokens_details'), 'cached_tokens'),
    cacheWriteTokens: numberField(objectField(usage, 'prompt_tokens_details'), 'cache_write_tokens'),
  });
}

export function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function classifyProviderStatus(status: number): string {
  if (status === 401) {
    return 'authentication';
  }
  if (status === 402) {
    return 'quota_exhausted';
  }
  if (status === 403) {
    return 'authorization';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  if (status >= 500) {
    return 'upstream_unavailable';
  }
  return 'provider_error';
}

function toOpenAiContentPart(part: GatewayContentPart): Record<string, unknown>[] {
  if (part.type === 'text') {
    return [{ type: 'input_text', text: part.text }];
  }
  return [{
    type: 'input_image',
    ...(part.imageUrl ? { image_url: part.imageUrl } : {}),
    ...(part.detail ? { detail: part.detail } : {}),
  }];
}

function toAnthropicContentPart(part: GatewayContentPart): Record<string, unknown> {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  if (part.data) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: part.mediaType ?? 'image/png',
        data: part.data,
      },
    };
  }
  return {
    type: 'image',
    source: {
      type: 'url',
      url: part.imageUrl,
    },
  };
}

function toChatMessage(
  message: GatewayMessage,
  options: { preserveReasoningContent?: boolean },
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    role: message.role,
    content: message.role === 'tool' ? contentToText(message.content) : chatContent(message.content),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.name ? { name: message.name } : {}),
  };
  const reasoningContent = message.protocolExtensions?.reasoning_content;
  if (options.preserveReasoningContent && message.role === 'assistant' && typeof reasoningContent === 'string') {
    base.reasoning_content = reasoningContent;
  }
  const toolCalls = message.protocolExtensions?.tool_calls;
  if (message.role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length > 0) {
    base.tool_calls = toolCalls;
  }
  return base;
}

function chatContent(content: GatewayContentPart[]): string | Array<Record<string, unknown>> {
  if (content.every((part) => part.type === 'text')) {
    return contentToText(content);
  }
  return content.map((part) => part.type === 'text'
    ? { type: 'text', text: part.text }
    : {
        type: 'image_url',
        image_url: {
          url: part.imageUrl ?? (part.data ? `data:${part.mediaType ?? 'image/png'};base64,${part.data}` : undefined),
          ...(part.detail ? { detail: part.detail } : {}),
        },
      });
}

function contentToText(content: GatewayContentPart[]): string {
  return content
    .filter((part): part is Extract<GatewayContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function toOpenAiTool(tool: GatewayTool): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.inputSchema ?? { type: 'object' },
  };
}

function toAnthropicTool(tool: GatewayTool): Record<string, unknown> {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.inputSchema ?? { type: 'object' },
  };
}

function toChatTool(tool: GatewayTool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.inputSchema ?? { type: 'object' },
    },
  };
}

function providerStreamError(payload: Record<string, unknown>, status: number, secret?: string): GatewayProtocolError {
  const error = objectField(payload, 'error');
  const rawMessage = stringField(error, 'message') ?? stringField(payload, 'message') ?? 'Provider stream error';
  const message = secret ? redactSecret(rawMessage, secret) : rawMessage;
  return new GatewayProtocolError(message, {
    code: 'provider_error',
    status,
    details: {
      providerStatusCode: status,
      classification: classifyProviderStatus(status),
      providerErrorType: stringField(error, 'type') ?? stringField(payload, 'type'),
    },
  });
}

function anthopicErrorStatus(payload: Record<string, unknown>): number {
  const error = objectField(payload, 'error');
  const type = stringField(error, 'type');
  return type === 'overloaded_error' ? 503 : 502;
}

function compactUsage(usage: GatewayUsage): GatewayUsage | undefined {
  const compact = Object.fromEntries(
    Object.entries(usage).filter(([, value]) => value !== undefined),
  ) as GatewayUsage;
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

function normalizeRuntimeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GatewayProtocolError('Configured provider endpoint is not allowed', {
      code: 'invalid_request',
      status: 400,
    });
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new GatewayProtocolError('Configured provider endpoint is not allowed', {
      code: 'invalid_request',
      status: 400,
    });
  }
  if (url.pathname === '' || url.pathname === '/') {
    url.pathname = '/v1';
  }
  return trimTrailingSlash(url.href);
}

function redactSecret(value: string, secret: string): string {
  return secret ? value.split(secret).join('[REDACTED]') : value;
}
