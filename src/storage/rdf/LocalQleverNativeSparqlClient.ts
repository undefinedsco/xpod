import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type {
  RdfNativeQueryExecution,
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

type RequestOutcome =
  | { ok: true; value: RdfNativeSparqlResult }
  | { ok: false; error: unknown };

interface NativeRequest {
  id: string;
  sparql: string;
  options: RdfNativeSparqlQueryOptions;
  timeoutMs: number;
  resolveResult(result: RdfNativeSparqlResult): void;
  rejectResult(error: unknown): void;
  resolveDrain(): void;
  resultDelivered: boolean;
  terminal: boolean;
  started: boolean;
  cancelled: boolean;
  drainSettled: boolean;
  dispatched: boolean;
  /** The owned child incarnation this request is bound to, set before dispatch. */
  incarnation?: NativeIncarnation;
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

/**
 * One owned child incarnation. `promise` resolves when the child is ready (rejects on startup
 * failure); `cleanup` settles only once the owned child has actually terminated/been reaped. Requests
 * that start before readiness are bound to the incarnation whose child actually produced them.
 */
interface NativeIncarnation {
  child: ChildProcessWithoutNullStreams;
  ready: boolean;
  promise: Promise<void>;
  resolveReady(): void;
  rejectReady(error: unknown): void;
  cleanup: Promise<void>;
  cleanupError?: unknown;
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
  private readonly pending = new Map<string, NativeRequest>();
  private readonly incarnations: NativeIncarnation[] = [];
  /** Currently-starting or live incarnation; cleared once ready, closed, or failed. */
  private owner?: NativeIncarnation;
  private nextRequestId = 1;
  private stderrTail = '';
  private ready = false;
  private closed = false;
  private closePromise?: Promise<void>;

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
    // Do not restart over an owned producer whose termination/cleanup is still unconfirmed.
    if (this.owner && this.startPromise) {
      return this.startPromise;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.stderrTail = '';
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Internal rejection stays handled; callers observe it through their own result/drain binding.
    readyPromise.catch(() => undefined);

    this.startPromise = readyPromise;
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
      rejectReady(this.runtimeUnavailable('Failed to start Local QLever runtime', error));
      return readyPromise;
    }

    const closed = waitForChildClose(child);
    const incarnation: NativeIncarnation = {
      child,
      ready: false,
      promise: readyPromise,
      resolveReady,
      rejectReady,
      cleanup: closed,
    };
    this.incarnations.push(incarnation);
    void closed.then(() => this.forgetIncarnation(incarnation));
    this.owner = incarnation;

    this.child = child;
    this.reader = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => {
      this.failProcess(child, this.runtimeUnavailable(
        `Local QLever runtime did not become ready within ${this.startupTimeoutMs()}ms`,
      ));
    }, this.startupTimeoutMs());
    this.startup = { child, resolve: resolveReady, reject: rejectReady, timeout };

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
    return readyPromise;
  }

  public async query(
    sparql: string,
    options: RdfNativeSparqlQueryOptions,
  ): Promise<RdfNativeSparqlResult> {
    const execution = this.createQueryExecution(sparql, options);
    execution.start();
    return execution.result;
  }

  /**
   * Create a generic execution descriptor. No process is spawned and no message is written here;
   * `start()` begins the request after the caller has had a chance to observe `drained`.
   */
  public createQueryExecution(
    sparql: string,
    options: RdfNativeSparqlQueryOptions,
  ): RdfNativeQueryExecution {
    validateNativeSparqlQueryOptions(options);
    let resolveResult!: (result: RdfNativeSparqlResult) => void;
    let rejectResult!: (error: unknown) => void;
    let resolveDrain!: () => void;
    const result = new Promise<RdfNativeSparqlResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const drained = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    // Keep internal rejection handled; the caller still observes the rejection on `result`.
    result.catch(() => undefined);

    const request: NativeRequest = {
      id: String(this.nextRequestId++),
      sparql,
      options,
      timeoutMs: options.timeoutMs ?? this.requestTimeoutMs(),
      resolveResult,
      rejectResult,
      resolveDrain,
      resultDelivered: false,
      terminal: false,
      started: false,
      cancelled: false,
      drainSettled: false,
      dispatched: false,
    };

    return {
      result,
      drained,
      start: (): void => {
        void this.startRequest(request);
      },
      cancel: (): void => {
        this.cancelRequest(request);
      },
    };
  }

  public close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    const child = this.child;
    if (child) {
      const closed = waitForChildClose(child);
      try {
        this.writeMessage(child, { type: 'shutdown' });
        child.stdin.end();
      } catch {
        // Closing is best-effort; incarnation cleanup owns deterministic termination.
      }
      // Wait for graceful exit; escalate only if the owned child does not close in time.
      if (!await waitForCloseOrTimeout(closed, GRACEFUL_SHUTDOWN_TIMEOUT_MS)) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
        }
        if (!await waitForCloseOrTimeout(closed, FORCED_SHUTDOWN_TIMEOUT_MS)) {
          await forceCloseChild(child, closed);
        }
      }
      this.failProcess(child, new LocalQleverRuntimeError(
        'qlever_runtime_closed',
        'Local QLever runtime client closed',
      ), false, closed);
    }
    // Every close completion must include every owned producer/initialization that can still access
    // storage, including older failed-startup incarnations that predate a restart.
    while (this.incarnations.length > 0) {
      await Promise.all(this.incarnations.map((incarnation) => incarnation.cleanup));
    }
    this.owner = undefined;
  }

  private async startRequest(request: NativeRequest): Promise<void> {
    if (request.started || request.terminal) {
      return;
    }
    request.started = true;
    const signal = request.options.signal;
    if (signal?.aborted) {
      this.settleResult(request, { ok: false, error: abortError(signal) });
      this.settleTerminal(request);
      return;
    }
    if (this.closed) {
      this.settleResult(request, { ok: false, error: new LocalQleverRuntimeError(
        'qlever_runtime_closed',
        'Local QLever runtime client is closed',
      ) });
      this.settleTerminal(request);
      return;
    }

    // Create/locate the owned incarnation and bind this request to it before any await. The request's
    // drain can then track the actual producer lifecycle rather than a caller-side outcome.
    const started = this.start();
    const incarnation = this.owner ?? this.incarnations.find((value) => value.ready);
    if (!incarnation) {
      // No owned child exists; the caller outcome and drain both settle (nothing was dispatched).
      this.settleResult(request, { ok: false, error: new LocalQleverRuntimeError(
        'qlever_runtime_unavailable',
        'Local QLever runtime is unavailable',
      ) });
      this.settleTerminal(request);
      return;
    }
    request.incarnation = incarnation;

    // While the owned child initializes, a caller abort/cancel rejects `result` promptly but must NOT
    // settle `drained`: real initialization is still in flight. Drain follows the startup outcome.
    if (signal) {
      request.signal = signal;
      request.abortHandler = () => {
        if (request.terminal) {
          return;
        }
        this.settleResult(request, { ok: false, error: abortError(signal) });
      };
      signal.addEventListener('abort', request.abortHandler, { once: true });
    }

    try {
      await incarnation.promise;
    } catch (error) {
      this.settleResult(request, { ok: false, error });
      // Drain settles only once the failing producer's cleanup has actually completed.
      void incarnation.cleanup.then(() => this.settleTerminal(request));
      return;
    }
    if (request.terminal) {
      return;
    }
    if (request.cancelled || signal?.aborted) {
      // Real initialization completed, but no query was dispatched. Drain now, without requiring the
      // shared healthy child to die; the caller already received its abort/cancel outcome promptly.
      if (signal?.aborted) {
        this.settleResult(request, { ok: false, error: abortError(signal) });
      }
      this.settleTerminal(request);
      return;
    }

    const child = this.child;
    if (!child || !this.ready) {
      this.settleResult(request, { ok: false, error: this.runtimeUnavailable('Local QLever runtime is unavailable') });
      void incarnation.cleanup.then(() => this.settleTerminal(request));
      return;
    }
    if (request.timeoutMs > 0) {
      request.timeout = setTimeout(() => this.onRequestTimeout(request), request.timeoutMs);
    }
    if (signal) {
      request.signal = signal;
      if (request.abortHandler) {
        signal.removeEventListener('abort', request.abortHandler);
      }
      request.abortHandler = () => this.onRequestAbort(request);
      signal.addEventListener('abort', request.abortHandler, { once: true });
    }
    // Retain the request until an actual terminal, so a late result/error can drain it.
    this.pending.set(request.id, request);
    request.dispatched = true;

    try {
      this.writeMessage(child, {
        id: request.id,
        type: 'query',
        sparql: request.sparql,
        options: wireQueryOptions(request.options),
      });
    } catch (error) {
      // A stdin write failure alone is not producer drain; the process lifecycle will settle it.
      this.settleResult(request, {
        ok: false,
        error: this.runtimeUnavailable('Failed to write Local QLever request', error),
      });
    }
  }

  private onRequestTimeout(request: NativeRequest): void {
    if (request.terminal) {
      return;
    }
    this.clearRequestWaiters(request);
    this.settleResult(request, { ok: false, error: new LocalQleverRuntimeError(
      'qlever_request_timeout',
      `Local QLever request ${request.id} timed out after ${request.timeoutMs}ms`,
    ) });
    if (request.dispatched && request.incarnation) {
      this.sendCancel(request.incarnation.child, request.id);
    }
    // Drain stays pending until the real terminal.
  }

  private onRequestAbort(request: NativeRequest): void {
    if (request.terminal) {
      return;
    }
    const signal = request.signal;
    this.clearRequestWaiters(request);
    this.settleResult(request, { ok: false, error: signal ? abortError(signal) : new LocalQleverRuntimeError(
      'qlever_request_aborted',
      'Local QLever request was aborted',
    ) });
    if (request.dispatched && request.incarnation) {
      this.sendCancel(request.incarnation.child, request.id);
    }
    // Drain stays pending until the real terminal.
  }

  private cancelRequest(request: NativeRequest): void {
    if (request.terminal) {
      return;
    }
    request.cancelled = true;
    this.clearRequestWaiters(request);
    this.settleResult(request, { ok: false, error: new LocalQleverRuntimeError(
      'qlever_request_aborted',
      'Local QLever request was cancelled',
    ) });
    if (!request.started) {
      // Pre-start cancellation has no side effect: the unused descriptor settles immediately.
      this.settleTerminal(request);
      return;
    }
    if (request.dispatched && request.incarnation) {
      this.sendCancel(request.incarnation.child, request.id);
      return;
    }
    // Started but not yet dispatched: drain on the actual startup completion/cleanup, never on this
    // cancel message. If startup already settled, startRequest has/will settle the terminal.
  }

  private completeRequest(request: NativeRequest, outcome: RequestOutcome): void {
    this.clearRequestWaiters(request);
    this.settleResult(request, outcome);
    this.settleTerminal(request);
  }

  private settleResult(request: NativeRequest, outcome: RequestOutcome): void {
    if (request.resultDelivered) {
      return;
    }
    request.resultDelivered = true;
    if (outcome.ok) {
      request.resolveResult(outcome.value);
    } else {
      request.rejectResult(outcome.error);
    }
  }

  private settleTerminal(request: NativeRequest): void {
    if (request.terminal) {
      return;
    }
    request.terminal = true;
    this.clearRequestWaiters(request);
    if (!request.drainSettled) {
      request.drainSettled = true;
      request.resolveDrain();
    }
  }

  private clearRequestWaiters(request: NativeRequest): void {
    if (request.timeout) {
      clearTimeout(request.timeout);
      request.timeout = undefined;
    }
    if (request.signal && request.abortHandler) {
      request.signal.removeEventListener('abort', request.abortHandler);
      request.abortHandler = undefined;
    }
  }

  private sendCancel(child: ChildProcessWithoutNullStreams, id: string): void {
    try {
      this.writeMessage(child, { type: 'cancel', id });
    } catch {
      // The process lifecycle handler rejects every remaining request when the runtime is gone.
      // Cancellation must not mask the caller's own outcome.
    }
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
      const incarnation = this.incarnations.find((value) => value.child === child);
      if (incarnation) {
        incarnation.ready = true;
      }
      const startup = this.startup;
      if (startup?.child === child) {
        clearTimeout(startup.timeout);
        this.startup = undefined;
        startup.resolve();
      }
      return;
    }

    if (isResultMessage(message)) {
      const request = this.pending.get(message.id);
      // Unknown, duplicate, or wrong-incarnation outcomes must not drain another request.
      if (!request || request.incarnation?.child !== child) {
        return;
      }
      this.pending.delete(message.id);
      this.completeRequest(request, { ok: true, value: message.result });
      return;
    }
    if (isErrorMessage(message)) {
      const request = this.pending.get(message.id);
      if (!request || request.incarnation?.child !== child) {
        return;
      }
      this.pending.delete(message.id);
      this.completeRequest(request, { ok: false, error: new LocalQleverRuntimeError(
        message.code || 'qlever_remote_error',
        message.message || 'Local QLever runtime rejected the request',
      ) });
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
    closed: Promise<void> = waitForChildClose(child),
  ): void {
    const incarnation = this.incarnations.find((value) => value.child === child);
    // Ignore a stale/foreign child; only an owned incarnation can drive lifecycle state.
    if (!incarnation) {
      return;
    }
    const isCurrent = child === this.child;
    if (isCurrent) {
      this.child = undefined;
      this.ready = false;
      this.startPromise = undefined;
      this.reader?.close();
      this.reader = undefined;
      this.owner = this.owner === incarnation ? undefined : this.owner;
    }
    // All old cleanup is retained (incarnation.cleanup) until actually complete; confirmed cleanup
    // removes the record so a later restart cannot discard it.
    // A termination attempt is not completion: only the original owned close latch can drain.
    if (terminate) {
      void terminateChild(child, incarnation.cleanup).catch((cleanupError: unknown) => {
        incarnation.cleanupError = cleanupError;
      });
    }

    if (isCurrent) {
      const startup = this.startup;
      if (startup?.child === child) {
        clearTimeout(startup.timeout);
        this.startup = undefined;
        startup.reject(error);
      }
    }
    // Reject this incarnation's requests promptly; drain only once its cleanup actually completes.
    for (const [ id, request ] of [ ...this.pending ]) {
      if (request.incarnation !== incarnation) {
        continue;
      }
      this.pending.delete(id);
      this.clearRequestWaiters(request);
      this.settleResult(request, { ok: false, error });
      void incarnation.cleanup.then(() => this.settleTerminal(request));
    }
  }

  private forgetIncarnation(incarnation: NativeIncarnation): void {
    const index = this.incarnations.indexOf(incarnation);
    if (index !== -1) {
      this.incarnations.splice(index, 1);
    }
  }

  private writeMessage(child: ChildProcessWithoutNullStreams, value: unknown): void {
    if (child !== this.child || child.stdin.destroyed || !child.stdin.writable) {
      throw this.runtimeUnavailable('Local QLever runtime stdin is unavailable');
    }
    child.stdin.write(`${JSON.stringify(value)}\n`, 'utf8');
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

function wireQueryOptions(options: RdfNativeSparqlQueryOptions): Record<string, unknown> {
  return {
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
  // The deadline alone is not proof of termination: release stdio, then require the actual
  // owned-child `close` before reporting completion.
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  await closed;
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
