import { readBoundedRequestBody } from './readBoundedRequestBody';
import { resolveMatrixContext } from '../matrix/MatrixPodResolver';
import { MatrixError } from '../matrix/MatrixError';
import { PACKAGE_ROOT } from '../../runtime/package-root';
import { getLoggerFor } from 'global-logger-factory';
import { randomBytes } from 'node:crypto';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { MatrixCreateRoomRequest, MatrixStore, MatrixStoreContext } from '../matrix/types';

const logger = getLoggerFor('MatrixHandler');

export interface MatrixHandlerOptions {
  store: MatrixStore;
  baseUrl?: string;
  /** Resolve and authorize the selected Pod from persisted ownership records. */
  resolvePodUrl?: (webId: string, requestedPodUrl?: string) => Promise<string>;
}

/**
 * Register the Matrix Client-Server compatibility adapter.
 *
 * Keep these externally visible routes Matrix-shaped:
 * - `/.well-known/matrix/client` is public discovery.
 * - `/_matrix/client/...` is Matrix's protocol namespace.
 *
 * Do not mount this adapter under `/api` or `/matrix`; first-party Xpod
 * clients should use Xpod-owned chat/message APIs, while Matrix clients need
 * the standard route shape to interoperate with existing SDKs.
 */
export function registerMatrixRoutes(server: ApiServer, options: MatrixHandlerOptions): void {
  const { store } = options;

  server.get('/.well-known/matrix/client', async (request, response) => {
    sendJson(response, 200, {
      'm.homeserver': {
        base_url: options.baseUrl?.replace(/\/$/, '') ?? requestBaseUrl(request),
      },
    });
  }, { public: true });

  server.get('/_matrix/client/versions', async (_request, response) => {
    sendJson(response, 200, {
      versions: ['v1.11'],
      unstable_features: {
        'co.undefineds.matrix.pod_storage': true,
        'co.undefineds.matrix.solid_auth_subset': true,
      },
    });
  }, { public: true });

  server.get('/_matrix/client/v3/login', async (_request, response) => {
    sendJson(response, 200, {
      flows: [],
    });
  }, { public: true });

  server.post('/_matrix/client/v3/login', async (_request, response) => {
    sendMatrixError(response, 501, 'M_UNRECOGNIZED', 'Matrix-native login is not implemented; use Solid/OIDC API authentication.');
  }, { public: true });

  server.get('/_matrix/client/v3/account/whoami', async (request, response) => {
    try {
      const context = await buildContext(request, options);
      const account = await store.getAccount(context);
      sendJson(response, 200, {
        user_id: account.userId,
        ...(account.deviceId ? { device_id: account.deviceId } : {}),
        is_guest: false,
        'co.undefineds.pod_url':context.podUrl,
        'co.undefineds.webid':context.webId,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  server.post('/_matrix/client/v3/createRoom', async (request, response) => {
    try {
      const body = await readJson<MatrixCreateRoomRequest>(request);
      validateCreateRoom(body ?? {});
      const room = await store.createRoom(body ?? {}, await buildContext(request, options));
      sendJson(response, 200, { room_id: room.roomId });
    } catch (error) {
      sendError(response, error);
    }
  });

  server.put('/_matrix/client/v3/rooms/:roomId/send/:eventType/:txnId', async (request, response, params) => {
    try {
      const content = await readJson<Record<string, unknown>>(request);
      const event = await store.sendEvent(
        decodeURIComponent(params.roomId),
        decodeURIComponent(params.eventType),
        decodeURIComponent(params.txnId),
        content ?? {},
        await buildContext(request, options),
      );
      sendJson(response, 200, { event_id: event.eventId });
    } catch (error) {
      sendError(response, error);
    }
  });

  server.get('/_matrix/client/v3/joined_rooms', async (request, response) => {
    try {
      const joinedRooms = await store.listJoinedRooms(await buildContext(request, options));
      sendJson(response, 200, { joined_rooms: joinedRooms });
    } catch (error) {
      sendError(response, error);
    }
  });

  server.post('/_matrix/client/v3/join/:roomIdOrAlias', async (request, response, params) => {
    try {
      const result = await store.joinRoom(decodeURIComponent(params.roomIdOrAlias), await buildContext(request, options));
      sendJson(response, 200, { room_id: result.roomId });
    } catch (error) {
      sendError(response, error);
    }
  });

  server.post('/_matrix/client/v3/rooms/:roomId/join', async (request, response, params) => {
    try {
      const result = await store.joinRoom(decodeURIComponent(params.roomId), await buildContext(request, options));
      sendJson(response, 200, { room_id: result.roomId });
    } catch (error) {
      sendError(response, error);
    }
  });

  server.post('/_matrix/client/v3/rooms/:roomId/invite', async (request, response, params) => {
    try {
      const body = await readJson<{ user_id?: unknown }>(request);
      if (!body || typeof body.user_id !== 'string' || body.user_id.length === 0) {
        throw new MatrixError(400, 'M_BAD_JSON', 'Invite requires user_id');
      }
      await store.inviteUser(decodeURIComponent(params.roomId), body.user_id, await buildContext(request, options));
      sendJson(response, 200, {});
    } catch (error) {
      sendError(response, error);
    }
  });

  server.post('/_matrix/client/v3/rooms/:roomId/leave', async (request, response, params) => {
    try {
      await store.leaveRoom(decodeURIComponent(params.roomId), await buildContext(request, options));
      sendJson(response, 200, {});
    } catch (error) {
      sendError(response, error);
    }
  });

  server.get('/_matrix/client/v3/sync', async (request, response) => {
    try {
      const url = new URL(request.url ?? '', 'http://localhost');
      const abort = new AbortController();
      const onDisconnect = (): void => abort.abort();
      request.once('aborted', onDisconnect);
      response.once?.('close', onDisconnect);
      let sync;
      try {
        sync = await store.sync(await buildContext(request, options), {
          since: url.searchParams.get('since') ?? undefined,
          limit: parseOptionalNumber(url.searchParams.get('limit'), 'limit', 1, 1000),
          timeout: parseOptionalNumber(url.searchParams.get('timeout'), 'timeout', 0, 30000),
          signal: abort.signal,
        });
      } finally {
        request.removeListener('aborted', onDisconnect);
        response.removeListener?.('close', onDisconnect);
      }
      if (!abort.signal.aborted) {
        sendJson(response, 200, sync);
      }
    } catch (error) {
      sendError(response, error);
    }
  });

  server.get('/_matrix/client/v3/rooms/:roomId/messages', async (request, response, params) => {
    try {
      const url = new URL(request.url ?? '', 'http://localhost');
      const messages = await store.listMessages(decodeURIComponent(params.roomId), await buildContext(request, options), {
        from: url.searchParams.get('from') ?? undefined,
        dir: parseDirection(url.searchParams.get('dir')),
        limit: parseOptionalNumber(url.searchParams.get('limit'), 'limit', 1, 1000),
      });
      sendJson(response, 200, messages);
    } catch (error) {
      sendError(response, error);
    }
  });

  server.get('/_matrix/client/v3/rooms/:roomId/members', async (request, response, params) => {
    try {
      const members = await store.getMembers(decodeURIComponent(params.roomId), await buildContext(request, options));
      sendJson(response, 200, { chunk: members });
    } catch (error) {
      sendError(response, error);
    }
  });

  server.get('/_matrix/client/v3/rooms/:roomId/event/:eventId', async (request, response, params) => {
    try {
      const event = await store.getEvent(
        decodeURIComponent(params.roomId),
        decodeURIComponent(params.eventId),
        await buildContext(request, options),
      );
      sendJson(response, 200, event);
    } catch (error) {
      sendError(response, error);
    }
  });

  server.get('/_matrix/client/v3/rooms/:roomId/state/:eventType', async (request, response, params) => {
    await sendState(request, response, params, '');
  });

  server.get('/_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey', async (request, response, params) => {
    await sendState(request, response, params, params.stateKey ?? '');
  });

  server.put('/_matrix/client/v3/rooms/:roomId/state/:eventType', async (request, response, params) => {
    await putState(request, response, params, '');
  });

  server.put('/_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey', async (request, response, params) => {
    await putState(request, response, params, params.stateKey ?? '');
  });

  async function sendState(
    request: AuthenticatedRequest,
    response: ServerResponse,
    params: Record<string, string>,
    stateKey: string,
  ): Promise<void> {
    try {
      const state = await store.getState(
        decodeURIComponent(params.roomId),
        decodeURIComponent(params.eventType),
        decodeURIComponent(stateKey),
        await buildContext(request, options),
      );
      sendJson(response, 200, state);
    } catch (error) {
      sendError(response, error);
    }
  }

  async function putState(
    request: AuthenticatedRequest,
    response: ServerResponse,
    params: Record<string, string>,
    stateKey: string,
  ): Promise<void> {
    try {
      const content = await readJson<Record<string, unknown>>(request);
      const event = await store.setState(
        decodeURIComponent(params.roomId),
        decodeURIComponent(params.eventType),
        decodeURIComponent(stateKey),
        content ?? {},
        await buildContext(request, options),
      );
      sendJson(response, 200, { event_id: event.eventId });
    } catch (error) {
      sendError(response, error);
    }
  }
}

/**
 * A phase slower than this is reported with its monotonic duration. Kept in
 * line with the store's threshold so a slow handler boundary is visible.
 */
const SLOW_HANDLER_PHASE_MS = 3_000;

/**
 * Call-local handler phase correlation.
 *
 * Created per `buildContext`/`readJson` invocation and passed explicitly to
 * each awaited boundary, so nothing is stored on a shared instance and
 * concurrent requests cannot overwrite each other's phase.
 */
interface HandlerPhaseTrace {
  readonly operation: string;
  readonly id: string;
}

function createHandlerPhaseTrace(operation: string): HandlerPhaseTrace {
  return { operation, id: randomBytes(4).toString('hex') };
}

function logHandlerPhase(trace: HandlerPhaseTrace, phase: string, startedAt: number,
  detail: Record<string, unknown> = {}, force = false): void {
  const elapsedMs = Math.round(performance.now() - startedAt);
  if (!force && elapsedMs < SLOW_HANDLER_PHASE_MS) return;
  logger.warn(`[matrix-phase] ${JSON.stringify({ op: trace.operation, opId: trace.id, phase, elapsedMs, ...detail })}`);
}

/**
 * Run one awaited handler boundary, keeping the original exception and HTTP
 * status behavior exactly. A failed boundary is always logged with its fixed
 * phase, monotonic elapsed time and only allowlisted, safe numeric counts.
 */
async function runHandlerPhase<T>(trace: HandlerPhaseTrace, phase: string, detail: Record<string, unknown>,
  run: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    const value = await run();
    logHandlerPhase(trace, phase, startedAt, detail);
    return value;
  } catch (error) {
    logHandlerPhase(trace, `${phase}.failed`, startedAt, { ...handlerErrorDetail(error), ...detail }, true);
    throw error;
  }
}

async function buildContext(request: AuthenticatedRequest, options: MatrixHandlerOptions): Promise<MatrixStoreContext> {
  const trace = createHandlerPhaseTrace('buildContext');
  return runHandlerPhase(trace, 'handler.buildContext', {}, async () => {
    const resolvePodUrl = options.resolvePodUrl;
    if (!resolvePodUrl) {
      throw new MatrixError(503, 'M_UNAVAILABLE', 'Matrix Pod lookup is unavailable');
    }
    return runHandlerPhase(trace, 'handler.resolveMatrixContext', {}, () => resolveMatrixContext(request, resolvePodUrl));
  });
}

const MAX_BODY_BYTES = 1024 * 1024;

async function readJson<T>(request: AuthenticatedRequest): Promise<T | undefined> {
  const trace = createHandlerPhaseTrace('readJson');
  return runHandlerPhase(trace, 'handler.readJson', {}, async () => {
    const chunks = await runHandlerPhase(trace, 'handler.readBoundedBody', { limitBytes: MAX_BODY_BYTES }, () =>
      readBoundedRequestBody(request, MAX_BODY_BYTES, 'Request body exceeds 1 MiB'));
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!isObject(value)) throw new MatrixError(400, 'M_BAD_JSON', 'Request body must be an object');
    return value as T;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCreateRoom(input: MatrixCreateRoomRequest): void {
  const invalid = (): never => { throw new MatrixError(400, 'M_BAD_JSON', 'Invalid createRoom fields'); };
  for (const value of [input.name, input.topic, input.room_alias_name, input.preset]) {
    if (value !== undefined && typeof value !== 'string') invalid();
  }
  if (input.visibility !== undefined && !['private', 'public'].includes(input.visibility)) invalid();
  if (input.invite !== undefined && (!Array.isArray(input.invite) || input.invite.some(id => typeof id !== 'string' || !id))) invalid();
  if (input.creation_content !== undefined && !isObject(input.creation_content)) invalid();
  if (input.initial_state !== undefined && (!Array.isArray(input.initial_state) || input.initial_state.some(state =>
    !isObject(state) || typeof state.type !== 'string' || !state.type ||
    (state.state_key !== undefined && typeof state.state_key !== 'string') ||
    (state.content !== undefined && !isObject(state.content))))) invalid();
}

function parseOptionalNumber(value: string | null, name: string, min: number, max: number): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new MatrixError(400, 'M_INVALID_PARAM', `${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseDirection(value: string | null): 'b' | 'f' {
  if (value === null || value === 'b') return 'b';
  if (value === 'f') return 'f';
  throw new MatrixError(400, 'M_INVALID_PARAM', 'dir must be b or f');
}

function requestBaseUrl(request: AuthenticatedRequest): string {
  // Forwarded headers are not authoritative without a configured trusted proxy.
  return `http://${request.headers.host ?? 'localhost'}`;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}

function sendMatrixError(response: ServerResponse, status: number, errcode: string, error: string): void {
  sendJson(response, status, { errcode, error });
}

// Strict allowlist: only short opaque code/name tokens may ever leave the
// unknown-error path. Never log messages, stacks, URLs, bodies, tokens, or DSNs.
const SAFE_ERROR_TOKEN = /^[A-Za-z0-9_]{1,64}$/;
// `DOMException.code` is a prototype getter returning a number; a string-only
// filter drops a native timeout entirely. Numeric `23` (TimeoutError) is the
// only numeric code allowed to leave.
const DOM_TIMEOUT_CODE = 23;

function safeErrorToken(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ERROR_TOKEN.test(value) ? value : undefined;
}

function unknownErrorName(error: unknown): string {
  if (error instanceof Error && SAFE_ERROR_TOKEN.test(error.name)) {
    return error.name;
  }
  return typeof error;
}

/**
 * Fixed, allowlisted projection of an unknown error.
 *
 * A native `TimeoutError` is a `DOMException` whose `code` is the numeric
 * prototype getter `23`; the old string-only filter omitted it and made it look
 * code-less. Only the boolean timeout flag, `typeof code`, the single allowed
 * numeric code `23`, a signal's presence/aborted state, an allowlisted
 * `reason.name` and the error name ever leave. Message, stack, URL, query,
 * body, token, DSN and raw arguments are never read.
 */
function handlerErrorDetail(error: unknown): Record<string, unknown> {
  const detail: Record<string, unknown> = { errorName: unknownErrorName(error) };
  const name = (error as { name?: unknown } | null | undefined)?.name;
  if (name === 'TimeoutError') detail.domTimeout = true;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string') {
    const token = safeErrorToken(code);
    if (token) detail.code = token;
  } else if (code !== undefined) {
    detail.codeType = typeof code;
    if (typeof code === 'number' && code === DOM_TIMEOUT_CODE) detail.code = DOM_TIMEOUT_CODE;
  }
  const causeCode = safeErrorToken((error as { cause?: { code?: unknown } } | null | undefined)?.cause?.code);
  if (causeCode) detail.causeCode = causeCode;
  const signal = (error as { signal?: { aborted?: unknown } } | null | undefined)?.signal;
  if (signal !== null && typeof signal === 'object') {
    detail.signalPresent = true;
    detail.signalAborted = (signal as { aborted?: unknown }).aborted === true;
  }
  const reason = (error as { reason?: unknown } | null | undefined)?.reason;
  if (reason instanceof Error && SAFE_ERROR_TOKEN.test(reason.name)) detail.reasonName = reason.name;
  return detail;
}

// The repository root is derived from this module's own location, never from
// the untrusted error, so a stack cannot widen its own trusted boundary.
const PROJECT_ROOT = resolve(PACKAGE_ROOT);
const PROJECT_PREFIX = PROJECT_ROOT + sep;
const MAX_SAFE_FRAMES = 4;
const FRAME_LOCATION = /^(.*):(\d+):(\d+)$/;
const REMOTE_LOCATION = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
// A frame location is only a code path. Query strings, fragments and control
// characters can smuggle credentials or filesystem noise into the log, so they
// are rejected outright, before parsing and again after any URL decoding.
const UNSAFE_LOCATION = /[?#\u0000-\u001f\u007f]/;
// Only first-party code directories may appear in a frame, and only files that
// actually hold code. Dependency trees (node_modules) are never trusted.
const TRUSTED_CODE_DIRECTORIES = new Set([ 'src', 'dist', 'scripts', 'tests' ]);
const CODE_FILE_EXTENSIONS = new Set([ '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs' ]);

function unsafeLocation(location: string): boolean {
  return UNSAFE_LOCATION.test(location);
}

function trustedProjectLocation(relativePath: string): boolean {
  const segments = relativePath.split('/');
  if (segments.includes('node_modules')) return false;
  if (!TRUSTED_CODE_DIRECTORIES.has(segments[0])) return false;
  return CODE_FILE_EXTENSIONS.has(extname(relativePath).toLowerCase());
}

/**
 * Project-local frame location from one stack line, or `undefined`.
 *
 * Only a genuine `at` frame whose absolute file is verified to live under this
 * repository root and inside a trusted code directory survives, reduced to a
 * `path:line:col` location. A remote URL (including its credentials), a bare
 * message line, a function name, and any query string, fragment or control
 * character are all rejected, before parsing and again after file-URL decoding.
 * Compiled `dist` and source `src` frames are both kept; a frame points at
 * code, it is never a proven cause.
 */
function frameLocation(rawLine: string): string | undefined {
  const line = rawLine.trim();
  if (!line.startsWith('at ')) return undefined;
  const open = line.lastIndexOf('(');
  let location = open !== -1 && line.endsWith(')')
    ? line.slice(open + 1, -1).trim()
    : line.slice(3).trim();
  if (!location || unsafeLocation(location)) return undefined;
  if (location.startsWith('file://')) {
    try {
      location = fileURLToPath(location);
    } catch {
      return undefined;
    }
    // Percent-encoded query/fragment/control characters become raw after decode.
    if (unsafeLocation(location)) return undefined;
  } else if (REMOTE_LOCATION.test(location)) {
    return undefined;
  }
  const match = FRAME_LOCATION.exec(location);
  if (!match || !isAbsolute(match[1])) return undefined;
  const absolute = resolve(match[1]);
  if (absolute !== PROJECT_ROOT && !absolute.startsWith(PROJECT_PREFIX)) return undefined;
  const relativePath = relative(PROJECT_ROOT, absolute).split(sep).join('/');
  if (!trustedProjectLocation(relativePath)) return undefined;
  return `${relativePath}:${match[2]}:${match[3]}`;
}

function safeLocalErrorFrames(error: unknown): string[] {
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
  if (!stack) return [];
  const frames: string[] = [];
  for (const rawLine of stack.split('\n')) {
    const frame = frameLocation(rawLine);
    if (!frame || frames.includes(frame)) continue;
    frames.push(frame);
    if (frames.length >= MAX_SAFE_FRAMES) break;
  }
  return frames;
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof MatrixError) {
    sendMatrixError(response, error.status, error.errcode, error.message);
  } else if (error instanceof SyntaxError || error instanceof URIError) {
    sendMatrixError(response, 400, 'M_BAD_JSON', 'Malformed JSON or URL encoding');
  } else {
    const detail = handlerErrorDetail(error);
    const frames = safeLocalErrorFrames(error);
    if (frames.length > 0) detail.frames = frames.join(',');
    logger.error(`Matrix handler failed with an unknown error ${JSON.stringify(detail)}`);
    sendMatrixError(response, 500, 'M_UNKNOWN', 'Internal server error');
  }
}
