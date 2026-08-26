function extractCompletionText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((item) => item && typeof item === 'object' && typeof (item as any).text === 'string')
      .map((item) => (item as any).text)
      .join('\n');
  }

  return content == null ? '' : String(content);
}

function copyDefinedFields(source: any, allowedFields: readonly string[]): Record<string, unknown> {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return {};
  }

  const projected: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (source[field] !== undefined) {
      projected[field] = source[field];
    }
  }
  return projected;
}

const SENSITIVE_GATEWAY_KEYS = new Set([
  'accesstoken',
  'access_token',
  'apikey',
  'api_key',
  'auth',
  'clientid',
  'client_id',
  'clientsecret',
  'client_secret',
  'credential',
  'credentialid',
  'credential_id',
  'credentials',
  'dpopproof',
  'dpop_proof',
  'metadata',
  'podurl',
  'pod_url',
  'proxy',
  'proxyurl',
  'proxy_url',
  'storageurl',
  'storage_url',
  'vector_store_ids',
  'webid',
  'web_id',
]);

function isSensitiveGatewayKey(key: string): boolean {
  return SENSITIVE_GATEWAY_KEYS.has(key.replace(/[-.]/g, '_').toLowerCase());
}

function stripSensitiveGatewayFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripSensitiveGatewayFields);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const projected: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!isSensitiveGatewayKey(key)) {
      projected[key] = stripSensitiveGatewayFields(child);
    }
  }
  return projected;
}

function projectChatToolCallFunction(fn: any): Record<string, unknown> | undefined {
  if (!fn || typeof fn !== 'object' || Array.isArray(fn)) {
    return undefined;
  }

  const projected = copyDefinedFields(fn, ['name', 'arguments']);
  return Object.keys(projected).length > 0
    ? stripSensitiveGatewayFields(projected) as Record<string, unknown>
    : undefined;
}

function projectChatToolCall(toolCall: any): Record<string, unknown> | undefined {
  if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) {
    return undefined;
  }

  const projected = copyDefinedFields(toolCall, ['id', 'type']);
  const fn = projectChatToolCallFunction(toolCall.function);
  if (fn) {
    projected.function = fn;
  }

  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectFunctionToolDefinition(fn: any): Record<string, unknown> | undefined {
  if (!fn || typeof fn !== 'object' || Array.isArray(fn)) {
    return undefined;
  }

  const projected = copyDefinedFields(fn, ['name', 'description', 'parameters', 'strict']);
  return Object.keys(projected).length > 0
    ? stripSensitiveGatewayFields(projected) as Record<string, unknown>
    : undefined;
}

function projectChatTool(tool: any): Record<string, unknown> | undefined {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool) || !tool.type) {
    return undefined;
  }

  const projected = copyDefinedFields(tool, ['type']);
  const fn = projectFunctionToolDefinition(tool.function);
  if (fn) {
    projected.function = fn;
  }

  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectResponsesTool(tool: any): Record<string, unknown> | undefined {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool) || !tool.type) {
    return undefined;
  }

  const projected = copyDefinedFields(tool, [
    'type',
    'name',
    'description',
    'parameters',
    'strict',
  ]);
  const fn = projectFunctionToolDefinition(tool.function);
  if (fn) {
    projected.function = fn;
  }

  return stripSensitiveGatewayFields(projected) as Record<string, unknown>;
}

function projectChatMessage(message: any): Record<string, unknown> | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message) || !message.role) {
    return undefined;
  }

  const projected = copyDefinedFields(message, [
    'role',
    'content',
    'name',
    'tool_call_id',
  ]);
  if (Array.isArray(message.tool_calls)) {
    projected.tool_calls = message.tool_calls.map(projectChatToolCall).filter(Boolean);
  }
  return projected;
}

export function buildAiGatewayChatCompletionsBody(body: any): Record<string, unknown> {
  const projected = copyDefinedFields(body, [
    'model',
    'temperature',
    'max_tokens',
    'max_completion_tokens',
    'top_p',
    'n',
    'stop',
    'stream',
    'stream_options',
    'presence_penalty',
    'frequency_penalty',
    'logit_bias',
    'response_format',
    'seed',
    'tool_choice',
    'parallel_tool_calls',
    'logprobs',
    'top_logprobs',
    'reasoning_effort',
  ]);
  if (Array.isArray(body?.tools)) {
    projected.tools = body.tools.map(projectChatTool).filter(Boolean);
  }

  const messages = Array.isArray(body?.messages)
    ? body.messages.map(projectChatMessage).filter(Boolean)
    : [];
  projected.messages = messages;
  return projected;
}

export function buildAiGatewayResponsesBody(body: any): Record<string, unknown> {
  const projected = copyDefinedFields(body, [
    'model',
    'input',
    'instructions',
    'temperature',
    'max_output_tokens',
    'top_p',
    'stream',
    'text',
    'reasoning',
    'reasoning_effort',
    'tool_choice',
    'parallel_tool_calls',
    'previous_response_id',
    'truncation',
    'include',
    'max_tool_calls',
  ]);
  if (Array.isArray(body?.tools)) {
    projected.tools = body.tools.map(projectResponsesTool).filter(Boolean);
  }
  return projected;
}

export function buildChatCompletionsBodyFromMessages(body: any): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [];

  if (body?.system) {
    const systemText = extractCompletionText(body.system);
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      if (!message?.role || message?.content == null) {
        continue;
      }

      messages.push({
        role: String(message.role),
        content: extractCompletionText(message.content),
      });
    }
  }

  if (messages.length === 0 && body?.content != null) {
    messages.push({
      role: 'user',
      content: extractCompletionText(body.content),
    });
  }

  return {
    model: body?.model,
    messages,
    ...(body?.temperature != null ? { temperature: body.temperature } : {}),
    ...(body?.max_tokens != null ? { max_tokens: body.max_tokens } : {}),
    ...(Array.isArray(body?.stop_sequences) && body.stop_sequences.length > 0
      ? { stop: body.stop_sequences }
      : {}),
  };
}

function mapChatCompletionFinishReason(reason: string | null | undefined): string {
  if (reason === 'length') {
    return 'max_tokens';
  }
  if (reason === 'content_filter') {
    return 'stop_sequence';
  }
  return 'end_turn';
}

export function extractPromptFromResponsesBody(body: any): string {
  if (!body || typeof body !== 'object') {
    return '';
  }

  if (typeof body.input === 'string') {
    return body.input;
  }

  if (typeof body.prompt === 'string') {
    return body.prompt;
  }

  if (Array.isArray(body.input)) {
    const textParts: string[] = [];
    for (const item of body.input) {
      if (item && typeof item === 'object') {
        const candidate = (item as any).content;
        if (typeof candidate === 'string') {
          textParts.push(candidate);
        } else if (Array.isArray(candidate)) {
          for (const part of candidate) {
            if (part && typeof part === 'object' && typeof (part as any).text === 'string') {
              textParts.push((part as any).text);
            }
          }
        }
      }
    }
    if (textParts.length > 0) {
      return textParts.join('\n');
    }
  }

  return '';
}

export function extractPromptFromMessagesBody(body: any): string {
  if (!body || typeof body !== 'object') {
    return '';
  }

  if (typeof body.content === 'string') {
    return body.content;
  }

  if (Array.isArray(body.messages)) {
    const lastUser = [...body.messages].reverse().find((item: any) => item?.role === 'user');
    if (lastUser) {
      if (typeof lastUser.content === 'string') {
        return lastUser.content;
      }
      if (Array.isArray(lastUser.content)) {
        return lastUser.content
          .filter((part: any) => part && typeof part === 'object' && typeof part.text === 'string')
          .map((part: any) => part.text)
          .join('\n');
      }
    }
  }

  return '';
}

export function mapChatCompletionToMessagesResponse(body: any, completion: any): any {
  const choice = Array.isArray(completion?.choices) ? completion.choices[0] : undefined;
  const text = extractCompletionText(choice?.message?.content);
  const prompt = extractPromptFromMessagesBody(body);

  return {
    id: completion?.id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: completion?.model ?? body?.model,
    content: [{ type: 'text', text }],
    stop_reason: mapChatCompletionFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: completion?.usage?.prompt_tokens ?? prompt.length,
      output_tokens: completion?.usage?.completion_tokens ?? text.length,
    },
  };
}
