import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RequestTracker, appendPrivateFileSync, classifyBodyReadFailure, createPrivateDirSync,
  outputPath, readJsonBody, writePrivateFileSync,
} from '../../scripts/accept-matrix-collaboration';

// Regression guard for the ROOT review: the old diagnostics used Date.now() and only appended a
// request after fetch() resolved, so a pending request, its start, and the response body read were
// invisible. These tests pin the monotonic, phase-separated, sanitized contract.
describe('Matrix acceptance request diagnostics', () => {
  it('keeps an in-flight request with method/path/start/elapsed before headers arrive', () => {
    let clock = 1_000;
    const tracker = new RequestTracker(() => clock);
    tracker.beginStep('backlog-63');
    const id = tracker.start('PUT', '/_matrix/client/v3/rooms/!abc/send/m.room.message/backlog-x');
    clock = 1_500;

    const snapshot = tracker.snapshot('running');
    expect(snapshot.requests[0]).toMatchObject({
      id, method: 'PUT', path: '/_matrix/client/v3/rooms/!abc/send/m.room.message/backlog-x',
      state: 'inflight', startMs: 1_000, elapsedMs: 500,
    });
    expect(snapshot.inflight).toHaveLength(1);
    expect(snapshot.inflight[0]).toMatchObject({ method: 'PUT', startMs: 1_000, elapsedMs: 500 });
  });

  it('never records the query string, body, token or raw response', () => {
    let clock = 0;
    const tracker = new RequestTracker(() => clock);
    // Stripping happens at the single recording entry, not at the caller.
    tracker.start('GET', '/_matrix/client/v3/rooms/!abc/sync?limit=7&since=abc');
    const record = tracker.snapshot('running').requests[0] as unknown as Record<string, unknown>;
    expect(record.path).toBe('/_matrix/client/v3/rooms/!abc/sync');
    expect(record.path).not.toContain('?');
    for (const forbidden of ['body', 'token', 'authorization', 'response', 'query']) {
      expect(record).not.toHaveProperty(forbidden);
    }
  });

  it('records body-phase duration when a started body read errors', () => {
    let clock = 0;
    const tracker = new RequestTracker(() => clock);
    const id = tracker.start('GET', '/stream');
    clock = 40; tracker.headersReceived(id, 200);
    clock = 50; tracker.bodyStarted(id);
    clock = 75; tracker.finished(id, 'error', 'SyntaxError');

    const [record] = tracker.snapshot('body-error').requests;
    expect(record).toMatchObject({ state: 'error', bodyStartMs: 50, bodyEndMs: 75, bodyMs: 25, elapsedMs: 75 });
  });

  it('times header receipt and body read separately on the monotonic clock', () => {
    let clock = 0;
    const tracker = new RequestTracker(() => clock);
    const id = tracker.start('GET', '/_matrix/client/v3/sync');
    clock = 120; tracker.headersReceived(id, 200);
    clock = 130; tracker.bodyStarted(id);
    clock = 260; tracker.bodyFinished(id);

    const [record] = tracker.snapshot('passed').requests;
    expect(record).toMatchObject({ state: 'done', status: 200, headersMs: 120, bodyMs: 130, elapsedMs: 260 });
    expect(tracker.snapshot('passed').inflight).toEqual([]);
  });

  it('retains errored and cancelled requests that never completed', () => {
    let clock = 0;
    const tracker = new RequestTracker(() => clock);
    const errored = tracker.start('PUT', '/x');
    clock = 10; tracker.finished(errored, 'error', 'TimeoutError');
    const cancelled = tracker.start('PUT', '/y');
    clock = 25; tracker.finished(cancelled, 'cancelled', 'AbortError');

    const snapshot = tracker.snapshot('request-error');
    expect(snapshot.requests.map((record) => record.state)).toEqual(['error', 'cancelled']);
    expect(snapshot.requests[0].elapsedMs).toBe(10);
    expect(snapshot.requests[1].elapsedMs).toBe(15);
    expect(snapshot.inflight).toEqual([]);
  });

  it('uses the injected monotonic clock rather than wall time for elapsed evidence', () => {
    let clock = 5;
    const tracker = new RequestTracker(() => clock);
    const id = tracker.start('GET', '/slow');
    clock = 5 + 900_000; // far ahead of wall time
    tracker.headersReceived(id, 200);
    expect(tracker.snapshot('running').requests[0].headersMs).toBe(900_000);
  });
});

// Regression guard for the ROOT review: the old catch recorded a hard-coded SyntaxError/error for every
// body-read rejection, so a native timeout after successful headers, an abort, a stream failure and
// genuinely malformed JSON were indistinguishable. These pin the actual-name, cancelled-vs-error split.
describe('Matrix acceptance body-read failure classification', () => {
  it('classifies a native body timeout after successful headers as cancelled TimeoutError', () => {
    const timeout = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    expect(classifyBodyReadFailure(timeout)).toEqual({ state: 'cancelled', name: 'TimeoutError' });
  });

  it('classifies a body abort as cancelled AbortError', () => {
    const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    expect(classifyBodyReadFailure(abort)).toEqual({ state: 'cancelled', name: 'AbortError' });
  });

  it('keeps genuinely malformed JSON as an error carrying its actual SyntaxError name', () => {
    // Bun throws SyntaxError("Failed to parse JSON") for a non-JSON 2xx body.
    expect(classifyBodyReadFailure(new SyntaxError('Failed to parse JSON')))
      .toEqual({ state: 'error', name: 'SyntaxError' });
  });

  it('keeps a mid-stream read failure as an error with its own name, not a fabricated SyntaxError', () => {
    expect(classifyBodyReadFailure(Object.assign(new Error('stream interrupted'), { name: 'Error' })))
      .toEqual({ state: 'error', name: 'Error' });
  });

  it('falls back to a safe generic name for an unrecognized rejection shape', () => {
    expect(classifyBodyReadFailure({ weird: true })).toEqual({ state: 'error', name: 'Error' });
    expect(classifyBodyReadFailure(Object.assign(new Error(''), { name: 'not allowlisted!' })))
      .toEqual({ state: 'error', name: 'Error' });
  });

  it('records the first body-phase failure timing distinctly per outcome', () => {
    let clock = 0;
    const tracker = new RequestTracker(() => clock);
    const timeoutId = tracker.start('GET', '/timeout');
    clock = 10; tracker.headersReceived(timeoutId, 200);
    clock = 20; tracker.bodyStarted(timeoutId);
    clock = 90; tracker.finished(timeoutId, 'cancelled', 'TimeoutError');
    const malformedId = tracker.start('GET', '/malformed');
    clock = 100; tracker.headersReceived(malformedId, 200);
    clock = 110; tracker.bodyStarted(malformedId);
    clock = 130; tracker.finished(malformedId, 'error', 'SyntaxError');

    const [timeoutRecord, malformedRecord] = tracker.snapshot('body-error').requests;
    expect(timeoutRecord).toMatchObject({ state: 'cancelled', error: 'TimeoutError', bodyStartMs: 20, bodyEndMs: 90, bodyMs: 70 });
    expect(malformedRecord).toMatchObject({ state: 'error', error: 'SyntaxError', bodyStartMs: 110, bodyEndMs: 130, bodyMs: 20 });
  });
});

// Integration regression for the ROOT review: these drive the real `readJsonBody` seam used by the
// acceptance `api`, with actual Response objects, so reverting the classification to a hard-coded
// SyntaxError/error makes them fail. The rejection identity and body-phase timing are asserted on the
// tracker record, not a re-implemented copy of the logic.
describe('Matrix acceptance readJsonBody integration', () => {
  const failingResponse = (error: unknown): Response =>
    ({ json: async () => { throw error; } }) as unknown as Response;
  const succeedingResponse = (value: unknown, clock: { at: number }, points: number[]): Response =>
    ({ json: async () => { clock.at = points.shift()!; return value; } }) as unknown as Response;

  it('records a native body timeout after successful headers as cancelled TimeoutError with body timing', async () => {
    let clock = 0;
    const tracker = new RequestTracker(() => clock);
    const id = tracker.start('GET', '/slow');
    clock = 10; tracker.headersReceived(id, 200);
    const error = Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });
    await expect(readJsonBody(tracker, id, failingResponse(error), 'GET /slow')).rejects.toThrow('non-JSON');

    const [record] = tracker.snapshot('body-error').requests;
    expect(record).toMatchObject({ state: 'cancelled', error: 'TimeoutError' });
    expect(record.bodyStartMs).toBe(10);
    expect(record.bodyEndMs).toBeGreaterThanOrEqual(10);
  });

  it('records a body abort as cancelled AbortError', async () => {
    const tracker = new RequestTracker(() => 0);
    const id = tracker.start('GET', '/abort');
    const error = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(readJsonBody(tracker, id, failingResponse(error), 'GET /abort')).rejects.toThrow('non-JSON');
    expect(tracker.snapshot('body-error').requests[0]).toMatchObject({ state: 'cancelled', error: 'AbortError' });
  });

  it('keeps genuinely malformed JSON as an error with its actual SyntaxError name', async () => {
    const tracker = new RequestTracker(() => 0);
    const id = tracker.start('GET', '/malformed');
    await expect(readJsonBody(tracker, id, failingResponse(new SyntaxError('Failed to parse JSON')), 'GET /malformed'))
      .rejects.toThrow('non-JSON');
    expect(tracker.snapshot('body-error').requests[0]).toMatchObject({ state: 'error', error: 'SyntaxError' });
  });

  it('keeps a mid-stream read failure as an error with its own name, not a fabricated SyntaxError', async () => {
    const tracker = new RequestTracker(() => 0);
    const id = tracker.start('GET', '/stream');
    const error = Object.assign(new Error('stream interrupted'), { name: 'Error' });
    await expect(readJsonBody(tracker, id, failingResponse(error), 'GET /stream')).rejects.toThrow('non-JSON');
    expect(tracker.snapshot('body-error').requests[0]).toMatchObject({ state: 'error', error: 'Error' });
  });

  it('completes the body phase and returns parsed JSON on success without recording a failure', async () => {
    const clock = { at: 0 };
    const tracker = new RequestTracker(() => clock.at);
    const id = tracker.start('GET', '/ok');
    clock.at = 10; tracker.headersReceived(id, 200);
    const parsed = await readJsonBody(tracker, id, succeedingResponse({ ok: true }, clock, [30]), 'GET /ok');
    expect(parsed).toEqual({ ok: true });
    expect(tracker.snapshot('passed').requests[0]).toMatchObject({ state: 'done', status: 200, bodyStartMs: 10, bodyEndMs: 30, bodyMs: 20 });
  });
});

// Regression for the ROOT review: the script's own diagnostics/report writers and its standalone
// output directory used umask defaults, so a world-readable deployment under umask022 left the
// evidence at 0644/0755. These drive the actual producer functions the script uses (not a copy) and
// assert the real on-disk modes.
describe('Matrix acceptance script private evidence modes', () => {
  const artifacts: string[] = [];
  const withUmaskAsync = async <T>(mask: number, run: () => Promise<T>): Promise<T> => {
    const previous = process.umask(mask);
    try { return await run(); } finally { process.umask(previous); }
  };
  const withUmask = <T>(mask: number, run: () => T): T => {
    const previous = process.umask(mask);
    try { return run(); } finally { process.umask(previous); }
  };
  // The standalone script only accepts outputs under .test-data/, so the fixture must live there too.
  const freshOutput = (): string => {
    const dir = path.join('.test-data', `matrix-accept-private-${randomUUID()}`);
    artifacts.push(dir);
    return path.join(dir, 'result.json');
  };
  afterEach(() => {
    while (artifacts.length) rmSync(artifacts.pop()!, { recursive: true, force: true });
  });

  it('creates private output directories on a fresh checkout without .test-data', async () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'matrix-fresh-output-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(fixture);
    try {
      const output = await withUmaskAsync(0o022, () => outputPath('.test-data/owned/nested/result.json'));
      writePrivateFileSync(output, '{}\n');
      for (const directory of ['.test-data', '.test-data/owned', '.test-data/owned/nested']) {
        expect(statSync(path.join(fixture, directory)).mode & 0o777).toBe(0o700);
      }
      expect(statSync(output).mode & 0o777).toBe(0o600);
    } finally {
      cwd.mockRestore();
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('rejects an escaping symlink without changing foreign directory permissions or contents', async () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'matrix-output-'));
    const link = path.dirname(freshOutput());
    try {
      chmodSync(fixture, 0o755);
      writeFileSync(path.join(fixture, 'sentinel'), 'unchanged');
      symlinkSync(fixture, link);
      await expect(outputPath(path.join(link, 'result.json'))).rejects.toThrow('symlink');
      await expect(outputPath(path.join(link, 'missing', 'result.json'))).rejects.toThrow('symlink');
      expect(statSync(fixture).mode & 0o777).toBe(0o755);
      expect(readFileSync(path.join(fixture, 'sentinel'), 'utf8')).toBe('unchanged');
      expect(() => statSync(path.join(fixture, 'missing'))).toThrow();
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('preserves shared and existing unrelated parent modes through the actual writer', async () => {
    const root = path.resolve('.test-data');
    const previousMode = statSync(root).mode & 0o777;
    const nested = path.dirname(freshOutput());
    const direct = path.join(root, `matrix-output-${randomUUID()}.json`);
    artifacts.push(direct);
    try {
      chmodSync(root, 0o755);
      mkdirSync(nested, { mode: 0o755 });
      chmodSync(nested, 0o755);
      const parentModes: number[] = [];
      for (const output of [direct, path.join(nested, 'result.json')]) {
        const resolved = await outputPath(output);
        writePrivateFileSync(resolved, '{}\n');
        expect(statSync(resolved).mode & 0o777).toBe(0o600);
        parentModes.push(statSync(path.dirname(resolved)).mode & 0o777);
      }
      expect(parentModes).toEqual([0o755, 0o755]);
    } finally {
      chmodSync(root, previousMode);
    }
  });

  it('creates the standalone --output directory 0700 under umask022', async () => {
    const output = freshOutput();
    const resolved = await withUmaskAsync(0o022, () => outputPath(output));
    expect(resolved).toBe(path.resolve(output));
    expect(statSync(path.dirname(resolved)).mode & 0o777).toBe(0o700);
  });

  it('writes the actual report and diagnostics JSON 0600 from creation under umask022', () => {
    const output = freshOutput();
    withUmask(0o022, () => {
      createPrivateDirSync(path.dirname(output));
      writePrivateFileSync(output, '{"status":"passed"}\n');
      writePrivateFileSync(`${output}.diagnostics.json`, '{"status":"passed"}\n');
    });
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(statSync(`${output}.diagnostics.json`).mode & 0o777).toBe(0o600);
  });

  it('creates the actual diagnostic log 0600 on first append under umask022', () => {
    const output = freshOutput();
    const log = `${output}.accept-diag.log`;
    withUmask(0o022, () => {
      createPrivateDirSync(path.dirname(output));
      appendPrivateFileSync(log, 'step identity\n');
      appendPrivateFileSync(log, 'step sync\n');
    });
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });
});
