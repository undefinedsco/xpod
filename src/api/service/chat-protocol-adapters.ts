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

export function sanitizeAiGatewayResponsesBody(body: any): any {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }

  const sanitized = { ...body };
  delete sanitized.vector_store_ids;
  return sanitized;
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
