import { createHash } from 'node:crypto';

export const TASK_MODEL_DIAGNOSTIC_STAGES = [
  'not_invoked', 'model_invoked', 'payload_prepared', 'stream_open',
] as const;
export const TASK_MODEL_DIAGNOSTIC_APIS = ['openai-completions', 'openai-responses', 'other'] as const;
export const TASK_MODEL_DIAGNOSTIC_STOP_REASONS = ['error', 'aborted', 'unknown'] as const;
export const TASK_GATEWAY_DIAGNOSTIC_ROUTES = ['chat_completions', 'responses', 'anthropic_messages'] as const;
export const TASK_GATEWAY_DIAGNOSTIC_CODES = [
  'invalid_request', 'invalid_tool_arguments', 'unsupported_protocol_event', 'service_access_missing',
  'credential_unavailable', 'model_not_available', 'no_model_available', 'embedding_model_not_allowed',
  'provider_error', 'internal_error',
] as const;
export const TASK_MODEL_SDK_ERROR_KINDS = [
  'http_status', 'connection', 'timeout', 'aborted', 'length_limit', 'content_filter', 'unknown',
] as const;
export type TaskModelSdkErrorKind = typeof TASK_MODEL_SDK_ERROR_KINDS[number];

/**
 * Bounded classification of the SDK-formatted provider error message. The SDK
 * discards the structured HTTP response, so this is explicitly a hint and never
 * a measured HTTP status; the raw message (which may embed a response body) is
 * never retained.
 */
export interface TaskModelSdkErrorHint {
  kind: TaskModelSdkErrorKind;
  /** Present only for kind 'http_status'; parsed from the SDK's fixed "<status> <message>" prefix. */
  status?: number;
}

export interface TaskModelDiagnosticReceipt {
  event: 'xpod.task-model-diagnostic';
  schemaVersion: 1;
  /** The existing invocation header identifies a session, not a unique Run. */
  scope: 'session';
  correlationHash: string;
  stage: typeof TASK_MODEL_DIAGNOSTIC_STAGES[number];
  api: typeof TASK_MODEL_DIAGNOSTIC_APIS[number];
  stopReason: typeof TASK_MODEL_DIAGNOSTIC_STOP_REASONS[number];
  retryCount: number;
  credentialPresent: boolean;
  /** The SDK discards the structured HTTP status before emitting an error. */
  httpStatus: null;
  /** Bounded hint derived from the SDK error message; never the raw text. */
  sdkErrorHint?: TaskModelSdkErrorHint;
}

export interface TaskGatewayDiagnosticReceipt {
  event: 'xpod.task-gateway-diagnostic';
  schemaVersion: 1;
  scope: 'session';
  correlationHash: string;
  route: typeof TASK_GATEWAY_DIAGNOSTIC_ROUTES[number];
  callerHTTPstatus: number;
  code: typeof TASK_GATEWAY_DIAGNOSTIC_CODES[number];
  underlyingErrorStatus?: number;
  streamOpen: boolean;
  durationMs: number;
}

export interface TaskGatewayHttpDiagnosticReceipt {
  event: 'xpod.task-gateway-http-diagnostic';
  schemaVersion: 1;
  scope: 'session';
  correlationHash: string;
  route: typeof TASK_GATEWAY_DIAGNOSTIC_ROUTES[number];
  callerHTTPstatus: number;
  statusSource: 'response_finished' | 'response_closed';
  durationMs: number;
}

export type TaskModelFailureDiagnostic = TaskModelDiagnosticReceipt | TaskGatewayDiagnosticReceipt | TaskGatewayHttpDiagnosticReceipt;

/** Hash the exact header bytes; malformed headers never enter a diagnostic receipt. */
export function hashTaskModelDiagnosticSession(sessionHeader: unknown): string | undefined {
  if (typeof sessionHeader !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u.test(sessionHeader)) return undefined;
  return createHash('sha256').update(sessionHeader).digest('hex');
}

function member<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.some(entry => entry === value);
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

const SDK_ERROR_MESSAGE_LIMIT = 8192;
// openai/core/error.mjs APIError.makeMessage prefixes "<status> " to the body message.
const SDK_HTTP_STATUS_PREFIX = /^([45]\d{2}) \S/u;
const SDK_EXACT_ERROR_KINDS = new Map<string, TaskModelSdkErrorKind>([
  ['Connection error.', 'connection'],
  ['Request timed out.', 'timeout'],
  ['Request was aborted.', 'aborted'],
  ['Could not parse response content as the length limit was reached', 'length_limit'],
  ['Could not parse response content as the request was rejected by the content filter', 'content_filter'],
]);

/**
 * Classify the installed SDK's provider error message into a fixed enum.
 * Only the SDK's own leading status prefix and exact error constants are
 * recognized; embedded response text is never inspected or retained.
 */
export function classifyTaskModelSdkErrorHint(message: unknown): TaskModelSdkErrorHint | undefined {
  if (typeof message !== 'string' || message.length === 0) return undefined;
  const head = message.slice(0, SDK_ERROR_MESSAGE_LIMIT);
  const status = SDK_HTTP_STATUS_PREFIX.exec(head);
  if (status) {
    const code = Number(status[1]);
    if (code >= 400 && code <= 599) return { kind: 'http_status', status: code };
  }
  return { kind: SDK_EXACT_ERROR_KINDS.get(head) ?? 'unknown' };
}

function selectTaskModelSdkErrorHint(value: unknown): TaskModelSdkErrorHint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (!member(row.kind, TASK_MODEL_SDK_ERROR_KINDS)) return undefined;
  if (row.kind === 'http_status') {
    return boundedInteger(row.status, 400, 599) ? { kind: 'http_status', status: row.status } : undefined;
  }
  return row.status === undefined ? { kind: row.kind } : undefined;
}

/** The sole field allowlist used by producers and the candidate artifact projector. */
export function selectTaskModelDiagnosticReceipt(value: unknown): TaskModelFailureDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || row.scope !== 'session'
    || typeof row.correlationHash !== 'string' || !/^[a-f0-9]{64}$/u.test(row.correlationHash)) return undefined;
  const common = { schemaVersion: 1 as const, scope: 'session' as const, correlationHash: row.correlationHash };
  if (row.event === 'xpod.task-gateway-http-diagnostic') {
    if (!member(row.route, TASK_GATEWAY_DIAGNOSTIC_ROUTES) || !boundedInteger(row.callerHTTPstatus, 400, 599)
      || (row.statusSource !== 'response_finished' && row.statusSource !== 'response_closed')
      || !boundedInteger(row.durationMs, 0, 2147483647)) return undefined;
    return { event: row.event, ...common, route: row.route, callerHTTPstatus: row.callerHTTPstatus,
      statusSource: row.statusSource, durationMs: row.durationMs };
  }
  if (row.event === 'xpod.task-model-diagnostic') {
    if (!member(row.stage, TASK_MODEL_DIAGNOSTIC_STAGES) || !member(row.api, TASK_MODEL_DIAGNOSTIC_APIS)
      || !member(row.stopReason, TASK_MODEL_DIAGNOSTIC_STOP_REASONS)
      || !boundedInteger(row.retryCount, 0, Number.MAX_SAFE_INTEGER)
      || typeof row.credentialPresent !== 'boolean' || row.httpStatus !== null) return undefined;
    const receipt: TaskModelDiagnosticReceipt = { event: row.event, ...common, stage: row.stage, api: row.api,
      stopReason: row.stopReason, retryCount: row.retryCount, credentialPresent: row.credentialPresent, httpStatus: null };
    if (row.sdkErrorHint !== undefined) {
      const sdkErrorHint = selectTaskModelSdkErrorHint(row.sdkErrorHint);
      if (!sdkErrorHint) return undefined;
      receipt.sdkErrorHint = sdkErrorHint;
    }
    return receipt;
  }
  if (row.event === 'xpod.task-gateway-diagnostic') {
    if (!member(row.route, TASK_GATEWAY_DIAGNOSTIC_ROUTES) || !member(row.code, TASK_GATEWAY_DIAGNOSTIC_CODES)
      || !boundedInteger(row.callerHTTPstatus, 100, 599) || typeof row.streamOpen !== 'boolean'
      || !boundedInteger(row.durationMs, 0, 2147483647)
      || (row.underlyingErrorStatus !== undefined && !boundedInteger(row.underlyingErrorStatus, 100, 599))) return undefined;
    return { event: row.event, ...common, route: row.route, callerHTTPstatus: row.callerHTTPstatus,
      code: row.code, ...(row.underlyingErrorStatus === undefined ? {} : { underlyingErrorStatus: row.underlyingErrorStatus }),
      streamOpen: row.streamOpen, durationMs: row.durationMs };
  }
  return undefined;
}
