import { getLoggerFor } from 'global-logger-factory';
import type { AuthContext } from '../auth/AuthContext';
import { GatewayProtocolError } from './errors';
import type { GatewayEvent, GatewayProtocol } from './types';
import type { GatewayModelProjection } from './routing/ModelRouter';

const DEFAULT_TIMEOUT_MS = 3_000;
const INFERENCE_TIMEOUT_MS = 60_000;

const PROTOCOL_PATH: Record<GatewayProtocol, string> = {
  chatCompletions: '/v1/chat/completions',
  responses: '/v1/responses',
  anthropic: '/v1/messages',
};

export interface CloudGatewayModelsClientOptions {
  cloudGatewayOrigin: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  inferenceTimeoutMs?: number;
}

/**
 * Local `/v1/models` splices Cloud's `/v1/models` by forwarding the caller's
 * Solid identity. Local inference without a usable Pod credential uses the
 * same identity on Cloud `/v1/chat/completions` (and sibling protocol
 * routes). Cloud recognizes that identity; this client never writes Cloud
 * rows into the Pod and never sends provider keys or local client secrets.
 */
export class CloudGatewayModelsClient {
  private readonly logger = getLoggerFor(this);
  public readonly modelsUrl: string;
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly inferenceTimeoutMs: number;

  public constructor(options: CloudGatewayModelsClientOptions) {
    this.origin = `${options.cloudGatewayOrigin.replace(/\/+$/u, '')}/`;
    this.modelsUrl = new URL('/v1/models', this.origin).href;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.inferenceTimeoutMs = options.inferenceTimeoutMs ?? INFERENCE_TIMEOUT_MS;
  }

  public async listModels(auth: AuthContext): Promise<GatewayModelProjection[]> {
    const authorization = callerIdentityAuthorization(auth);
    if (!authorization) {
      return [];
    }

    try {
      const response = await this.fetchImpl(this.modelsUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        this.logger.warn(`Cloud /v1/models returned ${response.status}; keeping local models only`);
        await response.arrayBuffer().catch(() => undefined);
        return [];
      }
      return parseCloudModelList(await response.json());
    } catch (error) {
      this.logger.warn(`Cloud /v1/models unreachable; keeping local models only: ${errorMessage(error)}`);
      return [];
    }
  }

  public async completeJson(input: {
    auth: AuthContext;
    protocol: GatewayProtocol;
    body: unknown;
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    const response = await this.inferenceResponse({
      ...input,
      stream: false,
      accept: 'application/json',
    });
    const payload = await readJsonObject(response);
    if (!response.ok) {
      throw cloudInferenceError(response.status, payload);
    }
    return payload;
  }

  public async *executeStream(input: {
    auth: AuthContext;
    protocol: GatewayProtocol;
    body: unknown;
    signal?: AbortSignal;
  }): AsyncIterable<GatewayEvent> {
    const response = await this.inferenceResponse({
      ...input,
      stream: true,
      accept: 'text/event-stream',
    });
    if (!response.ok) {
      throw cloudInferenceError(response.status, await readJsonObject(response).catch(() => undefined));
    }
    yield* parseCloudSse(response);
  }

  private async inferenceResponse(input: {
    auth: AuthContext;
    protocol: GatewayProtocol;
    body: unknown;
    stream: boolean;
    accept: string;
    signal?: AbortSignal;
  }): Promise<Response> {
    const authorization = callerIdentityAuthorization(input.auth);
    if (!authorization) {
      throw new GatewayProtocolError('Cloud inference requires a forwardable Solid Bearer identity', {
        code: 'credential_unavailable',
        status: 403,
      });
    }
    const timeout = AbortSignal.timeout(this.inferenceTimeoutMs);
    const linked = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const url = new URL(PROTOCOL_PATH[input.protocol], this.origin).href;
    const body = withStreamFlag(input.body, input.stream);
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          accept: input.accept,
          authorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: linked,
      });
    } catch (error) {
      this.logger.warn(`Cloud ${PROTOCOL_PATH[input.protocol]} unreachable: ${errorMessage(error)}`);
      throw new GatewayProtocolError('Cloud inference is unreachable', {
        code: 'provider_error',
        status: 502,
        cause: error,
      });
    }
  }
}

export function resolveCloudModelsGatewayOrigin(input: {
  edition: string;
  oidcIssuer?: string;
  solidBaseUrl?: string;
  publicUrl?: string;
}): string | undefined {
  if (input.edition !== 'local') {
    return undefined;
  }
  const issuer = input.oidcIssuer?.trim();
  if (!issuer) {
    return undefined;
  }
  const origin = originOf(issuer);
  if (!origin) {
    return undefined;
  }
  const localOrigins = new Set(
    [input.solidBaseUrl, input.publicUrl]
      .map((value) => originOf(value))
      .filter((value): value is string => Boolean(value)),
  );
  if (localOrigins.has(origin)) {
    return undefined;
  }
  return origin;
}

export function unionGatewayModelLists(
  local: readonly GatewayModelProjection[],
  cloud: readonly GatewayModelProjection[],
): GatewayModelProjection[] {
  const seen = new Set(local.map((model) => model.id.toLowerCase()));
  const merged = [...local];
  for (const model of cloud) {
    const key = model.id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(model);
  }
  return merged;
}

export function callerIdentityAuthorization(auth: AuthContext): string | undefined {
  if (auth.type !== 'solid') {
    return undefined;
  }
  if (auth.tokenType === 'DPoP' || typeof auth.dpopProof === 'string') {
    return undefined;
  }
  const accessToken = auth.accessToken?.trim();
  if (!accessToken) {
    return undefined;
  }
  return `Bearer ${accessToken}`;
}

function parseCloudModelList(payload: unknown): GatewayModelProjection[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [];
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }
  const models: GatewayModelProjection[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const model = projectCloudModel(item);
    if (!model) {
      continue;
    }
    const key = model.id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    models.push(model);
  }
  return models;
}

function projectCloudModel(item: unknown): GatewayModelProjection | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return undefined;
  }
  const record = item as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) {
    return undefined;
  }
  const ownedBy = typeof record.owned_by === 'string' && record.owned_by.trim()
    ? record.owned_by.trim()
    : 'cloud';
  const projection: GatewayModelProjection = {
    id,
    object: 'model',
    owned_by: ownedBy,
  };
  if (typeof record.context_window === 'number' && Number.isFinite(record.context_window)) {
    projection.context_window = record.context_window;
  }
  if (record.capabilities && typeof record.capabilities === 'object' && !Array.isArray(record.capabilities)) {
    projection.capabilities = record.capabilities as GatewayModelProjection['capabilities'];
  }
  if (Array.isArray(record.protocols)) {
    projection.protocols = record.protocols.filter((value): value is NonNullable<GatewayModelProjection['protocols']>[number] =>
      typeof value === 'string');
  }
  if (record.custom === true) {
    projection.custom = true;
  }
  if (typeof record.display_name === 'string' && record.display_name.trim()) {
    projection.display_name = record.display_name.trim();
  }
  if (record.modalities && typeof record.modalities === 'object' && !Array.isArray(record.modalities)) {
    projection.modalities = record.modalities as GatewayModelProjection['modalities'];
  }
  if (Array.isArray(record.custom_capabilities)) {
    projection.custom_capabilities = record.custom_capabilities.filter((value): value is string => typeof value === 'string');
  }
  return projection;
}

function withStreamFlag(body: unknown, stream: boolean): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  return { ...(body as Record<string, unknown>), stream };
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => undefined);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  return payload as Record<string, unknown>;
}

function cloudInferenceError(status: number, payload: Record<string, unknown> | undefined): GatewayProtocolError {
  const error = payload?.error;
  const record = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : undefined;
  const message = typeof record?.message === 'string' && record.message.trim()
    ? record.message.trim()
    : `Cloud inference failed with HTTP ${status}`;
  const code = record?.code === 'model_not_available' || record?.code === 'credential_unavailable' || record?.code === 'invalid_request'
    ? record.code
    : status >= 500 ? 'provider_error' : 'provider_error';
  return new GatewayProtocolError(message, {
    code,
    status: typeof record?.status === 'number' ? record.status : status,
  });
}

async function* parseCloudSse(response: Response): AsyncIterable<GatewayEvent> {
  if (!response.body) {
    throw new GatewayProtocolError('Cloud stream ended before emitting any gateway event', {
      code: 'provider_error',
      status: 502,
    });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let started = false;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = sseData(frame);
        if (data === undefined) {
          continue;
        }
        if (data === '[DONE]') {
          if (started && !completed) {
            completed = true;
            yield { type: 'response.completed', finishReason: 'stop' };
          }
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        for (const event of eventsFromCloudChunk(payload, started)) {
          if (event.type === 'response.started') {
            started = true;
          }
          if (event.type === 'response.completed') {
            if (completed) {
              continue;
            }
            completed = true;
          }
          yield event;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!started) {
    throw new GatewayProtocolError('Cloud stream ended before emitting any gateway event', {
      code: 'provider_error',
      status: 502,
    });
  }
  if (!completed) {
    yield { type: 'response.completed', finishReason: 'stop' };
  }
}

function sseData(frame: string): string | undefined {
  const lines = frame.split(/\r?\n/u)
    .map((line) => line.startsWith('data:') ? line.slice(5).trim() : undefined)
    .filter((line): line is string => line !== undefined);
  if (lines.length === 0) {
    return undefined;
  }
  return lines.join('\n');
}

function eventsFromCloudChunk(payload: unknown, started: boolean): GatewayEvent[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [];
  }
  const record = payload as Record<string, unknown>;
  const events: GatewayEvent[] = [];
  if (!started) {
    const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : 'cloud';
    events.push({ type: 'response.started', id });
  }
  const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
  const delta = choice && typeof choice === 'object' && !Array.isArray(choice)
    ? (choice as Record<string, unknown>).delta
    : undefined;
  const deltaRecord = delta && typeof delta === 'object' && !Array.isArray(delta)
    ? delta as Record<string, unknown>
    : undefined;
  const content = typeof deltaRecord?.content === 'string' ? deltaRecord.content
    : typeof (choice as { message?: { content?: unknown } } | undefined)?.message?.content === 'string'
      ? String((choice as { message: { content: string } }).message.content)
      : undefined;
  if (content) {
    events.push({ type: 'text.delta', text: content });
  }
  const finish = choice && typeof choice === 'object' && !Array.isArray(choice)
    ? (choice as Record<string, unknown>).finish_reason
    : undefined;
  if (typeof finish === 'string' && finish && finish !== 'null') {
    events.push({ type: 'response.completed', finishReason: finish });
  }
  return events;
}

function originOf(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
