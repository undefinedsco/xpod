import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import { readBoundedJsonBody } from '../http/readBoundedJsonBody';
import { GatewayProtocolError, normalizeGatewayError } from '../ai-gateway/errors';
import type { AiGatewayService } from '../ai-gateway/AiGatewayService';
import type { GatewayEvent, GatewayProtocol, GatewayProtocolFrontend, GatewayUsage } from '../ai-gateway/types';

export interface AiGatewayHandlerOptions {
  service: AiGatewayService;
  jsonBodyLimitBytes?: number;
  acceptanceEndpointsEnabled?: boolean;
}

const DEFAULT_JSON_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * What a finished inference is allowed to leave in the logs: routing and cost
 * metadata only. Prompt, completion and credential material must never be
 * logged, so this summary deliberately carries no message content.
 */
interface InferenceLogSummary {
  protocol: GatewayProtocol;
  model?: string;
  stream: boolean;
  startedAt: number;
  outcome: 'completed' | 'failed' | 'disconnected';
  events?: number;
  finishReason?: string;
  usage?: GatewayUsage;
}

interface InferenceStreamOutcome {
  events: number;
  outcome: InferenceLogSummary['outcome'];
  finishReason?: string;
  usage?: GatewayUsage;
}

export function registerAiGatewayRoutes(
  server: ApiServer,
  options: AiGatewayHandlerOptions,
): void {
  const handler = new AiGatewayHandler(options);
  server.post('/v1/responses', (request, response) => handler.handleInference(request, response, 'responses'));
  server.post('/v1/messages', (request, response) => handler.handleInference(request, response, 'anthropic'));
  server.post('/v1/chat/completions', (request, response) => handler.handleInference(request, response, 'chatCompletions'));
  server.get('/v1/models', (request, response) => handler.handleModels(request, response));
  if (options.acceptanceEndpointsEnabled === true) {
    server.get('/v1/xpod/acceptance/provenance', (request, response) => handler.handleAcceptanceProvenance(request, response));
  }
}

export class AiGatewayHandler {
  private readonly logger = getLoggerFor(this);
  private readonly service: AiGatewayService;
  private readonly jsonBodyLimitBytes: number;

  public constructor(options: AiGatewayHandlerOptions) {
    this.service = options.service;
    this.jsonBodyLimitBytes = options.jsonBodyLimitBytes ?? DEFAULT_JSON_BODY_LIMIT_BYTES;
  }

  public async handleInference(
    request: AuthenticatedRequest,
    response: ServerResponse,
    protocol: GatewayProtocol,
  ): Promise<void> {
    const startedAt = Date.now();
    const bodyResult = await readBoundedJsonBody(request, { limitBytes: this.jsonBodyLimitBytes });
    if (!bodyResult.ok) {
      this.sendGatewayError(response, new GatewayProtocolError(bodyResult.error, {
        code: 'invalid_request',
        status: bodyResult.status,
      }));
      return;
    }

    const model = readRequestedModel(bodyResult.value);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    response.once('close', abort);

    try {
      const stream = isStreamRequest(bodyResult.value);
      if (!stream) {
        const result = await this.service.complete({
          auth: request.auth!,
          protocol,
          body: bodyResult.value,
          signal: controller.signal,
        });
        sendJson(response, 200, result);
        this.logInference({
          protocol,
          model: readResultModel(result) ?? model,
          stream: false,
          startedAt,
          outcome: 'completed',
          finishReason: readResultFinishReason(result),
          usage: readResultUsage(result),
        });
        return;
      }

      const execution = await this.service.execute({
        auth: request.auth!,
        protocol,
        body: bodyResult.value,
        signal: controller.signal,
      });
      const outcome = await this.sendEventStream(response, execution.frontend, execution.events);
      this.logInference({ protocol, model, stream: true, startedAt, ...outcome });
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) {
        return;
      }
      if (response.headersSent) {
        await this.writeTerminalStreamError(response, error);
        return;
      }
      this.sendGatewayError(response, error);
    } finally {
      response.off('close', abort);
    }
  }

  public async handleModels(
    request: AuthenticatedRequest,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const models = await this.service.listModels(request.auth!);
      sendJson(response, 200, {
        object: 'list',
        data: models,
      });
    } catch (error) {
      this.sendGatewayError(response, error);
    }
  }

  public async handleAcceptanceProvenance(
    request: AuthenticatedRequest,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (request.auth?.type !== 'solid') {
        throw new GatewayProtocolError('Acceptance provenance requires a Solid user principal', {
          code: 'invalid_request',
          status: 403,
        });
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const model = url.searchParams.get('model')?.trim();
      if (!model) {
        throw new GatewayProtocolError('model is required', {
          code: 'invalid_request',
          status: 400,
        });
      }
      sendJson(response, 200, await this.service.acceptanceProvenance({
        auth: request.auth,
        model,
        xpodBaseUrl: `${headerString(request.headers['x-forwarded-proto']) || url.protocol.replace(':', '')}://${url.host}`,
      }));
    } catch (error) {
      this.sendGatewayError(response, error);
    }
  }

  private async sendEventStream(
    response: ServerResponse,
    frontend: GatewayProtocolFrontend,
    events: AsyncIterable<GatewayEvent>,
  ): Promise<InferenceStreamOutcome> {
    const iterator = events[Symbol.asyncIterator]();
    const outcome: InferenceStreamOutcome = { events: 0, outcome: 'completed' };
    let disconnected = false;
    let iteratorReturned = false;
    const returnIterator = async(): Promise<void> => {
      if (!iteratorReturned) {
        iteratorReturned = true;
        await iterator.return?.();
      }
    };
    const onClose = (): void => {
      disconnected = true;
      void returnIterator();
    };
    response.once('close', onClose);
    let first: IteratorResult<GatewayEvent>;
    try {
      first = await iterator.next();
    } catch (error) {
      await returnIterator();
      response.off('close', onClose);
      throw error;
    }
    if (first.done) {
      await returnIterator();
      response.off('close', onClose);
      throw new GatewayProtocolError('Provider stream ended before emitting any gateway event', {
        code: 'provider_error',
        status: 502,
      });
    }

    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    const serializer = frontend.createEventSerializer();
    try {
      trackGatewayEvent(outcome, first.value);
      await writeSerializedEvents(response, serializer.serializeEvent(first.value));
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          break;
        }
        trackGatewayEvent(outcome, next.value);
        await writeSerializedEvents(response, serializer.serializeEvent(next.value));
      }
      await writeWithBackpressure(response, 'data: [DONE]\n\n');
    } catch (error) {
      outcome.outcome = disconnected ? 'disconnected' : 'failed';
      await returnIterator();
      if (!disconnected) {
        await this.writeTerminalStreamError(response, error);
      }
    } finally {
      response.off('close', onClose);
      if (!disconnected && !response.writableEnded) {
        response.end();
      }
    }
    if (disconnected) {
      outcome.outcome = 'disconnected';
    }
    return outcome;
  }

  private logInference(summary: InferenceLogSummary): void {
    const fields = [
      `protocol=${summary.protocol}`,
      `model=${summary.model ?? 'unresolved'}`,
      `stream=${summary.stream}`,
      `outcome=${summary.outcome}`,
      `durationMs=${Date.now() - summary.startedAt}`,
    ];
    if (summary.events !== undefined) {
      fields.push(`events=${summary.events}`);
    }
    if (summary.finishReason) {
      fields.push(`finishReason=${summary.finishReason}`);
    }
    const usage = formatUsage(summary.usage);
    if (usage) {
      fields.push(`usage=${usage}`);
    }
    this.logger.info(`AI Gateway inference ${fields.join(' ')}`);
  }

  private async writeTerminalStreamError(response: ServerResponse, error: unknown): Promise<void> {
    const payload = normalizeGatewayError(error);
    await writeWithBackpressure(response, `data: ${JSON.stringify({ error: payload.error })}\n\n`);
    await writeWithBackpressure(response, 'data: [DONE]\n\n');
    if (!response.writableEnded) {
      response.end();
    }
  }

  private sendGatewayError(response: ServerResponse, error: unknown): void {
    const payload = normalizeGatewayError(error);
    this.logger.warn(`AI Gateway request failed: ${payload.error.code}: ${payload.error.message}`);
    sendJson(response, payload.error.status, {
      error: {
        code: payload.error.code,
        message: payload.error.message,
        ...(payload.error.details ? { details: payload.error.details } : {}),
      },
    });
  }
}

async function writeSerializedEvents(
  response: ServerResponse,
  serialized: Record<string, unknown> | Record<string, unknown>[],
): Promise<void> {
  for (const event of Array.isArray(serialized) ? serialized : [serialized]) {
    await writeWithBackpressure(response, `data: ${JSON.stringify(event)}\n\n`);
  }
}

async function writeWithBackpressure(response: ServerResponse, chunk: string): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    throw new Error('Response stream closed');
  }
  if (response.write(chunk)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('Response stream closed'));
    };
    const cleanup = (): void => {
      response.off('drain', onDrain);
      response.off('close', onClose);
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
  });
}

function isStreamRequest(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && !Array.isArray(body) && (body as { stream?: unknown }).stream === true);
}

function trackGatewayEvent(outcome: InferenceStreamOutcome, event: GatewayEvent): void {
  outcome.events += 1;
  if (event.type === 'usage') {
    outcome.usage = event.usage;
  } else if (event.type === 'response.completed') {
    outcome.finishReason = event.finishReason;
  }
}

function readRequestedModel(body: unknown): string | undefined {
  return readNonEmptyString(asRecord(body)?.model);
}

function readResultModel(result: unknown): string | undefined {
  return readNonEmptyString(asRecord(result)?.model);
}

function readResultFinishReason(result: unknown): string | undefined {
  const choices = asRecord(result)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  return readNonEmptyString(asRecord(choices[0])?.finish_reason);
}

/** Accepts both the gateway's camelCase usage and the OpenAI snake_case shape. */
function readResultUsage(result: unknown): GatewayUsage | undefined {
  const usage = asRecord(asRecord(result)?.usage);
  if (!usage) {
    return undefined;
  }
  const pick = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const raw = usage[key];
      if (typeof raw === 'number') {
        return raw;
      }
    }
    return undefined;
  };
  const parsed: GatewayUsage = {
    inputTokens: pick('inputTokens', 'prompt_tokens'),
    outputTokens: pick('outputTokens', 'completion_tokens'),
    totalTokens: pick('totalTokens', 'total_tokens'),
    cacheReadTokens: pick('cacheReadTokens', 'cache_read_tokens'),
    cacheWriteTokens: pick('cacheWriteTokens', 'cache_write_tokens'),
  };
  return Object.values(parsed).some((value) => value !== undefined) ? parsed : undefined;
}

function formatUsage(usage: GatewayUsage | undefined): string | undefined {
  if (!usage) {
    return undefined;
  }
  const parts: string[] = [];
  for (const [label, value] of [
    ['input', usage.inputTokens],
    ['output', usage.outputTokens],
    ['total', usage.totalTokens],
    ['cacheRead', usage.cacheReadTokens],
    ['cacheWrite', usage.cacheWriteTokens],
  ] as const) {
    if (typeof value === 'number') {
      parts.push(`${label}:${value}`);
    }
  }
  return parts.length > 0 ? parts.join(',') : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function headerString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}
