import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type {
  RdfNativeSparqlQueryOptions,
  RdfNativeSparqlResult,
  RdfNativeSparqlVectorQueryOptions,
} from './types';

export type LocalQleverRuntimeErrorCode =
  | 'qlever_runtime_unavailable'
  | 'qlever_runtime_protocol_error'
  | 'qlever_runtime_closed'
  | 'qlever_request_timeout'
  | 'qlever_request_aborted'
  | 'qlever_remote_error';

export class LocalQleverRuntimeError extends Error {
  public readonly code: LocalQleverRuntimeErrorCode | string;
  public override readonly cause?: unknown;

  public constructor(code: LocalQleverRuntimeErrorCode | string, message: string, cause?: unknown) {
    super(message);
    this.name = 'LocalQleverRuntimeError';
    this.code = code;
    this.cause = cause;
  }
}

export interface LocalQleverNativeSparqlClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  expectedNativeSparqlAbiVersion?: number;
  expectedPhysicalBackendAbiVersion?: number;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxStderrBytes?: number;
}

interface LocalQleverReadyMessage {
  type: 'ready';
  abiVersion: number;
  physicalBackendAbiVersion: number;
  backend: 'sqlite';
}

interface LocalQleverResultMessage {
  id: string;
  type: 'result';
  result: RdfNativeSparqlResult;
}

interface LocalQleverErrorMessage {
  id: string;
  type: 'error';
  code?: string;
  message?: string;
}

interface PendingRequest {
  resolve(result: RdfNativeSparqlResult): void;
  reject(error: unknown): void;
  timeout?: NodeJS.Timeout;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface StartupAttempt {
  child: ChildProcessWithoutNullStreams;
  resolve(): void;
  reject(error: unknown): void;
  timeout: NodeJS.Timeout;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const FORCED_SHUTDOWN_TIMEOUT_MS = 5_000;
const NATIVE_SPARQL_ABI_VERSION = 1;
const PHYSICAL_BACKEND_ABI_VERSION = 7;
const DEFAULT_LOCAL_QLEVER_RUNTIME_COMMAND = '/opt/xpod/qlever/bin/xpod_qlever_local_runtime';

export function resolveLocalQleverRuntimeCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.XPOD_QLEVER_LOCAL_RUNTIME_COMMAND?.trim();
  return configured || DEFAULT_LOCAL_QLEVER_RUNTIME_COMMAND;
}

export function requiresWindowsCommandShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command);
}

/**
 * Persistent JSONL transport for the packaged Local QLever runtime.
 *
 * The runtime owns QLever and the SQLite physical provider. This client owns
 * only process lifecycle, request correlation, cancellation, and native result
 * envelope validation. It never parses or evaluates SPARQL.
 */
export class LocalQleverNativeSparqlClient {
  private readonly options: Required<Pick<LocalQleverNativeSparqlClientOptions, 'command'>> &
    Omit<LocalQleverNativeSparqlClientOptions, 'command'>;
  private child?: ChildProcessWithoutNullStreams;
  private reader?: ReadlineInterface;
  private startup?: StartupAttempt;
  private startPromise?: Promise<void>;
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequestId = 1;
  private stderrTail = '';
  private ready = false;
  private closed = false;
  private failedProcessCleanup?: Promise<void>;

  public constructor(options: LocalQleverNativeSparqlClientOptions = {}) {
    this.options = {
      ...options,
      command: options.command?.trim() || resolveLocalQleverRuntimeCommand({
        ...process.env,
        ...options.env,
      }),
    };
    if (!isPositiveInteger(options.expectedNativeSparqlAbiVersion ?? NATIVE_SPARQL_ABI_VERSION)) {
      throw new TypeError('Local QLever native SPARQL ABI version must be a positive integer');
    }
    if (!isPositiveInteger(options.expectedPhysicalBackendAbiVersion ?? PHYSICAL_BACKEND_ABI_VERSION)) {
      throw new TypeError('Local QLever physical backend ABI version must be a positive integer');
    }
  }

  public start(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new LocalQleverRuntimeError(
        'qlever_runtime_closed',
        'Local QLever runtime client is closed',
      ));
    }
    if (this.ready && this.child) {
      return Promise.resolve();
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.stderrTail = '';
    this.startPromise = new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.options.command, this.options.args ?? [], {
          cwd: this.options.cwd,
          env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
          stdio: [ 'pipe', 'pipe', 'pipe' ],
          windowsHide: true,
          shell: requiresWindowsCommandShell(this.options.command),
        });
      } catch (error) {
        this.startPromise = undefined;
        reject(this.runtimeUnavailable('Failed to start Local QLever runtime', error));
        return;
      }

      this.child = child;
      this.reader = createInterface({ input: child.stdout });
      const timeout = setTimeout(() => {
        this.failProcess(child, this.runtimeUnavailable(
          `Local QLever runtime did not become ready within ${this.startupTimeoutMs()}ms`,
        ));
      }, this.startupTimeoutMs());
      this.startup = { child, resolve, reject, timeout };

      this.reader.on('line', (line) => this.handleLine(child, line));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => this.appendStderr(chunk));
      child.stdin.on('error', (error) => {
        this.failProcess(child, this.runtimeUnavailable('Local QLever runtime stdin failed', error));
      });
      child.once('error', (error) => {
        this.failProcess(child, this.runtimeUnavailable('Local QLever runtime process failed', error));
      });
      // `close` fires after stdio has drained. Waiting for it preserves the
      // runtime's final stderr diagnostics in the error returned to callers.
      child.once('close', (code, signal) => {
        const detail = signal ? `signal ${signal}` : `code ${String(code)}`;
        this.failProcess(child, this.runtimeUnavailable(`Local QLever runtime exited with ${detail}`));
      });
    });
    return this.startPromise;
  }

  public async query(
    sparql: string,
    options: RdfNativeSparqlQueryOptions,
  ): Promise<RdfNativeSparqlResult> {
    if (options.signal?.aborted) {
      throw abortError(options.signal);
    }
    validateNativeSparqlQueryOptions(options);
    await this.waitForStart(options.signal);
    if (options.signal?.aborted) {
      throw abortError(options.signal);
    }

    const child = this.child;
    if (!child || !this.ready) {
      throw this.runtimeUnavailable('Local QLever runtime is unavailable');
    }

    const id = String(this.nextRequestId++);
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs();
    const wireOptions = {
      basePath: options.basePath,
      ...(options.sourceUri === undefined ? {} : { sourceUri: options.sourceUri }),
      ...(options.defaultDataset === undefined ? {} : { defaultDataset: options.defaultDataset }),
      ...(options.operation === undefined ? {} : { operation: options.operation }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.acceptMediaType === undefined ? {} : { acceptMediaType: options.acceptMediaType }),
      ...(options.loadDocument === undefined ? {} : { loadDocument: options.loadDocument }),
      ...(options.accessScope === undefined ? {} : { accessScope: options.accessScope }),
      ...(options.vectorQuery === undefined ? {} : { vectorQuery: options.vectorQuery }),
    };

    return new Promise<RdfNativeSparqlResult>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          if (!this.pending.delete(id)) {
            return;
          }
          this.cleanupPending(pending);
          this.cancelRequest(child, id);
          reject(new LocalQleverRuntimeError(
            'qlever_request_timeout',
            `Local QLever request ${id} timed out after ${timeoutMs}ms`,
          ));
        }, timeoutMs);
      }
      if (options.signal) {
        pending.signal = options.signal;
        pending.abortHandler = () => {
          if (!this.pending.delete(id)) {
            return;
          }
          this.cleanupPending(pending);
          this.cancelRequest(child, id);
          reject(abortError(options.signal as AbortSignal));
        };
        options.signal.addEventListener('abort', pending.abortHandler, { once: true });
      }
      this.pending.set(id, pending);

      try {
        this.writeMessage(child, {
          id,
          type: 'query',
          sparql,
          options: wireOptions,
        });
      } catch (error) {
        this.pending.delete(id);
        this.cleanupPending(pending);
        reject(this.runtimeUnavailable('Failed to write Local QLever request', error));
      }
    });
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const child = this.child;
    if (!child) {
      await this.awaitFailedProcessCleanup();
      return;
    }
    try {
      this.writeMessage(child, { type: 'shutdown' });
      child.stdin.end();
    } catch {
      // Closing is best-effort; failProcess below owns deterministic cleanup.
    }
    const closed = waitForChildClose(child);
    this.failProcess(child, new LocalQleverRuntimeError(
      'qlever_runtime_closed',
      'Local QLever runtime client closed',
    ), false);
    if (await waitForCloseOrTimeout(closed, GRACEFUL_SHUTDOWN_TIMEOUT_MS)) {
      return;
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
    if (await waitForCloseOrTimeout(closed, FORCED_SHUTDOWN_TIMEOUT_MS)) {
      return;
    }
    await forceCloseChild(child, closed);
  }

  private async waitForStart(signal?: AbortSignal): Promise<void> {
    const started = this.start();
    if (!signal) {
      return started;
    }
    if (signal.aborted) {
      throw abortError(signal);
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        cleanup();
        reject(abortError(signal));
      };
      const cleanup = (): void => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      started.then(
        () => {
          cleanup();
          resolve();
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (child !== this.child) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.failProcess(child, new LocalQleverRuntimeError(
        'qlever_runtime_protocol_error',
        `Local QLever runtime emitted malformed JSON: ${formatOffendingStdoutLine(line)}`,
        error,
      ));
      return;
    }

    if (!this.ready) {
      const expectedNativeAbi = this.options.expectedNativeSparqlAbiVersion ?? NATIVE_SPARQL_ABI_VERSION;
      const expectedBackendAbi = this.options.expectedPhysicalBackendAbiVersion ?? PHYSICAL_BACKEND_ABI_VERSION;
      if (
        !isReadyMessage(message)
        || message.abiVersion !== expectedNativeAbi
        || message.physicalBackendAbiVersion !== expectedBackendAbi
      ) {
        this.failProcess(child, new LocalQleverRuntimeError(
          'qlever_runtime_protocol_error',
          `Local QLever runtime ready contract mismatch; expected native SPARQL ABI ${expectedNativeAbi} and physical backend ABI ${expectedBackendAbi}`,
        ));
        return;
      }
      this.ready = true;
      const startup = this.startup;
      if (startup?.child === child) {
        clearTimeout(startup.timeout);
        this.startup = undefined;
        startup.resolve();
      }
      return;
    }

    if (isResultMessage(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      this.cleanupPending(pending);
      pending.resolve(message.result);
      return;
    }
    if (isErrorMessage(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      this.cleanupPending(pending);
      pending.reject(new LocalQleverRuntimeError(
        message.code || 'qlever_remote_error',
        message.message || 'Local QLever runtime rejected the request',
      ));
      return;
    }

    this.failProcess(child, new LocalQleverRuntimeError(
      'qlever_runtime_protocol_error',
      `Local QLever runtime emitted an invalid protocol message: ${formatOffendingStdoutLine(line)}`,
    ));
  }

  private failProcess(
    child: ChildProcessWithoutNullStreams,
    error: LocalQleverRuntimeError,
    terminate = true,
  ): void {
    if (child !== this.child) {
      return;
    }
    this.child = undefined;
    const closed = reapChild(child);
    this.failedProcessCleanup = terminate ? terminateChild(child, closed) : closed;
    this.ready = false;
    this.startPromise = undefined;
    this.reader?.close();
    this.reader = undefined;

    const startup = this.startup;
    if (startup?.child === child) {
      clearTimeout(startup.timeout);
      this.startup = undefined;
      startup.reject(error);
    }
    for (const [ id, pending ] of this.pending) {
      this.pending.delete(id);
      this.cleanupPending(pending);
      pending.reject(error);
    }
    void this.failedProcessCleanup;
  }

  private async awaitFailedProcessCleanup(): Promise<void> {
    const failedProcessCleanup = this.failedProcessCleanup;
    if (!failedProcessCleanup) {
      return;
    }
    try {
      await failedProcessCleanup;
    } finally {
      if (this.failedProcessCleanup === failedProcessCleanup) {
        this.failedProcessCleanup = undefined;
      }
    }
  }

  private cleanupPending(pending: PendingRequest): void {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener('abort', pending.abortHandler);
    }
  }

  private writeMessage(child: ChildProcessWithoutNullStreams, value: unknown): void {
    if (child !== this.child || child.stdin.destroyed || !child.stdin.writable) {
      throw this.runtimeUnavailable('Local QLever runtime stdin is unavailable');
    }
    child.stdin.write(`${JSON.stringify(value)}\n`, 'utf8');
  }

  private cancelRequest(child: ChildProcessWithoutNullStreams, id: string): void {
    try {
      this.writeMessage(child, { type: 'cancel', id });
    } catch {
      // The process lifecycle handler rejects every remaining request when the
      // runtime is gone. Cancellation must not mask the caller's own outcome.
    }
  }

  private appendStderr(chunk: string): void {
    this.stderrTail += chunk;
    const maxBytes = this.options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    while (Buffer.byteLength(this.stderrTail, 'utf8') > maxBytes && this.stderrTail.length > 0) {
      this.stderrTail = this.stderrTail.slice(Math.max(1, Math.floor(this.stderrTail.length / 8)));
    }
  }

  private runtimeUnavailable(message: string, cause?: unknown): LocalQleverRuntimeError {
    const stderr = this.stderrTail.trim();
    return new LocalQleverRuntimeError(
      'qlever_runtime_unavailable',
      stderr ? `${message}: ${stderr}` : message,
      cause,
    );
  }

  private startupTimeoutMs(): number {
    return this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  }

  private requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }
}

function reapChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  const closed = waitForChildClose(child);
  closed.then(undefined, () => undefined);
  return closed;
}

async function terminateChild(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<void>,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
  }
  if (await waitForCloseOrTimeout(closed, GRACEFUL_SHUTDOWN_TIMEOUT_MS)) {
    return;
  }
  await forceCloseChild(child, closed);
}

async function forceCloseChild(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<void>,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  if (await waitForCloseOrTimeout(closed, FORCED_SHUTDOWN_TIMEOUT_MS)) {
    return;
  }
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

function waitForChildClose(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once('close', () => resolve()));
}

async function waitForCloseOrTimeout(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref?.();
  });
  const didClose = await Promise.race([ closed.then(() => true as const), expired ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  return didClose;
}

function formatOffendingStdoutLine(line: string): string {
  const normalized = line.replace(/[\r\n]/gu, ' ');
  const maxLength = 240;
  return normalized.length <= maxLength
    ? JSON.stringify(normalized)
    : JSON.stringify(`${normalized.slice(0, maxLength)}…`);
}

function isReadyMessage(value: unknown): value is LocalQleverReadyMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as Partial<LocalQleverReadyMessage>;
  return message.type === 'ready'
    && message.backend === 'sqlite'
    && isPositiveInteger(message.abiVersion)
    && isPositiveInteger(message.physicalBackendAbiVersion);
}

function isResultMessage(value: unknown): value is LocalQleverResultMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as Partial<LocalQleverResultMessage>;
  return typeof message.id === 'string'
    && message.type === 'result'
    && isNativeResult(message.result);
}

function isErrorMessage(value: unknown): value is LocalQleverErrorMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as Partial<LocalQleverErrorMessage>;
  return typeof message.id === 'string'
    && message.type === 'error'
    && (message.code === undefined || typeof message.code === 'string')
    && (message.message === undefined || typeof message.message === 'string');
}

function isNativeResult(value: unknown): value is RdfNativeSparqlResult {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const result = value as Partial<RdfNativeSparqlResult>;
  return (result.status === 'ok' || result.status === 'unsupported' || result.status === 'error')
    && typeof result.mediaType === 'string'
    && typeof result.body === 'string'
    && (result.error === undefined || typeof result.error === 'string');
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new LocalQleverRuntimeError(
    'qlever_request_aborted',
    'Local QLever request was aborted',
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function validateNativeSparqlQueryOptions(options: RdfNativeSparqlQueryOptions): void {
  if (options.sourceUri !== undefined && !nonEmptyString(options.sourceUri)) {
    throw new TypeError('Native SPARQL sourceUri must be a non-empty string when provided');
  }
  if (options.defaultDataset !== undefined &&
    options.defaultDataset !== 'physical' &&
    options.defaultDataset !== 'exactSource' &&
    options.defaultDataset !== 'scopedUnion') {
    throw new TypeError('Native SPARQL defaultDataset must be physical, exactSource, or scopedUnion');
  }
  if (options.defaultDataset === 'exactSource' && options.sourceUri === undefined) {
    throw new TypeError('Native SPARQL exactSource defaultDataset requires sourceUri');
  }
  if (options.defaultDataset === 'scopedUnion' && options.sourceUri !== undefined) {
    throw new TypeError('Native SPARQL scopedUnion defaultDataset cannot use sourceUri');
  }
  if (options.vectorQuery !== undefined) {
    validateVectorQuery(options.vectorQuery);
  }
}

function validateVectorQuery(vectorQuery: RdfNativeSparqlVectorQueryOptions): void {
  if (!Array.isArray(vectorQuery.embedding) || vectorQuery.embedding.length === 0) {
    throw new TypeError('Native SPARQL vectorQuery.embedding must be a non-empty finite number array');
  }
  if (!vectorQuery.embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new TypeError('Native SPARQL vectorQuery.embedding must contain only finite numbers');
  }
  if (!isVectorMetric(vectorQuery.metric)) {
    throw new TypeError('Native SPARQL vectorQuery.metric must be cosine, dot, or euclidean');
  }
  for (const field of [ 'provider', 'model', 'modelVersion', 'inputKind', 'projectionPolicyVersion' ] as const) {
    if (!nonEmptyString(vectorQuery[field])) {
      throw new TypeError(`Native SPARQL vectorQuery.${field} is required`);
    }
  }
  if (!isPositiveInteger(vectorQuery.limit)) {
    throw new TypeError('Native SPARQL vectorQuery.limit must be a positive integer');
  }
  if (
    vectorQuery.threshold !== undefined &&
    (typeof vectorQuery.threshold !== 'number' || !Number.isFinite(vectorQuery.threshold))
  ) {
    throw new TypeError('Native SPARQL vectorQuery.threshold must be finite when provided');
  }
  if (
    vectorQuery.retrievalPointVariable !== undefined &&
    !nonEmptyString(vectorQuery.retrievalPointVariable)
  ) {
    throw new TypeError('Native SPARQL vectorQuery.retrievalPointVariable must be non-empty when provided');
  }
  if (
    vectorQuery.resourceVariable !== undefined &&
    !nonEmptyString(vectorQuery.resourceVariable)
  ) {
    throw new TypeError('Native SPARQL vectorQuery.resourceVariable must be non-empty when provided');
  }
  if (
    vectorQuery.retrievalPointVariable === undefined &&
    vectorQuery.resourceVariable === undefined
  ) {
    throw new TypeError('Native SPARQL vectorQuery requires retrievalPointVariable or resourceVariable');
  }
}

function isVectorMetric(value: unknown): value is RdfNativeSparqlVectorQueryOptions['metric'] {
  return value === 'cosine' || value === 'dot' || value === 'euclidean';
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
