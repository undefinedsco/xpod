import { describe, expect, it } from 'vitest';
import { RequestTracker } from '../../scripts/accept-matrix-collaboration';

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
