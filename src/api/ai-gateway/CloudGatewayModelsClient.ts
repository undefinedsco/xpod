import { gatewayInvocationHeaders, type GatewayInvocationMetadata } from './InvocationMetadata';
import { getLoggerFor } from 'global-logger-factory';
import type { AuthContext } from '../auth/AuthContext';
import { GatewayProtocolError } from './errors';
import type { GatewayEvent, GatewayProtocol } from './types';
import type { GatewayModelProjection } from './routing/ModelRouter';
import { parseGatewayModelList } from './models/GatewayModelProjection';
import { parseSseStream } from '../service/provider-http-transport';
import { parseCompatibleChatSse, parseOpenAiResponsesSse } from './providers/ProviderRuntimeAdapter';

const DEFAULT_TIMEOUT_MS = 3_000;
const INFERENCE_TIMEOUT_MS = 60_000;

const PROTOCOL_PATH: Record<GatewayProtocol, string> = {
  chatCompletions: '/v1/chat/completions',
  responses: '/v1/responses',
  anthropic: '/v1/messages',
};

export interface CloudGatewayModelsClientOptions {
  cloudGatewayOrigin: string;
  /**
   * Upstream API base that already carries its version prefix (for example `http://ai-gateway/v1`).
   * When set, `/v1/...` paths are resolved beneath it instead of the origin root.
   */
  apiBaseUrl?: string;
  /** Overrides how the upstream is authenticated; defaults to forwarding the caller's Solid Bearer token. */
  authorize?: (auth: AuthContext) => string | undefined;
  /** Last-moment request body rewrite (model mapping, end-user attribution). */
  rewriteBody?: (body: unknown, auth: AuthContext) => unknown;
  /**
   * This client authenticates with a deployment-held secret instead of the caller's forwarded
   * identity. Such a client must never surface upstream text (it can echo the key) and must not
   * follow redirects with the Authorization header: `redirect: 'error'` keeps the secret on the
   * configured origin.
   */
  deploymentOwned?: boolean;
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
  private readonly apiBase?: string;
  private readonly authorize: (auth: AuthContext) => string | undefined;
  private readonly rewriteBody?: (body: unknown, auth: AuthContext) => unknown;
  private readonly deploymentOwned: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly inferenceTimeoutMs: number;

  public constructor(options: CloudGatewayModelsClientOptions) {
    this.origin = `${options.cloudGatewayOrigin.replace(/\/+$/u, '')}/`;
    this.apiBase = options.apiBaseUrl ? `${options.apiBaseUrl.replace(/\/+$/u, '')}/` : undefined;
    this.authorize = options.authorize ?? callerIdentityAuthorization;
    this.rewriteBody = options.rewriteBody;
    this.deploymentOwned = options.deploymentOwned === true;
    this.modelsUrl = this.upstreamUrl('/v1/models');
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.inferenceTimeoutMs = options.inferenceTimeoutMs ?? INFERENCE_TIMEOUT_MS;
  }

  private upstreamUrl(path: string): string {
    return this.apiBase
      ? new URL(path.replace(/^\/v1\//u, ''), this.apiBase).href
      : new URL(path, this.origin).href;
  }

  public async listModels(auth: AuthContext): Promise<GatewayModelProjection[]> {
    const authorization = this.authorize(auth);
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
        ...(this.deploymentOwned ? { redirect: 'error' as const } : {}),
      });
      if (!response.ok) {
        this.logger.warn(`Cloud /v1/models returned ${response.status}; keeping local models only`);
        await response.arrayBuffer().catch(() => undefined);
        return [];
      }
      return parseGatewayModelList(await response.json(), { fallbackOwner: 'cloud' });
    } catch (error) {
      this.logger.warn(`Cloud /v1/models unreachable; keeping local models only: ${safeFailureCode(error)}`);
      return [];
    }
  }

  public async completeJson(input: {
    auth: AuthContext;
    protocol: GatewayProtocol;
    body: unknown;
    signal?: AbortSignal;
    invocationMetadata?: GatewayInvocationMetadata;
  }): Promise<Record<string, unknown>> {
    const response = await this.inferenceResponse({
      ...input,
      stream: false,
      accept: 'application/json',
    });
    const payload = await readJsonObject(response, this.deploymentOwned);
    if (!response.ok) {
      throw cloudInferenceError(response.status, payload, this.deploymentOwned);
    }
    if (!payload) {
      // Only a deployment-owned upstream gets here: a 2xx body that is not a JSON object is a
      // protocol failure, never a successful empty answer. The raw text is never surfaced.
      throw new GatewayProtocolError('Deployment model inference failed', {
        code: 'provider_error',
        status: 502,
      });
    }
    return payload;
  }

  public async *executeStream(input: {
    auth: AuthContext;
    protocol: GatewayProtocol;
    body: unknown;
    signal?: AbortSignal;
    invocationMetadata?: GatewayInvocationMetadata;
  }): AsyncIterable<GatewayEvent> {
    const response = await this.inferenceResponse({
      ...input,
      stream: true,
      accept: 'text/event-stream',
    });
    if (!response.ok) {
      throw cloudInferenceError(
        response.status,
        await readJsonObject(response, this.deploymentOwned),
        this.deploymentOwned,
      );
    }
    if (this.deploymentOwned) {
      yield* this.deploymentStream(response, input.protocol, input.auth);
      return;
    }
    yield* parseCloudSse(response);
  }

  /**
   * Deployment-owned streams use the same protocol decoders as Provider runtimes, so a real
   * Responses transcript (`response.output_text.delta`, tools, usage, `response.completed`) is
   * understood instead of only Chat `choices`. Every reader/protocol failure is replaced with an
   * opaque Gateway error: a malformed frame or upstream error can quote the deployment key, and
   * neither its message, stack, cause nor details may leave this method.
   */
  private async *deploymentStream(
    response: Response,
    protocol: GatewayProtocol,
    auth: AuthContext,
  ): AsyncIterable<GatewayEvent> {
    if (!response.body) {
      throw new GatewayProtocolError('Deployment model stream failed', { code: 'provider_error', status: 502 });
    }
    const secret = this.authorize(auth)?.replace(/^Bearer\s+/iu, '');
    let decoder: AsyncIterable<GatewayEvent>;
    try {
      const events = parseSseStream(response.body);
      decoder = protocol === 'responses'
        ? parseOpenAiResponsesSse(events, secret)
        : protocol === 'chatCompletions'
          ? parseCompatibleChatSse(events, secret)
          : opaqueDeploymentStreamError(undefined);
    } catch (error) {
      throw opaqueDeploymentStreamError(error);
    }
    let started = false;
    let completed = false;
    try {
      for await (const event of decoder) {
        if (event.type === 'response.started') {
          started = true;
        } else if (!started) {
          // Compatible Chat streams may omit the assistant role that the shared decoder uses to
          // announce a response; keep the pre-existing envelope without inventing text.
          started = true;
          yield { type: 'response.started', id: 'deployment' };
        }
        if (event.type === 'response.completed') {
          completed = true;
        }
        yield event;
      }
    } catch (error) {
      throw opaqueDeploymentStreamError(error);
    }
    if (!completed) {
      throw new GatewayProtocolError('Deployment model stream ended before completion', {
        code: 'provider_error',
        status: 502,
      });
    }
  }

  private async inferenceResponse(input: {
    auth: AuthContext;
    protocol: GatewayProtocol;
    body: unknown;
    stream: boolean;
    accept: string;
    signal?: AbortSignal;
    invocationMetadata?: GatewayInvocationMetadata;
  }): Promise<Response> {
    const authorization = this.authorize(input.auth);
    if (!authorization) {
      throw new GatewayProtocolError('Cloud inference requires a forwardable Solid Bearer identity', {
        code: 'credential_unavailable',
        status: 403,
      });
    }
    const timeout = AbortSignal.timeout(this.inferenceTimeoutMs);
    const linked = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const url = this.upstreamUrl(PROTOCOL_PATH[input.protocol]);
    const rewritten = this.rewriteBody ? this.rewriteBody(input.body, input.auth) : input.body;
    const body = withStreamFlag(rewritten, input.stream);
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          ...gatewayInvocationHeaders(input.invocationMetadata),
          accept: input.accept,
          authorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: linked,
        ...(this.deploymentOwned ? { redirect: 'error' as const } : {}),
      });
    } catch (error) {
      this.logger.warn(`Cloud ${PROTOCOL_PATH[input.protocol]} unreachable: ${safeFailureCode(error)}`);
      throw new GatewayProtocolError('Cloud inference is unreachable', {
        code: 'provider_error',
        status: 502,
        // A raw fetch error can carry the request URL, headers or response text. A
        // deployment-owned client never retains it; the forwarded-identity contract keeps it.
        ...(this.deploymentOwned ? {} : { cause: error }),
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
  const seen = new Set(local.map((model) => model.id));
  const merged = [...local];
  for (const model of cloud) {
    const key = model.id;
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

function withStreamFlag(body: unknown, stream: boolean): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  return { ...(body as Record<string, unknown>), stream };
}

async function readJsonObject(
  response: Response,
  strict = false,
): Promise<Record<string, unknown> | undefined> {
  const payload = await response.json().catch(() => undefined);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return strict ? undefined : {};
  }
  return payload as Record<string, unknown>;
}

/**
 * Upstream failure as the gateway reports it.
 *
 * The forwarded-identity client keeps the upstream message (the Cloud gateway wrote it for this
 * caller). A deployment-owned client must not: an ai-gateway/LiteLLM error routinely quotes the
 * submitted key or request, and that text would reach logs and the browser. For that client only a
 * status-derived message and a whitelisted machine code survive.
 */
function cloudInferenceError(
  status: number,
  payload: Record<string, unknown> | undefined,
  deploymentOwned = false,
): GatewayProtocolError {
  const error = payload?.error;
  const record = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : undefined;
  if (deploymentOwned) {
    const code = record?.code === 'model_not_available' || record?.code === 'credential_unavailable' || record?.code === 'invalid_request'
      ? record.code
      : 'provider_error';
    const upstreamStatus = typeof record?.status === 'number'
      && Number.isInteger(record.status) && record.status >= 400 && record.status <= 599
      ? record.status
      : status;
    return new GatewayProtocolError('Deployment model inference failed', {
      code,
      status: upstreamStatus,
    });
  }
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

/**
 * Error diagnostics safe for a log line: a machine code, never the free-form message. Fetch
 * failures carry request URLs and sometimes request text in `message`, and the deployment-owned
 * upstream also sees the Authorization header.
 */
const SAFE_FETCH_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_ABORTED',
  'ERR_INVALID_URL',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Deployment-owned failure diagnostics: a known transport code, never arbitrary error text. */
function safeFailureCode(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') {
    return 'aborted';
  }
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && SAFE_FETCH_FAILURE_CODES.has(code)) {
    return code;
  }
  if (error instanceof Error && error.name === 'TypeError') {
    return 'network_error';
  }
  return 'request_failed';
}

function opaqueDeploymentStreamError(error: unknown): never {
  const status = error instanceof GatewayProtocolError && error.status >= 400 && error.status <= 599
    ? error.status
    : 502;
  throw new GatewayProtocolError('Deployment model stream failed', {
    code: 'provider_error',
    status,
  });
}
