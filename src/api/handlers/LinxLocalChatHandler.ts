import type { ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { ProxyAgent } from 'undici';
import { getSharedPool } from '../../storage/database/PostgresPoolManager';
import {
  inferProviderFromModel,
  normalizeBaseUrl,
  normalizeModelId,
  normalizeProviderId,
  readPodLocalAIConfig,
  recordCandidateFailure,
  recordCandidateSuccess,
  resolvePodBaseFromWebId,
  type LocalAICandidate,
  type LocalAIConfig,
} from '../service/LinxModelConfigRepository';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ApiServer } from '../ApiServer';
import { getWebId } from '../auth/AuthContext';

export { selectLocalAICandidates } from '../service/LinxModelConfigRepository';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const MEETING_MESSAGE = 'http://www.w3.org/ns/pim/meeting#Message';
const WF_MESSAGE = 'http://www.w3.org/2005/01/wf/flow-1.0#message';
const SIOC_HAS_MEMBER = 'http://rdfs.org/sioc/ns#has_member';
const SIOC_CONTENT = 'http://rdfs.org/sioc/ns#content';
const SIOC_RICH_CONTENT = 'http://rdfs.org/sioc/ns#richContent';
const FOAF_MAKER = 'http://xmlns.com/foaf/0.1/maker';
const DCT_CREATED = 'http://purl.org/dc/terms/created';
const UDFS_MESSAGE_TYPE = 'https://undefineds.co/ns#messageType';
const UDFS_MESSAGE_STATUS = 'https://undefineds.co/ns#messageStatus';
const DEFAULT_LLM_TIMEOUT_MS = 60_000;

interface LocalChatBody {
  chatId?: string;
  threadId?: string;
  webId?: string;
  content?: string;
  provider?: string;
  model?: string;
  stream?: boolean;
  attachments?: LocalChatAttachment[];
}

interface LocalChatAttachment {
  filename?: string;
  mimeType?: string;
  dataUrl?: string;
  fileData?: string;
  fileUrl?: string;
  fileId?: string;
}

export function registerLinxLocalChatRoutes(server: ApiServer): void {
  server.get('/v1/linx/local-chat/messages', async (request, response) => {
    const url = new URL(request.url ?? '', `http://${request.headers.host ?? 'localhost'}`);
    const webId = resolveAuthenticatedWebId(request, response);
    if (!webId) return;
    const chatGraph = normalizeChatGraph(url.searchParams.get('chatId'), webId);
    const threadId = normalizeThreadId(url.searchParams.get('threadId'));

    if (!chatGraph || !threadId) {
      sendJson(response, 400, { error: 'chatId and threadId are required' });
      return;
    }

    try {
      const messages = await listMessages({ chatGraph, threadId });
      sendJson(response, 200, { messages });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.post('/v1/linx/local-chat', async (request, response) => {
    const body = await readJsonBody(request) as LocalChatBody | undefined;
    const webId = resolveAuthenticatedWebId(request, response);
    if (!webId) return;
    if (typeof body?.webId === 'string' && body.webId && body.webId !== webId) {
      sendJson(response, 403, { error: 'webId does not match authenticated user' });
      return;
    }
    const chatGraph = normalizeChatGraph(body?.chatId, webId);
    const threadId = normalizeThreadId(body?.threadId);
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    const requestedProvider = typeof body?.provider === 'string' && body.provider ? body.provider : undefined;
    const requestedModel = typeof body?.model === 'string' && body.model ? body.model : undefined;
    const attachments = normalizeLocalChatAttachments(body?.attachments);

    if (!chatGraph || !threadId || (!content && attachments.length === 0)) {
      sendJson(response, 400, { error: 'chatId, threadId, and content or attachments are required' });
      return;
    }

    try {
      const userMessageId = randomUUID();
      const assistantMessageId = randomUUID();
      const wantsStream = body?.stream === true || request.headers.accept?.includes('text/event-stream') === true;

      if (wantsStream) {
        await streamLocalChatResponse(response, {
          chatGraph,
          threadId,
          webId,
          content,
          requestedProvider,
          requestedModel,
          attachments,
          userMessageId,
          assistantMessageId,
        });
        return;
      }

      const aiConfig = await resolveLocalAIConfig({ provider: requestedProvider, model: requestedModel, webId });
      const reply = await completeLocalChat(aiConfig, content, attachments);
      await insertMessage({
        chatGraph,
        threadId,
        messageId: userMessageId,
        maker: webId,
        role: 'user',
        content,
        richContent: buildAttachmentRichContent(attachments),
        status: 'completed',
      });

      await insertMessage({
        chatGraph,
        threadId,
        messageId: assistantMessageId,
        maker: webId,
        role: 'assistant',
        content: reply,
        status: 'completed',
      });

      sendJson(response, 200, {
        ok: true,
        model: aiConfig.model,
        userMessage: { id: userMessageId, role: 'user', content },
        assistantMessage: { id: assistantMessageId, role: 'assistant', content: reply },
      });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function listMessages(input: {
  chatGraph: string;
  threadId: string;
}): Promise<Array<{
  id: string;
  role: string;
  content: string;
  richContent?: string;
  status?: string;
  createdAt?: string;
}>> {
  const graph = input.chatGraph;
  const thread = `${graph}#${input.threadId}`;
  const pool = getSharedPool({ connectionString: resolveDatabaseUrl() });
  const memberRows = await pool.query(
    `SELECT object_key FROM quints
     WHERE graph = $1 AND subject = $2 AND predicate = $3
     ORDER BY object_key ASC`,
    [graph, thread, SIOC_HAS_MEMBER],
  );
  const subjects = memberRows.rows
    .map((row: { object_key?: string | null }) => row.object_key)
    .filter((value: string | null | undefined): value is string => typeof value === 'string' && value.length > 0);

  if (subjects.length === 0) return [];

  const rows = await pool.query(
    `SELECT subject, predicate, object_text
     FROM quints
     WHERE graph = $1 AND subject = ANY($2)
     ORDER BY subject ASC`,
    [graph, subjects],
  );
  const bySubject = new Map<string, Record<string, string>>();
  for (const row of rows.rows as Array<{ subject: string; predicate: string; object_text?: string | null }>) {
    const current = bySubject.get(row.subject) ?? {};
    current[row.predicate] = row.object_text ?? '';
    bySubject.set(row.subject, current);
  }

  return subjects
    .map((subject) => {
      const values = bySubject.get(subject);
      if (!values) return null;
      return {
        id: subject.split('#').pop() ?? subject,
        role: values[UDFS_MESSAGE_TYPE] || 'user',
        content: values[SIOC_CONTENT] || '',
        richContent: values[SIOC_RICH_CONTENT] || undefined,
        status: values[UDFS_MESSAGE_STATUS] || undefined,
        createdAt: values[DCT_CREATED] || undefined,
      };
    })
    .filter((message): message is NonNullable<typeof message> => message !== null)
    .sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
}

async function streamLocalChatResponse(
  response: ServerResponse,
  input: {
    chatGraph: string;
    threadId: string;
    webId: string;
    content: string;
    requestedProvider?: string;
    requestedModel?: string;
    attachments: LocalChatAttachment[];
    userMessageId: string;
    assistantMessageId: string;
  },
): Promise<void> {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders?.();

  try {
    sendSse(response, 'user_message', {
      id: input.userMessageId,
      role: 'user',
      content: input.content,
    });

    await insertMessage({
      chatGraph: input.chatGraph,
      threadId: input.threadId,
      messageId: input.userMessageId,
      maker: input.webId,
      role: 'user',
      content: input.content,
      richContent: buildAttachmentRichContent(input.attachments),
      status: 'completed',
    });

    const aiConfig = await resolveLocalAIConfig({
      provider: input.requestedProvider,
      model: input.requestedModel,
      webId: input.webId,
    });
    const reply = await completeLocalChatStream(
      aiConfig,
      input.content,
      (delta) => {
        sendSse(response, 'assistant_delta', {
          id: input.assistantMessageId,
          role: 'assistant',
          delta,
        });
      },
      input.attachments,
    );

    await insertMessage({
      chatGraph: input.chatGraph,
      threadId: input.threadId,
      messageId: input.assistantMessageId,
      maker: input.webId,
      role: 'assistant',
      content: reply,
      status: 'completed',
    });

    sendSse(response, 'assistant_done', {
      id: input.assistantMessageId,
      role: 'assistant',
      content: reply,
      model: aiConfig.model,
    });
    sendSse(response, 'done', { ok: true });
  } catch (error) {
    sendSse(response, 'error', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    response.end();
  }
}

async function completeLocalChat(
  aiConfig: LocalAIConfig,
  content: string,
  attachments: LocalChatAttachment[] = [],
): Promise<string> {
  if (aiConfig.candidates.length === 0) {
    return 'OK';
  }

  let lastError: unknown;
  for (const candidate of aiConfig.candidates) {
    try {
      const reply = await completeLocalChatWithCandidate(aiConfig.model, content, candidate, attachments);
      await recordCandidateSuccess(candidate);
      return reply;
    } catch (error) {
      lastError = error;
      await recordCandidateFailure(candidate, error);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('LLM request failed');
}

async function completeLocalChatStream(
  aiConfig: LocalAIConfig,
  content: string,
  onDelta: (delta: string) => void,
  attachments: LocalChatAttachment[] = [],
): Promise<string> {
  if (aiConfig.candidates.length === 0) {
    onDelta('OK');
    return 'OK';
  }

  let lastError: unknown;
  for (const candidate of aiConfig.candidates) {
    try {
      const reply = await completeLocalChatStreamWithCandidate(aiConfig.model, content, candidate, onDelta, attachments);
      await recordCandidateSuccess(candidate);
      return reply;
    } catch (error) {
      lastError = error;
      await recordCandidateFailure(candidate, error);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('LLM stream request failed');
}

async function completeLocalChatWithCandidate(
  model: string,
  content: string,
  candidate: LocalAICandidate,
  attachments: LocalChatAttachment[] = [],
): Promise<string> {
  try {
    return await completeLocalChatWithResponsesCandidate(model, content, candidate, attachments);
  } catch (error) {
    if (!isResponsesApiUnsupportedError(error)) {
      throw error;
    }
  }

  if (attachments.length > 0) {
    throw new Error('File and image attachments require a provider that supports the Responses API.');
  }

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetchWithCandidateTimeout(candidate, `${normalizeChatCompletionsBaseUrl(candidate.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${candidate.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
      }),
    });

    if (response.ok) {
      const data = await response.json() as any;
      return extractCompletionContent(data) || 'OK';
    }

    const text = await response.text().catch(() => '');
    lastError = llmRequestError(response.status, text);
    if (!isTransientUpstreamStatus(response.status)) {
      throw lastError;
    }
  }

  throw lastError ?? new Error('LLM request failed');
}

async function completeLocalChatStreamWithCandidate(
  model: string,
  content: string,
  candidate: LocalAICandidate,
  onDelta: (delta: string) => void,
  attachments: LocalChatAttachment[] = [],
): Promise<string> {
  try {
    return await completeLocalChatStreamWithResponsesCandidate(model, content, candidate, onDelta, attachments);
  } catch (error) {
    if (!isResponsesApiUnsupportedError(error)) {
      throw error;
    }
  }

  if (attachments.length > 0) {
    throw new Error('File and image attachments require a provider that supports the Responses API.');
  }

  const response = await fetchWithCandidateTimeout(candidate, `${normalizeChatCompletionsBaseUrl(candidate.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${candidate.apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    try {
      const reply = await completeLocalChatWithCandidate(model, content, candidate, attachments);
      onDelta(reply);
      return reply;
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`LLM stream request failed: ${response.status} ${text.slice(0, 200)}; non-stream fallback failed: ${fallbackMessage}`);
    }
  }

  const contentType = response.headers.get('content-type') || '';
  if (!response.body || !contentType.includes('text/event-stream')) {
    const data = await response.json() as any;
    const reply = extractCompletionContent(data) || 'OK';
    onDelta(reply);
    return reply;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';

    for (const event of events) {
      const delta = extractSseDelta(event);
      if (!delta) continue;
      reply += delta;
      onDelta(delta);
    }
  }

  return reply || 'OK';
}

async function completeLocalChatWithResponsesCandidate(
  model: string,
  content: string,
  candidate: LocalAICandidate,
  attachments: LocalChatAttachment[] = [],
): Promise<string> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetchWithCandidateTimeout(candidate, `${normalizeResponsesBaseUrl(candidate.baseUrl)}/responses`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${candidate.apiKey}`,
      },
      body: JSON.stringify(buildResponsesBody(model, content, false, attachments)),
    });

    if (response.ok) {
      const data = await response.json() as any;
      return extractGeneratedContent(data) || 'OK';
    }

    const text = await response.text().catch(() => '');
    lastError = llmRequestError(response.status, text);
    if (isResponsesApiUnsupported(response.status, text)) {
      throw lastError;
    }
    if (!isTransientUpstreamStatus(response.status)) {
      throw lastError;
    }
  }

  throw lastError ?? new Error('Responses API request failed');
}

async function completeLocalChatStreamWithResponsesCandidate(
  model: string,
  content: string,
  candidate: LocalAICandidate,
  onDelta: (delta: string) => void,
  attachments: LocalChatAttachment[] = [],
): Promise<string> {
  const response = await fetchWithCandidateTimeout(candidate, `${normalizeResponsesBaseUrl(candidate.baseUrl)}/responses`, {
    method: 'POST',
    headers: {
      'Accept': 'text/event-stream, application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${candidate.apiKey}`,
    },
    body: JSON.stringify(buildResponsesBody(model, content, true, attachments)),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw llmRequestError(response.status, text);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!response.body || contentType.includes('application/json')) {
    const data = await response.json() as any;
    const reply = extractGeneratedContent(data) || 'OK';
    onDelta(reply);
    return reply;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply = '';
  let completedText = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';

    for (const event of events) {
      const parsed = parseSseJsonEvent(event);
      if (!parsed) continue;
      if (parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
        reply += parsed.delta;
        onDelta(parsed.delta);
        continue;
      }

      if (parsed.type === 'response.completed') {
        completedText = extractGeneratedContent(parsed.response) || completedText;
      }
      if (parsed.type === 'error') {
        const message = typeof parsed.message === 'string'
          ? parsed.message
          : typeof parsed.error?.message === 'string'
            ? parsed.error.message
            : 'Responses API stream failed';
        throw new Error(message);
      }
    }
  }

  if (!reply && buffer.trim()) {
    const parsed = parseSseJsonEvent(buffer);
    const tailText = parsed ? extractGeneratedContent(parsed.response ?? parsed) : '';
    if (tailText) {
      reply = tailText;
      onDelta(tailText);
    }
  }

  if (!reply && completedText) {
    reply = completedText;
    onDelta(completedText);
  }

  return reply || 'OK';
}

export async function resolveLocalAIConfig(input: {
  provider?: string;
  model?: string;
  webId?: string;
} = {}): Promise<LocalAIConfig> {
  const requestedProviderId = normalizeProviderId(input.provider || process.env.DEFAULT_PROVIDER || inferProviderFromModel(input.model) || 'openai');
  const requestedModel = normalizeModelId(input.model);
  const envBaseUrl = normalizeBaseUrl(process.env.DEFAULT_API_BASE);
  const envApiKey = process.env.DEFAULT_API_KEY?.trim() || '';
  const envProviderId = normalizeProviderId(process.env.DEFAULT_PROVIDER || 'openai');
  const shouldUseEnvFirst = Boolean(envBaseUrl && envApiKey.length > 0)
    && Boolean(input.provider || input.model)
    && requestedProviderId === envProviderId
    && (!requestedModel || requestedModel === normalizeModelId(process.env.DEFAULT_MODEL));

  if (shouldUseEnvFirst) {
    return {
      providerId: requestedProviderId,
      model: requestedModel || process.env.DEFAULT_MODEL || 'gpt-5.5',
      source: 'env',
      candidates: [{
        providerId: requestedProviderId,
        credential: {},
        apiKey: envApiKey,
        baseUrl: envBaseUrl,
        proxyUrl: resolveOutboundProxyUrl(),
      }],
    };
  }

  const podConfig = await readPodLocalAIConfig(requestedProviderId, input.webId).catch(() => null);
  if (podConfig) {
    return {
      providerId: podConfig.providerId,
      model: requestedModel || podConfig.model || process.env.DEFAULT_MODEL || 'gpt-5.5',
      candidates: podConfig.candidates,
      source: 'pod',
    };
  }

  if (envBaseUrl && envApiKey.length > 0) {
    return {
      providerId: requestedProviderId,
      model: requestedModel || process.env.DEFAULT_MODEL || 'gpt-5.5',
      source: 'env',
      candidates: [{
        providerId: requestedProviderId,
        credential: {},
        apiKey: envApiKey,
        baseUrl: envBaseUrl,
        proxyUrl: resolveOutboundProxyUrl(),
      }],
    };
  }

  return {
    providerId: requestedProviderId,
    model: requestedModel || process.env.DEFAULT_MODEL || 'gpt-5.5',
    candidates: [],
    source: 'none',
  };
}

function normalizeChatCompletionsBaseUrl(value: string): string {
  return normalizeBaseUrl(value);
}

function normalizeResponsesBaseUrl(value: string): string {
  return normalizeBaseUrl(value);
}

function buildResponsesBody(
  model: string,
  content: string,
  stream: boolean,
  attachments: LocalChatAttachment[] = [],
): Record<string, unknown> {
  const inputContent = buildResponsesInputContent(content, attachments);

  return {
    model,
    input: [{
      role: 'user',
      content: inputContent.length > 0 ? inputContent : [{ type: 'input_text', text: content }],
    }],
    stream,
    max_output_tokens: 2048,
  };
}

function buildResponsesInputContent(
  content: string,
  attachments: LocalChatAttachment[],
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (content.trim()) {
    parts.push({ type: 'input_text', text: content });
  }

  for (const attachment of attachments) {
    const part = buildResponsesAttachmentPart(attachment);
    if (part) parts.push(part);
  }

  return parts;
}

function buildResponsesAttachmentPart(attachment: LocalChatAttachment): Record<string, unknown> | null {
  const filename = pickNonEmptyString(attachment.filename);
  const mimeType = pickNonEmptyString(attachment.mimeType);
  const dataUrl = pickNonEmptyString(attachment.dataUrl);
  const fileData = pickNonEmptyString(attachment.fileData);
  const fileUrl = pickNonEmptyString(attachment.fileUrl);
  const fileId = pickNonEmptyString(attachment.fileId);

  if (fileId) {
    return { type: 'input_file', file_id: fileId };
  }

  if (mimeType?.startsWith('image/') && dataUrl) {
    return {
      type: 'input_image',
      image_url: dataUrl,
    };
  }

  if (fileData) {
    return {
      type: 'input_file',
      file_data: fileData,
      ...(filename ? { filename } : {}),
    };
  }

  if (fileUrl) {
    return {
      type: 'input_file',
      file_url: fileUrl,
      ...(filename ? { filename } : {}),
    };
  }

  return null;
}

function normalizeLocalChatAttachments(value: unknown): LocalChatAttachment[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      filename: pickNonEmptyString(item.filename) ?? pickNonEmptyString(item.name) ?? undefined,
      mimeType: pickNonEmptyString(item.mimeType) ?? pickNonEmptyString(item.mime_type) ?? pickNonEmptyString(item.type) ?? undefined,
      dataUrl: pickNonEmptyString(item.dataUrl) ?? pickNonEmptyString(item.data_url) ?? undefined,
      fileData: pickNonEmptyString(item.fileData) ?? pickNonEmptyString(item.file_data) ?? pickNonEmptyString(item.data) ?? undefined,
      fileUrl: pickNonEmptyString(item.fileUrl) ?? pickNonEmptyString(item.file_url) ?? pickNonEmptyString(item.url) ?? undefined,
      fileId: pickNonEmptyString(item.fileId) ?? pickNonEmptyString(item.file_id) ?? undefined,
    }))
    .filter((item) => Boolean(item.dataUrl || item.fileData || item.fileUrl || item.fileId));
}

function buildAttachmentRichContent(attachments: LocalChatAttachment[]): string | undefined {
  const items = attachments
    .map<Record<string, unknown> | null>((attachment) => {
      const filename = pickNonEmptyString(attachment.filename) ?? '附件';
      const mimeType = pickNonEmptyString(attachment.mimeType) ?? 'application/octet-stream';
      const dataUrl = pickNonEmptyString(attachment.dataUrl)
        ?? (pickNonEmptyString(attachment.fileData) ? `data:${mimeType};base64,${pickNonEmptyString(attachment.fileData)}` : null);
      const fileUrl = pickNonEmptyString(attachment.fileUrl) ?? dataUrl ?? pickNonEmptyString(attachment.fileId);

      if (mimeType.startsWith('image/') && dataUrl) {
        return {
          type: 'image',
          url: dataUrl,
          metadata: { filename, mimeType },
        };
      }

      if (fileUrl) {
        return {
          type: 'file',
          fileName: filename,
          fileUrl,
          mimeType,
        };
      }

      return null;
    })
    .filter((item): item is Record<string, unknown> => item !== null);

  return items.length > 0 ? JSON.stringify({ items }) : undefined;
}

function pickNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isTransientUpstreamStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function llmRequestError(status: number, text: string): Error {
  const error = new Error(`LLM request failed: ${status} ${text.slice(0, 200)}`);
  (error as any).status = status;
  (error as any).body = text;
  return error;
}

function isResponsesApiUnsupportedError(error: unknown): boolean {
  const status = typeof error === 'object' && error ? (error as { status?: unknown }).status : undefined;
  const body = typeof error === 'object' && error ? (error as { body?: unknown }).body : undefined;
  return typeof status === 'number' && isResponsesApiUnsupported(status, typeof body === 'string' ? body : String(error));
}

function isResponsesApiUnsupported(status: number, bodyText: string): boolean {
  if ([404, 405, 501].includes(status)) return true;
  if (![400, 422].includes(status)) return false;

  const normalized = bodyText.toLowerCase();
  return normalized.includes('responses')
    && (
      normalized.includes('not found')
      || normalized.includes('unknown')
      || normalized.includes('unsupported')
      || normalized.includes('not supported')
      || normalized.includes('invalid endpoint')
    );
}

function parseSseJsonEvent(event: string): any | null {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');

  if (!data || data === '[DONE]') return null;

  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function extractSseDelta(event: string): string {
  const dataLines = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());

  let delta = '';
  for (const dataLine of dataLines) {
    if (!dataLine || dataLine === '[DONE]') continue;

    try {
      delta += extractCompletionContent(JSON.parse(dataLine), true);
    } catch {
      // Ignore malformed stream frames and continue consuming later chunks.
    }
  }
  return delta;
}

function extractCompletionContent(data: any, preferDelta = false): string {
  const choice = data?.choices?.[0];
  if (preferDelta) {
    return choice?.delta?.content
      ?? choice?.message?.content
      ?? data?.delta
      ?? data?.content
      ?? '';
  }
  return choice?.message?.content
    ?? choice?.delta?.content
    ?? data?.content
    ?? '';
}

function extractGeneratedContent(data: any): string {
  const completionContent = extractCompletionContent(data);
  if (completionContent) return completionContent;

  if (typeof data?.output_text === 'string') {
    return data.output_text;
  }

  const output = Array.isArray(data?.output)
    ? data.output
    : Array.isArray(data?.response?.output)
      ? data.response.output
      : [];

  return output
    .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
    .map((part: any) => {
      if (part?.type === 'output_text' && typeof part.text === 'string') return part.text;
      if (part?.type === 'text' && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('');
}

async function fetchWithCandidateTimeout(
  candidate: LocalAICandidate,
  input: string,
  init: RequestInit,
): Promise<Response> {
  const timeoutMs = candidate.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await createOutboundFetch(candidate.proxyUrl)(input, {
      ...init,
      signal: init.signal ?? controller.signal,
    } as any);
  } catch (error) {
    if (isAbortLikeError(error)) {
      const timeoutError = new Error(`LLM request timed out after ${timeoutMs}ms`);
      (timeoutError as any).status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isAbortLikeError(error: unknown): boolean {
  return typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError';
}

function createOutboundFetch(proxyUrl?: string): typeof fetch {
  const outboundProxyUrl = proxyUrl || resolveOutboundProxyUrl();
  if (!outboundProxyUrl) return fetch;

  const agent = new ProxyAgent(outboundProxyUrl);
  return (input, init) => fetch(input, { ...init, dispatcher: agent } as any);
}

function resolveOutboundProxyUrl(): string | undefined {
  return [
    process.env.DEFAULT_PROXY_URL,
    process.env.HTTPS_PROXY,
    process.env.HTTP_PROXY,
    process.env.ALL_PROXY,
  ].find((value) => value?.startsWith('http://') || value?.startsWith('https://'));
}

async function insertMessage(input: {
  chatGraph: string;
  threadId: string;
  messageId: string;
  maker: string;
  role: 'user' | 'assistant';
  content: string;
  richContent?: string;
  status: string;
}): Promise<void> {
  const graph = input.chatGraph;
  const subject = `${graph}#${input.messageId}`;
  const chat = `${graph}#this`;
  const thread = `${graph}#${input.threadId}`;
  const createdAt = new Date().toISOString();

  const rows = [
    iri(graph, subject, RDF_TYPE, MEETING_MESSAGE),
    iri(graph, chat, WF_MESSAGE, subject),
    iri(graph, thread, SIOC_HAS_MEMBER, subject),
    iri(graph, subject, FOAF_MAKER, input.maker),
    text(graph, subject, UDFS_MESSAGE_TYPE, input.role),
    text(graph, subject, SIOC_CONTENT, input.content),
    input.richContent ? longText(graph, subject, SIOC_RICH_CONTENT, input.richContent) : null,
    text(graph, subject, UDFS_MESSAGE_STATUS, input.status),
    literal(graph, subject, DCT_CREATED, `"${createdAt}"^^http://www.w3.org/2001/XMLSchema#dateTime`, createdAt),
  ].filter((row): row is ReturnType<typeof iri> => row !== null);

  const pool = getSharedPool({ connectionString: resolveDatabaseUrl() });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      await client.query(
        `INSERT INTO quints (graph, subject, predicate, object, object_kind, object_key, object_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.graph, row.subject, row.predicate, row.object, row.object_kind, row.object_key, row.object_text],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function iri(graph: string, subject: string, predicate: string, object: string) {
  return { graph, subject, predicate, object, object_kind: 'iri', object_key: object, object_text: '' };
}

function text(graph: string, subject: string, predicate: string, value: string) {
  const object = JSON.stringify(value);
  return { graph, subject, predicate, object, object_kind: 'text', object_key: object, object_text: value };
}

function longText(graph: string, subject: string, predicate: string, value: string) {
  const object = JSON.stringify(value);
  const objectKey = object.length > 512
    ? `sha256:${createHash('sha256').update(object).digest('hex')}`
    : object;
  return { graph, subject, predicate, object, object_kind: 'text', object_key: objectKey, object_text: value };
}

function literal(graph: string, subject: string, predicate: string, object: string, objectText: string) {
  return { graph, subject, predicate, object, object_kind: 'literal', object_key: object, object_text: objectText };
}

function resolveDatabaseUrl(): string {
  return process.env.CSS_SPARQL_ENDPOINT
    || process.env.CSS_IDENTITY_DB_URL
    || process.env.DATABASE_URL
    || 'postgresql://postgres:postgres@localhost:5432/xpod_local';
}

function resolveAuthenticatedWebId(request: AuthenticatedRequest, response: ServerResponse): string | null {
  const webId = request.auth ? getWebId(request.auth) : undefined;
  if (!webId) {
    sendJson(response, 401, { error: 'Solid authentication is required' });
    return null;
  }
  return webId;
}

function normalizeChatGraph(value: unknown, webId?: string): string | null {
  if (typeof value !== 'string' || !value) return null;
  const trimmed = value.trim();
  const withoutHash = trimmed.split('#')[0];
  const podBase = resolvePodBaseFromWebId(webId);
  if (!podBase) return null;
  const chatRoot = new URL('.data/chat/', podBase);

  if (/^https?:\/\/.+\/\.data\/chat\/.+(?:\.ttl|\/index\.ttl)$/.test(withoutHash)) {
    try {
      const graph = new URL(withoutHash);
      const isOwnedChatResource = graph.origin === chatRoot.origin
        && graph.pathname.startsWith(chatRoot.pathname)
        && (graph.pathname.endsWith('.ttl') || graph.pathname.endsWith('/index.ttl'));
      if (!isOwnedChatResource) return null;

      graph.search = '';
      graph.hash = '';
      return graph.href;
    } catch {
      return null;
    }
  }

  const chatId = normalizeChatId(trimmed);
  if (!chatId) return null;

  return new URL(`.data/chat/${encodeURIComponent(chatId)}/index.ttl`, podBase).href;
}

function normalizeChatId(value: string): string | null {
  const flatMatch = value.match(/\/\.data\/chat\/([^/#?]+)\.ttl(?:#.*)?$/);
  if (flatMatch?.[1]) return flatMatch[1];

  const legacyMatch = value.match(/\/\.data\/chat\/([^/#?]+)\/index\.ttl(?:#.*)?$/);
  if (legacyMatch?.[1]) return legacyMatch[1];

  if (value.includes('#')) {
    const fragment = value.split('#').pop();
    return fragment && fragment !== 'this' ? fragment : null;
  }

  return value;
}

function normalizeThreadId(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return value.includes('#') ? value.split('#').pop() || value : value;
}

async function readJsonBody(request: AuthenticatedRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { data += chunk; });
    request.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        resolve(undefined);
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}

function sendSse(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}
