import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import TransportStream from 'winston-transport';
import type * as Transport from 'winston-transport';
import { MESSAGE } from 'triple-beam';
import { setGlobalLoggerFactory } from 'global-logger-factory';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { mkdirSync, rmSync } from 'node:fs';
import { ConfigurableLoggerFactory } from '../../../src/logging/ConfigurableLoggerFactory';
import { PodMatrixStore } from '../../../src/api/matrix';
import { InMemoryMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';
import { MatrixError } from '../../../src/api/matrix/MatrixError';
import { chatResource, messageResource } from '@undefineds.co/models';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';

vi.mock('@undefineds.co/drizzle-solid', async () => {
  const actual = await vi.importActual<typeof import('@undefineds.co/drizzle-solid')>('@undefineds.co/drizzle-solid');
  return { ...actual, drizzle: vi.fn() };
});

const logRoot = path.resolve(process.cwd(), '.test-data', 'pod-matrix-store-diagnostics');

/** Captures the final formatted line produced by the shared logger factory. */
class MemoryTransport extends TransportStream {
  public readonly lines: string[] = [];
  public override log(info: Record<symbol, unknown>, callback: () => void): void {
    this.lines.push(String(info[MESSAGE] ?? ''));
    callback();
  }
}

class CapturingLoggerFactory extends ConfigurableLoggerFactory {
  public readonly memory = new MemoryTransport();
  protected override createTransports(): Transport[] {
    return [ this.memory ];
  }
}

let logFactory: CapturingLoggerFactory;

beforeAll(() => {
  rmSync(logRoot, { recursive: true, force: true });
  mkdirSync(logRoot, { recursive: true });
  logFactory = new CapturingLoggerFactory('debug', {
    fileName: path.join(logRoot, 'pod-matrix-%DATE%.log'),
    showLocation: false,
  });
  setGlobalLoggerFactory(logFactory);
});

afterAll(async () => {
  const transport = (logFactory as unknown as {
    fileTransport?: { close?: () => void; logStream?: { end?: (cb?: () => void) => void } };
  }).fileTransport;
  await new Promise<void>((resolve) => {
    try {
      transport?.close?.();
      transport?.logStream?.end?.(() => resolve());
      setTimeout(resolve, 200);
    } catch {
      resolve();
    }
  });
  rmSync(logRoot, { recursive: true, force: true });
});

beforeEach(() => { vi.clearAllMocks(); logFactory.memory.lines.length = 0; });

type PhaseLine = { op: string; opId: string; phase: string };

/** Extract the correlated (op, opId, phase) triples from captured log lines. */
function phaseLines(text: string): PhaseLine[] {
  const lines: PhaseLine[] = [];
  for (const line of text.split('\n')) {
    const match = /"op":"([^"]+)".*?"opId":"([0-9a-f]+)".*?"phase":"([^"]+)"/.exec(line);
    if (match) lines.push({ op: match[1], opId: match[2], phase: match[3] });
  }
  return lines;
}

/**
 * A drizzle stand-in bound to one traced fetch: `init` and every `select`
 * issue an outbound request, so the cache's correlation is observable.
 */
function fetchCallingDb(podFetch: typeof fetch): Record<string, unknown> {
  return {
    init: async () => { await podFetch('https://pod.example/init'); },
    select: () => {
      const query: any = {
        from: () => query,
        where: () => query,
        then: (ok: (value: unknown) => unknown, fail: (error: unknown) => unknown) =>
          podFetch('https://pod.example/select').then(() => []).then(ok, fail),
      };
      return query;
    },
    findById: async () => undefined,
    insert: () => ({ values: async () => undefined }),
    updateById: async () => undefined,
  };
}


/**
 * Target's `sendEvent` loads the room and its timeline once, then reuses both
 * for the membership and authorization checks. Tests that exercise the later
 * PUT boundaries stub those two single-load awaits; the membership and
 * authorization boundaries are stubbed per test.
 */
function stubSingleRoomLoad(store: unknown, events: unknown[] = []): void {
  vi.spyOn(store as { roomSource: unknown }, 'roomSource' as never)
    .mockResolvedValue({ id: '!room:example.test', title: 'Room', metadata: null, participants: [] } as never);
  vi.spyOn(store as { listEvents: unknown }, 'listEvents' as never).mockResolvedValue(events as never);
}

async function tracedFetchFor(podFetch: typeof fetch): Promise<typeof fetch> {
  const { context: cachedContext, db } = matrixHarness();
  const { _matrixDb: _cachedDb, ...context } = cachedContext;
  vi.mocked(drizzle).mockReturnValue(db);
  const store = new PodMatrixStore({ serverName: 'example.test', podAccess: { getPodFetch: async () => podFetch } });
  await store.createRoom({}, context);
  logFactory.memory.lines.length = 0;
  return (vi.mocked(drizzle).mock.calls[vi.mocked(drizzle).mock.calls.length - 1][0] as { fetch: typeof fetch }).fetch;
}

describe('PodMatrixStore raw reader metadata', () => {
  it('keeps original reader, read promise and chunks while observing pending then EOS', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const response = new Response(stream, { headers: {
      'content-type': 'text/turtle', 'content-length': '2',
      'transfer-encoding': 'private-secret', 'content-encoding': 'identity',
    } });
    const reader = stream.getReader();
    reader.releaseLock();
    const nativeGet = stream.getReader;
    let originalReader!: ReadableStreamDefaultReader<Uint8Array>;
    let originalPromise!: Promise<ReadableStreamReadResult<Uint8Array>>;
    vi.spyOn(stream, 'getReader').mockImplementation(function(this: ReadableStream<Uint8Array>) {
      expect(this).toBe(stream);
      originalReader = nativeGet.call(this) as ReadableStreamDefaultReader<Uint8Array>;
      const read = originalReader.read;
      Object.defineProperty(originalReader, 'read', { configurable: true, value: function(this: ReadableStreamDefaultReader<Uint8Array>) {
        expect(this).toBe(originalReader);
        return originalPromise = read.call(this);
      } });
      return originalReader;
    });
    const traced = await tracedFetchFor(vi.fn(async () => response));
    expect(await traced('https://private.example')).toBe(response);
    expect(response.body).toBe(stream);
    const observed = response.body!.getReader();
    expect(observed).toBe(originalReader);
    const pending = observed.read();
    expect(pending).toBe(originalPromise);
    expect(logFactory.memory.lines.join('\n')).not.toContain('"phase":"podFetch.stream.done"');
    const chunk = new Uint8Array([1, 2]);
    controller.enqueue(chunk);
    expect((await pending).value).toBe(chunk);
    controller.close();
    expect((await observed.read()).done).toBe(true);
    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"phase":"podFetch.stream.done"');
    expect(logged).toContain('"receivedBytes":2');
    expect(logged).toContain('"contentType":"text/turtle"');
    expect(logged).not.toContain('private-secret');
    expect(logged).not.toContain('private.example');
  });

  it('records late EOF after abort as stopped, and inaccessible hooks as unobserved', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }));
    const abort = new AbortController();
    const traced = await tracedFetchFor(vi.fn(async () => response));
    await traced('https://private.example', { signal: abort.signal });
    const reader = response.body!.getReader();
    const pending = reader.read();
    abort.abort('private-secret');
    controller.close();
    expect((await pending).done).toBe(true);
    expect(logFactory.memory.lines.join('\n')).toContain('"transportEOS":false');
    expect(logFactory.memory.lines.join('\n')).toContain('podFetch.stream.doneAfterStop');
    const second = new Response(new ReadableStream<Uint8Array>());
    Object.preventExtensions(second.body!);
    const other = await tracedFetchFor(vi.fn(async () => second));
    await other('https://private.example');
    expect(logFactory.memory.lines.join('\n')).toContain('podFetch.stream.unobserved');
    await second.body!.cancel();
  });

  it('preserves wrong-this brand errors, short chunks and partial coverage', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(new Uint8Array([1])); c.enqueue(new Uint8Array([2])); c.close();
    } });
    const nativeGet = stream.getReader;
    Object.defineProperty(stream, 'getReader', { configurable: true, value: function(this: ReadableStream) {
      const reader = nativeGet.call(this);
      Object.defineProperty(reader, 'cancel', { configurable: false, value: reader.cancel });
      return reader;
    } });
    const response = new Response(stream);
    const traced = await tracedFetchFor(vi.fn(async () => response));
    await traced('https://private.example');
    expect(() => Reflect.apply(stream.getReader, {}, [])).toThrow(TypeError);
    const reader = stream.getReader();
    await reader.read(); await reader.read(); await reader.read();
    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"receivedBytes":2');
    expect(logged).toContain('"coverage":"partial"');
    expect(logged).toContain('"transportEOS":false');
    expect(logged).toContain('podFetch.stream.unobserved');
    reader.releaseLock();
  });

  it('isolates logger failure and preserves the original cancel promise and reason', async () => {
    const { store } = matrixHarness();
    const response = new Response(new ReadableStream<Uint8Array>());
    const stream = response.body!;
    const nativeGet = stream.getReader;
    let originalPromise!: Promise<void>;
    let receivedReason: unknown;
    Object.defineProperty(stream, 'getReader', { configurable: true, value: function(this: ReadableStream) {
      const reader = nativeGet.call(this);
      const cancel = reader.cancel;
      Object.defineProperty(reader, 'cancel', { configurable: true, value: function(this: ReadableStreamDefaultReader, reason: unknown) {
        receivedReason = reason;
        return originalPromise = cancel.call(this, reason);
      } });
      return reader;
    } });
    vi.spyOn(store as any, 'logPhase').mockImplementation(() => { throw new Error('private-secret'); });
    expect(() => (store as any).traceRawBody(response, { operation: 'sync', id: '1234abcd' }, {})).not.toThrow();
    const reader = stream.getReader();
    const reason = { private: 'secret' };
    const promise = reader.cancel(reason);
    expect(promise).toBe(originalPromise);
    expect(receivedReason).toBe(reason);
    await promise;
    reader.releaseLock();
  });

  it.each(['read', 'cancel', 'releaseLock'])('returns the original reader when diagnostic %s getters throw', (method) => {
    const { store } = matrixHarness();
    const reader = { read: () => Promise.resolve({ done: true }), cancel: () => Promise.resolve(), releaseLock: () => undefined };
    Object.defineProperty(reader, method, { get() { throw new Error('private-secret'); } });
    const stream = { getReader: () => reader };
    (store as any).traceRawBody({ body: stream }, { operation: 'sync', id: '1234abcd' }, {});
    expect(stream.getReader()).toBe(reader);
    expect(logFactory.memory.lines.join('\n')).toContain('"coverage":"unobserved"');
  });

  it.each(['getter', 'call'])('returns native promises with hostile own then %s for read and cancel', async (mode) => {
    const { store } = matrixHarness();
    const promise = Promise.resolve({ done: true, value: undefined });
    Object.defineProperty(promise, 'then', mode === 'getter' ? { get() { throw new Error('private-secret'); } } : { value() { throw new Error('private-secret'); } });
    const reader = { read: () => promise, cancel: () => promise, releaseLock: () => undefined };
    const stream = { getReader: () => reader };
    (store as any).traceRawBody({ body: stream }, { operation: 'sync', id: '1234abcd' }, {});
    expect(stream.getReader()).toBe(reader);
    expect(reader.read()).toBe(promise);
    expect(reader.cancel()).toBe(promise);
    expect(logFactory.memory.lines.join('\n')).toContain('"coverage":"partial"');
    expect(logFactory.memory.lines.join('\n')).not.toContain('"transportEOS":true');
    await Promise.prototype.then.call(promise, () => undefined);
  });

  it('downgrades failed stream hooks and failed abort registration, and removes terminal listeners', async () => {
    const { store } = matrixHarness();
    const frozen = Object.freeze({ getReader: () => ({}) });
    (store as any).traceRawBody({ body: frozen }, { operation: 'sync', id: '1234abcd' }, {});
    expect(logFactory.memory.lines.join('\n')).toContain('"coverage":"unobserved"');
    logFactory.memory.lines.length = 0;
    const response = new Response('short');
    const badSignal = { aborted: false, addEventListener() { throw new Error('private-secret'); }, removeEventListener() {} };
    (store as any).traceRawBody(response, { operation: 'sync', id: '1234abcd' }, {}, badSignal);
    const reader = response.body!.getReader();
    await reader.read(); await reader.read();
    expect(logFactory.memory.lines.join('\n')).toContain('"coverage":"partial"');
    expect(logFactory.memory.lines.join('\n')).not.toContain('"transportEOS":true');
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const other = new Response('short');
    (store as any).traceRawBody(other, { operation: 'sync', id: '1234abcd' }, {}, abort.signal);
    const second = other.body!.getReader();
    await second.read(); await second.read();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    logFactory.memory.lines.length = 0;
    abort.abort();
    expect(logFactory.memory.lines).toHaveLength(0);
  });

  it('keeps parser rejection separate from raw transport EOS', async () => {
    const response = new Response('invalid-private-json');
    const traced = await tracedFetchFor(vi.fn(async () => response));
    await traced('https://private.example');
    await expect(response.json()).rejects.toBeInstanceOf(SyntaxError);
    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('podFetch.body.json.failed');
    expect(logged).toContain('podFetch.stream.done');
    expect(logged).toContain('"transportEOS":true');
    expect(logged).not.toContain('invalid-private-json');
  });

  it('distinguishes caller abort, cancel and stream error without reading error messages', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }));
    const abort = new AbortController();
    const traced = await tracedFetchFor(vi.fn(async () => response));
    await traced('https://private.example', { signal: abort.signal });
    const reader = response.body!.getReader();
    const pending = reader.read();
    const failure = new DOMException('private-secret', 'AbortError');
    const rejected = expect(pending).rejects.toBe(failure);
    abort.abort(failure);
    controller.error(failure);
    await rejected;
    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('podFetch.stream.callerAbort');
    expect(logged).toContain('podFetch.stream.error');
    expect(logged).not.toContain('private-secret');
    const second = new Response(new ReadableStream<Uint8Array>());
    const other = await tracedFetchFor(vi.fn(async () => second));
    await other('https://private.example');
    await second.body!.getReader().cancel('private-secret');
    expect(logFactory.memory.lines.join('\n')).toContain('podFetch.stream.cancel');
    expect(logFactory.memory.lines.join('\n')).not.toContain('private-secret');
  });
});

describe('PodMatrixStore response body boundaries', () => {
  it('records fast headers and a deferred JSON read before its original rejection', async () => {
    let rejectBody!: (error: unknown) => void;
    const body = new Promise<unknown>((_resolve, reject) => { rejectBody = reject; });
    const response = new Response('{}');
    const json = vi.spyOn(response, 'json').mockImplementation(function(this: Response) {
      expect(this).toBe(response);
      return body;
    });
    const traced = await tracedFetchFor(vi.fn(async () => response));
    logFactory.memory.lines.length = 0;
    const returned = await traced('https://private.example/body?token=private');
    expect(returned).toBe(response);
    expect(json).not.toHaveBeenCalled();
    const bodyError = new DOMException('private URL/body/token', 'TimeoutError');
    const pending = returned.json();
    const rejection = expect(pending).rejects.toBe(bodyError);
    const waiting = logFactory.memory.lines.join('\n');
    expect(waiting).toContain('"phase":"podFetch.start"');
    expect(waiting).toContain('"phase":"podFetch.headers"');
    expect(waiting).toContain('"phase":"podFetch.body.json.start"');
    expect(waiting).not.toContain('"phase":"podFetch.body.json.done"');
    rejectBody(bodyError);
    await rejection;
    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"phase":"podFetch.body.json.failed"');
    expect(logged).toContain('"code":23');
    const ids = logFactory.memory.lines.map(line => /"fetchId":(\d+)/.exec(line)?.[1]);
    expect(ids.every(id => id !== undefined && id === ids[0])).toBe(true);
    for (const secret of ['private.example', 'private URL/body/token', '?token=']) expect(logged).not.toContain(secret);
  });

  it('preserves native response, untouched streaming body, clone and bound methods', async () => {
    const response = new Response('{"value":7}', { status: 200, headers: { 'x-example': 'unchanged' } });
    const stream = response.body;
    const nativeText = response.text;
    const text = vi.spyOn(response, 'text').mockImplementation(function(this: Response) {
      expect(this).toBe(response);
      return nativeText.call(this);
    });
    const traced = await tracedFetchFor(vi.fn(async () => response));
    logFactory.memory.lines.length = 0;
    const returned = await traced('https://private.example/body');
    expect(returned).toBe(response);
    expect(returned.body).toBe(stream);
    expect(returned.bodyUsed).toBe(false);
    expect(stream?.locked).toBe(false);
    expect(text).not.toHaveBeenCalled();
    expect(returned.headers.get('x-example')).toBe('unchanged');
    expect(logFactory.memory.lines.join('\n')).not.toContain('podFetch.body.');
    const clone = returned.clone();
    expect(clone).toBeInstanceOf(Response);
    expect(clone.status).toBe(returned.status);
    await expect(clone.json()).resolves.toEqual({ value: 7 });
    await expect(returned.text.bind(returned)()).resolves.toBe('{"value":7}');
    expect(returned.bodyUsed).toBe(true);
    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"phase":"podFetch.body.json.done"');
    expect(logged).toContain('"phase":"podFetch.body.text.done"');
    expect(() => returned.clone()).toThrow(TypeError);
  });

  it('records current-operation body boundaries when a DB fetch is cached across sync calls', async () => {
    const { context: cachedContext } = matrixHarness();
    const { _matrixDb: _cachedDb, ...context } = cachedContext;
    vi.mocked(drizzle).mockImplementation(((options: any) => fetchCallingDb(async (...args: Parameters<typeof fetch>) => {
      const response = await options.fetch(...args);
      await response.json();
      return response;
    })) as never);
    const store = new PodMatrixStore({ serverName: 'example.test', podAccess: {
      getPodFetch: async () => vi.fn(async () => new Response('{}')) as typeof fetch,
    } });
    logFactory.memory.lines.length = 0;
    await store.sync(context);
    const first = phaseLines(logFactory.memory.lines.join('\n'));
    logFactory.memory.lines.length = 0;
    await store.sync(context);
    const second = phaseLines(logFactory.memory.lines.join('\n'));
    const firstBody = first.find(line => line.phase === 'podFetch.body.json.done');
    const secondBody = second.find(line => line.phase === 'podFetch.body.json.done');
    expect(firstBody?.opId).toBeDefined();
    expect(secondBody?.opId).toBeDefined();
    expect(secondBody?.opId).not.toBe(firstBody?.opId);
    expect(secondBody?.opId).toBe(second.find(line => line.phase === 'sync.watermark.start')?.opId);
  });

  it('writes an await start while an events select remains deferred and records its terminal error', async () => {
    let rejectSelect!: (error: unknown) => void;
    const selected = new Promise<unknown>((_resolve, reject) => { rejectSelect = reject; });
    const { store } = matrixHarness();
    const failure = new Error('private select failure');
    logFactory.memory.lines.length = 0;
    const pending = (store as any).runPhase({ operation: 'sync', id: '1234abcd' }, 'events.select', {}, () => selected);
    const rejection = expect(pending).rejects.toBe(failure);
    expect(logFactory.memory.lines.join('\n')).toContain('"phase":"events.select.start"');
    expect(logFactory.memory.lines.join('\n')).not.toContain('"phase":"events.select.failed"');
    rejectSelect(failure);
    await rejection;
    expect(logFactory.memory.lines.join('\n')).toContain('"phase":"events.select.failed"');
  });
});

describe('PodMatrixStore phase diagnostics', () => {
  it('reports a Pod fetch failure as a safe monotonic phase, not a raw request', async () => {
    const timeout = new DOMException('token exchange timed out', 'TimeoutError');
    const podFetch = vi.fn(async () => { throw timeout; });
    const traced = await tracedFetchFor(podFetch);

    await expect(traced('https://pod.example/alice/chat/room?token=topsecret', { method: 'PUT' })).rejects.toBe(timeout);

    expect(podFetch).toHaveBeenCalledTimes(1);
    expect(logFactory.memory.lines).toHaveLength(2);
    expect(logFactory.memory.lines[0]).toContain('"phase":"podFetch.start"');
    const logged = logFactory.memory.lines[1];
    expect(logged).toContain('[matrix-phase]');
    expect(logged).toContain('"phase":"podFetch.error"');
    // The fetch inherits the one trace opened by its public operation.
    expect(logged).toContain('"op":"createRoom"');
    expect(logged).toContain('"opId":"');
    expect(logged).toContain('"errorName":"TimeoutError"');
    expect(logged).toContain('"method":"PUT"');
    expect(logged).toContain('"elapsedMs":');
    for (const forbidden of [ 'https://', 'topsecret', 'token=', '?token', 'pod.example' ]) {
      expect(logged).not.toContain(forbidden);
    }
  });

  it('reports a fast non-success Pod fetch as a safe phase but passes the response through', async () => {
    const response = { ok: false, status: 500, bodyUsed: false } as unknown as Response;
    const podFetch = vi.fn(async () => response);
    const traced = await tracedFetchFor(podFetch);

    const returned = await traced('https://pod.example/alice/chat/room?token=topsecret', { method: 'PUT' });

    expect(returned).toBe(response);
    expect(podFetch).toHaveBeenCalledTimes(1);
    expect(logFactory.memory.lines).toHaveLength(3);
    expect(logFactory.memory.lines[2]).toContain('podFetch.stream.absent');
    expect(logFactory.memory.lines[0]).toContain('"phase":"podFetch.start"');
    const logged = logFactory.memory.lines[1];
    expect(logged).toContain('"phase":"podFetch.headers"');
    expect(logged).toContain('"method":"PUT"');
    expect(logged).toContain('"status":500');
    expect(logged).toContain('"ok":false');
    for (const forbidden of [ 'https://', 'topsecret', 'token=', '?token', 'pod.example' ]) {
      expect(logged).not.toContain(forbidden);
    }
  });

  it('never echoes an opaque credential method, only a fixed enum token', async () => {
    const response = { ok: false, status: 401, bodyUsed: false } as unknown as Response;
    const podFetch = vi.fn(async () => response);
    const traced = await tracedFetchFor(podFetch);

    await traced('https://pod.example/alice/chat/room', { method: 'BEARER FAKE_METHOD_SENTINEL' });

    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"method":"unknown"');
    expect(logged).not.toContain('FAKE_METHOD_SENTINEL');
    expect(logged).not.toContain('BEARER');
  });

  it('reports a slow successful Pod fetch with its header phase duration', async () => {
    const response = new Response(null, { status: 204 });
    const podFetch = vi.fn(async () => response);
    const traced = await tracedFetchFor(podFetch);

    const times = [ 1_000, 5_500 ];
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => times.shift() ?? 5_500);
    try {
      await traced('https://pod.example/alice/chat/room');
    } finally {
      spy.mockRestore();
    }

    expect(logFactory.memory.lines).toHaveLength(3);
    expect(logFactory.memory.lines[2]).toContain('podFetch.stream.absent');
    expect(logFactory.memory.lines[0]).toContain('"phase":"podFetch.start"');
    const logged = logFactory.memory.lines[1];
    expect(logged).toContain('"phase":"podFetch.headers"');
    expect(logged).toContain('"status":204');
    expect(logged).toContain('"elapsedMs":4500');
    for (const forbidden of [ 'https://', 'pod.example', 'chat/room' ]) {
      expect(logged).not.toContain(forbidden);
    }
  });

  it('distinguishes a credentials failure and preserves the original MatrixError', async () => {
    const failure = new MatrixError(403, 'M_FORBIDDEN', 'no grant');
    const { context: cachedContext } = matrixHarness();
    const { _matrixDb: _cachedDb, ...context } = cachedContext;
    const store = new PodMatrixStore({ serverName: 'example.test', podAccess: { getPodFetch: async () => { throw failure; } } });

    await expect(store.createRoom({}, context)).rejects.toBe(failure);

    expect(failure.status).toBe(403);
    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"phase":"getDb.credentials.failed"');
    expect(logged).toContain('"errorName":"MatrixError"');
  });

  it('distinguishes a db.init failure from a credentials failure', async () => {
    const failure = new Error('init exploded');
    const { context: cachedContext } = matrixHarness();
    const { _matrixDb: _cachedDb, ...context } = cachedContext;
    vi.mocked(drizzle).mockReturnValue({ init: async () => { throw failure; } } as never);
    const store = new PodMatrixStore({ serverName: 'example.test', podAccess: { getPodFetch: async () => (async () => new Response()) as typeof fetch } });

    await expect(store.createRoom({}, context)).rejects.toBe(failure);

    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"phase":"getDb.init.failed"');
    expect(logged).not.toContain('getDb.credentials.failed');
  });

  it('correlates concurrent operations without overwriting a shared phase', async () => {
    const failure = new Error('credentials unavailable');
    const store = new PodMatrixStore({ serverName: 'example.test', podAccess: { getPodFetch: async () => { throw failure; } } });
    const freshContext = (): Record<string, unknown> => {
      const { context: cachedContext } = matrixHarness();
      const { _matrixDb: _cachedDb, ...context } = cachedContext;
      return context;
    };

    const settled = await Promise.allSettled([
      store.createRoom({}, freshContext() as never),
      store.createRoom({}, freshContext() as never),
    ]);

    expect(settled.map(result => result.status)).toEqual([ 'rejected', 'rejected' ]);
    expect(logFactory.memory.lines).toHaveLength(4);
    const lines = logFactory.memory.lines.filter(line => line.includes('"phase":"getDb.credentials.failed"'));
    expect(lines).toHaveLength(2);
    const ids = lines.map(line => /"opId":"([0-9a-f]+)"/.exec(line)?.[1]);
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBeDefined();
    expect(ids[0]).not.toBe(ids[1]);
    expect(lines.every(line => line.includes('"phase":"getDb.credentials.failed"'))).toBe(true);
  });

  it('marks an events select failure inside sync with a specific phase', async () => {
    const seed = matrixHarness();
    await seed.store.createRoom({ name: 'Seed' }, seed.context);
    const roomRows = seed.rows.get(chatResource) ?? [];
    expect(roomRows.length).toBeGreaterThan(0);
    const selectError = new Error('message select exploded');
    const fakeDb = {
      init: async () => undefined,
      select: () => {
        let table: unknown;
        const query: any = {
          from: (value: unknown) => { table = value; return query; },
          where: () => query,
          then: (ok: (value: unknown) => unknown, fail: (error: unknown) => unknown) =>
            (table === messageResource ? Promise.reject(selectError) : Promise.resolve(roomRows)).then(ok, fail),
        };
        return query;
      },
    };
    const { context: cachedContext } = matrixHarness();
    const { _matrixDb: _cachedDb, ...context } = cachedContext;
    vi.mocked(drizzle).mockReturnValue(fakeDb as never);
    const store = new PodMatrixStore({ serverName: 'example.test', podAccess: { getPodFetch: async () => (async () => new Response()) as typeof fetch } });

    await expect(store.sync(context)).rejects.toBe(selectError);

    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"phase":"events.select.failed"');
  });

  it('marks a journal registration failure with a journal phase', async () => {
    const failure = new Error('journal exploded');
    const journal = new InMemoryMatrixEventJournal();
    vi.spyOn(journal, 'registerEvent').mockRejectedValue(failure);
    const { context } = matrixHarness();
    const store = new PodMatrixStore({ serverName: 'example.test', journal });

    await expect(store.createRoom({ name: 'x' }, context)).rejects.toBe(failure);

    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"phase":"journal.register.failed"');
  });

  it('reads the current trace for a fetch cached across a second sync in the same context', async () => {
    const podFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const { context: cachedContext } = matrixHarness();
    const { _matrixDb: _cachedDb, ...context } = cachedContext;
    vi.mocked(drizzle).mockImplementation(((options: any) =>
      fetchCallingDb(options.fetch)) as never);
    const store = new PodMatrixStore({
      serverName: 'example.test',
      podAccess: { getPodFetch: async () => podFetch },
    });

    let clock = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 4_000));
    let first = '';
    let second = '';
    try {
      logFactory.memory.lines.length = 0;
      await store.sync(context as never);
      first = logFactory.memory.lines.join('\n');
      logFactory.memory.lines.length = 0;
      await store.sync(context as never);
      second = logFactory.memory.lines.join('\n');
    } finally {
      spy.mockRestore();
    }

    const firstPhases = phaseLines(first);
    const secondPhases = phaseLines(second);
    const firstFetch = firstPhases.find(line => line.phase === 'podFetch.headers');
    const firstWatermark = firstPhases.find(line => line.phase === 'sync.watermark');
    const secondFetch = secondPhases.find(line => line.phase === 'podFetch.headers');
    const secondWatermark = secondPhases.find(line => line.phase === 'sync.watermark');

    // Within one sync every phase shares a single operation trace...
    expect(firstFetch?.opId).toBe(firstWatermark?.opId);
    expect(secondFetch?.opId).toBe(secondWatermark?.opId);
    // ...and the cached fetch reports the second sync, not the first caller.
    expect(firstFetch?.opId).toBeDefined();
    expect(secondFetch?.opId).toBeDefined();
    expect(secondFetch?.opId).not.toBe(firstFetch?.opId);
  });

  it('shares one call trace between a public createRoom and its internal appendEvent', async () => {
    const podFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const { context: cachedContext } = matrixHarness();
    const { _matrixDb: _cachedDb, ...context } = cachedContext;
    vi.mocked(drizzle).mockImplementation(((options: any) =>
      fetchCallingDb(options.fetch)) as never);
    const store = new PodMatrixStore({
      serverName: 'example.test',
      podAccess: { getPodFetch: async () => podFetch },
    });

    let clock = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 4_000));
    try {
      logFactory.memory.lines.length = 0;
      await store.createRoom({ name: 'Room' }, context as never);
    } finally {
      spy.mockRestore();
    }

    const lines = phaseLines(logFactory.memory.lines.join('\n'));
    const fetch = lines.find(line => line.phase === 'podFetch.headers');
    const journal = lines.find(line => line.phase === 'journal.register');
    expect(fetch?.opId).toBeDefined();
    expect(journal?.opId).toBe(fetch?.opId);
    expect(lines.every(line => line.op === 'createRoom')).toBe(true);
  });

  it('keeps two concurrent sync calls on independent operation traces', async () => {
    const podFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.mocked(drizzle).mockImplementation(((options: any) =>
      fetchCallingDb(options.fetch)) as never);
    const store = new PodMatrixStore({
      serverName: 'example.test',
      podAccess: { getPodFetch: async () => podFetch },
    });
    const freshContext = (): Record<string, unknown> => {
      const { context: cachedContext } = matrixHarness();
      const { _matrixDb: _cachedDb, ...context } = cachedContext;
      return context;
    };

    let clock = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 4_000));
    let other = '';
    try {
      logFactory.memory.lines.length = 0;
      await store.sync(freshContext() as never);
      other = logFactory.memory.lines.join('\n');
      logFactory.memory.lines.length = 0;
      await Promise.all([
        store.sync(freshContext() as never),
        store.sync(freshContext() as never),
      ]);
    } finally {
      spy.mockRestore();
    }

    const concurrent = phaseLines(logFactory.memory.lines.join('\n'));
    const ids = new Set(concurrent.map(line => line.opId));
    expect(ids.size).toBeGreaterThanOrEqual(2);
    const otherIds = new Set(phaseLines(other).map(line => line.opId));
    for (const id of ids) expect(otherIds.has(id)).toBe(false);
    // Every phase within a concurrent sync still correlates with its own fetch.
    for (const fetch of concurrent.filter(line => line.phase === 'podFetch.headers')) {
      const watermark = concurrent.find(line => line.phase === 'sync.watermark' && line.opId === fetch.opId);
      expect(watermark).toBeDefined();
    }
  });

  it('defaults a bare URL fetch to GET while honoring Request and init methods', async () => {
    const response = { ok: false, status: 400, bodyUsed: false } as unknown as Response;
    const podFetch = vi.fn(async () => response);
    const traced = await tracedFetchFor(podFetch);

    await traced('https://pod.example/alice/chat/room');
    await traced(new Request('https://pod.example/alice/chat/room', { method: 'DELETE' }));
    await traced(new Request('https://pod.example/alice/chat/room', { method: 'GET' }), { method: 'PATCH' });

    expect(podFetch).toHaveBeenCalledTimes(3);
    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"method":"GET"');
    expect(logged).toContain('"method":"DELETE"');
    expect(logged).toContain('"method":"PATCH"');
    expect(logged).not.toContain('pod.example');
  });

  it('projects a native DOM TimeoutError numeric code without leaking its message', async () => {
    const timeout = new DOMException('native timeout https://user:pw@pod.example/x?token=secret', 'TimeoutError');
    const podFetch = vi.fn(async () => { throw timeout; });
    const traced = await tracedFetchFor(podFetch);

    await expect(traced('https://pod.example/alice/chat/room?token=topsecret', { method: 'PUT' })).rejects.toBe(timeout);

    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"errorName":"TimeoutError"');
    expect(logged).toContain('"domTimeout":true');
    expect(logged).toContain('"codeType":"number"');
    expect(logged).toContain('"code":23');
    for (const forbidden of [ 'native timeout', 'https://', 'token=', 'topsecret', 'user:pw', 'pod.example' ]) {
      expect(logged).not.toContain(forbidden);
    }
  });

  it('projects a timeout signal and allowlisted reason name, never the reason message', async () => {
    const reason = Object.assign(new Error('private reason body'), { name: 'TimeoutError' });
    const error = Object.assign(new Error('outer private body'), {
      name: 'AbortError',
      signal: { aborted: true },
      reason,
    });
    const podFetch = vi.fn(async () => { throw error; });
    const traced = await tracedFetchFor(podFetch);

    await expect(traced('https://pod.example/alice/chat/room', { method: 'PUT' })).rejects.toBe(error);

    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"errorName":"AbortError"');
    expect(logged).toContain('"signalPresent":true');
    expect(logged).toContain('"signalAborted":true');
    expect(logged).toContain('"reasonName":"TimeoutError"');
    expect(logged).not.toContain('outer private body');
    expect(logged).not.toContain('private reason body');
  });

  it('logs every Pod PUT await boundary under one public operation trace', async () => {
    const { store, context } = matrixHarness();
    stubSingleRoomLoad(store);
    vi.spyOn(store as any, 'requireJoined').mockResolvedValue(undefined);
    vi.spyOn(store as any, 'authorizeTargets').mockResolvedValue([]);

    let clock = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 4_000));
    try {
      logFactory.memory.lines.length = 0;
      await store.sendEvent('!room:example.test', 'm.room.message', 'txn-1', { body: 'hello' }, context);
    } finally {
      spy.mockRestore();
    }

    const lines = phaseLines(logFactory.memory.lines.join('\n'));
    // Target loads the room and its timeline once and reuses both, so the
    // append takes the caller's roomContext and never re-reads it.
    const expected = [
      'sendEvent.roomSource',
      'sendEvent.listEvents',
      'sendEvent.requireJoined',
      'sendEvent.authorizeTargets',
      'sendEvent.journal.reserveTransaction',
      'sendEvent.db.findById',
      'appendEvent.db.insert',
      'journal.register',
      'reconcileEvent',
    ];
    for (const phase of expected) {
      const line = lines.find(entry => entry.phase === phase);
      expect(line, phase).toBeDefined();
      expect(line?.op).toBe('sendEvent');
    }
    expect(lines.some(entry => entry.phase === 'appendEvent.getRoomContext')).toBe(false);
    const ids = new Set(lines.filter(entry => expected.includes(entry.phase)).map(entry => entry.opId));
    expect(ids.size).toBe(1);
  });

  it('marks a requireJoined failure with its PUT phase', async () => {
    const { store, context } = matrixHarness();
    stubSingleRoomLoad(store);
    const failure = new Error('requireJoined exploded');
    vi.spyOn(store as any, 'requireJoined').mockRejectedValue(failure);

    await expect(store.sendEvent('!room:example.test', 'm.room.message', 't', { body: 'hi' }, context)).rejects.toBe(failure);

    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"phase":"sendEvent.requireJoined.failed"');
    expect(logged).toContain('"op":"sendEvent"');
  });

  it('marks an authorizeTargets failure with its PUT phase', async () => {
    const { store, context } = matrixHarness();
    stubSingleRoomLoad(store);
    const failure = new Error('authorizeTargets exploded');
    vi.spyOn(store as any, 'requireJoined').mockResolvedValue(undefined);
    vi.spyOn(store as any, 'authorizeTargets').mockRejectedValue(failure);

    await expect(store.sendEvent('!room:example.test', 'm.room.message', 't', { body: 'hi' }, context)).rejects.toBe(failure);

    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"phase":"sendEvent.authorizeTargets.failed"');
  });

  it('marks a reserveTransaction failure with its PUT phase', async () => {
    const { context } = matrixHarness();
    const failure = new Error('reserve exploded');
    const journal = new InMemoryMatrixEventJournal();
    vi.spyOn(journal, 'reserveTransaction').mockRejectedValue(failure);
    const store = new PodMatrixStore({ serverName: 'example.test', journal });
    stubSingleRoomLoad(store);
    vi.spyOn(store as any, 'requireJoined').mockResolvedValue(undefined);
    vi.spyOn(store as any, 'authorizeTargets').mockResolvedValue([]);

    await expect(store.sendEvent('!room:example.test', 'm.room.message', 't', { body: 'hi' }, context)).rejects.toBe(failure);

    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"phase":"sendEvent.journal.reserveTransaction.failed"');
  });

  it('marks a receipt findById failure with its PUT phase', async () => {
    const { store, context, db } = matrixHarness();
    stubSingleRoomLoad(store);
    const failure = new Error('receipt lookup exploded');
    vi.spyOn(store as any, 'requireJoined').mockResolvedValue(undefined);
    vi.spyOn(store as any, 'authorizeTargets').mockResolvedValue([]);
    const originalFind = db.findById.bind(db);
    db.findById = async (table: unknown, id: string) => {
      if (table === messageResource) throw failure;
      return originalFind(table, id);
    };

    await expect(store.sendEvent('!room:example.test', 'm.room.message', 't', { body: 'hi' }, context)).rejects.toBe(failure);

    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"phase":"sendEvent.db.findById.failed"');
  });

  it('marks an appendEvent getRoomContext failure when the caller does not reuse roomContext', async () => {
    const { store, context } = matrixHarness();
    const failure = new Error('getRoomContext exploded');
    vi.spyOn(store as any, 'requireJoined').mockResolvedValue(undefined);
    vi.spyOn(store as any, 'requireRoomOwner').mockResolvedValue(undefined);
    vi.spyOn(store as any, 'getRoomContext').mockRejectedValue(failure);

    // sendEvent reuses the room it already loaded; setState appends state
    // without a roomContext, so appendEvent must read it and fail here.
    await expect(store.setState('!room:example.test', 'm.room.topic', '', { topic: 'x' }, context)).rejects.toBe(failure);

    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"phase":"appendEvent.getRoomContext.failed"');
    expect(logged).toContain('"op":"setState"');
  });

  it('marks an appendEvent db.insert failure with its PUT phase', async () => {
    const { store, context, db } = matrixHarness();
    stubSingleRoomLoad(store);
    const failure = new Error('db insert exploded');
    vi.spyOn(store as any, 'requireJoined').mockResolvedValue(undefined);
    vi.spyOn(store as any, 'authorizeTargets').mockResolvedValue([]);
    vi.spyOn(store as any, 'getRoomContext').mockResolvedValue({ metadata: undefined, participants: [] });
    const originalInsert = db.insert.bind(db);
    db.insert = (table: unknown) => {
      if (table === messageResource) throw failure;
      return originalInsert(table);
    };

    await expect(store.sendEvent('!room:example.test', 'm.room.message', 't', { body: 'hi' }, context)).rejects.toBe(failure);

    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"phase":"appendEvent.db.insert.failed"');
  });

  it('marks a reconcileEvent failure with its PUT phase', async () => {
    const { store, context } = matrixHarness();
    stubSingleRoomLoad(store);
    const failure = new Error('reconcile exploded');
    vi.spyOn(store as any, 'requireJoined').mockResolvedValue(undefined);
    vi.spyOn(store as any, 'authorizeTargets').mockResolvedValue([]);
    vi.spyOn(store as any, 'getRoomContext').mockResolvedValue({ metadata: undefined, participants: [] });
    vi.spyOn(store as any, 'reconcileEvent').mockRejectedValue(failure);

    await expect(store.sendEvent('!room:example.test', 'm.room.message', 't', { body: 'hi' }, context)).rejects.toBe(failure);

    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"phase":"reconcileEvent.failed"');
  });

  it('marks an existing-receipt replay journal failure with the same PUT phase and identity', async () => {
    const { store, context } = matrixHarness();
    stubSingleRoomLoad(store);
    vi.spyOn(store as any, 'requireJoined').mockResolvedValue(undefined);
    vi.spyOn(store as any, 'authorizeTargets').mockResolvedValue([]);
    // First send appends the event and stores its message + receipt.
    await store.sendEvent('!room:example.test', 'm.room.message', 'replay-txn', { body: 'hello' }, context);

    // Replaying the same transaction reaches the existing-receipt branch; make
    // the journal registration there fail with a native identity-bearing error.
    const failure = new DOMException('journal replay timed out', 'TimeoutError');
    vi.spyOn((store as any).journal, 'registerEvent').mockRejectedValue(failure);

    logFactory.memory.lines.length = 0;
    await expect(store.sendEvent('!room:example.test', 'm.room.message', 'replay-txn', { body: 'hello' }, context)).rejects.toBe(failure);

    expect(failure.code).toBe(23);
    const lines = phaseLines(logFactory.memory.lines.join('\n'));
    const replay = lines.find(entry => entry.phase === 'journal.register.failed');
    expect(replay, 'replay journal failure phase').toBeDefined();
    expect(replay?.op).toBe('sendEvent');
    const logged = logFactory.memory.lines.join('\n');
    expect(logged).toContain('"errorName":"TimeoutError"');
    expect(logged).toContain('"domTimeout":true');
    expect(logged).toContain('"codeType":"number"');
    expect(logged).toContain('"code":23');
    for (const forbidden of [ 'journal replay timed out', 'https://', 'pod.example' ]) {
      expect(logged).not.toContain(forbidden);
    }
  });
});
