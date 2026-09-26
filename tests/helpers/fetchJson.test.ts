import { describe, expect, it } from 'vitest';
import { fetchJsonWithRetry } from './fetchJson';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('fetchJsonWithRetry', () => {
  it('retries a transport failure instead of calling it a verdict', async() => {
    // The regression this guards: a node started a moment ago can refuse or reset a connection,
    // and a live fixture flow that treats that as an answer fails for a timing reason.
    const calls: number[] = [];
    const waits: number[] = [];
    const result = await fetchJsonWithRetry<{ managed: boolean }>('http://127.0.0.1:1/provision/status', {
      attempts: 4,
      delayMs: 100,
      fetchImpl: async() => {
        calls.push(calls.length + 1);
        if (calls.length < 3) {
          throw new Error('connect ECONNREFUSED 127.0.0.1:1');
        }
        return jsonResponse({ managed: true });
      },
      sleep: async(ms) => { waits.push(ms); },
    });
    expect(result).toEqual({ value: { managed: true }, attempts: 3 });
    expect(calls).toHaveLength(3);
    expect(waits).toHaveLength(2);
    for (const wait of waits) {
      expect(wait).toBeGreaterThanOrEqual(100);
      expect(wait).toBeLessThan(200);
    }
  });

  it('does not retry an answer, and names the status', async() => {
    let calls = 0;
    await expect(fetchJsonWithRetry('http://127.0.0.1:1/provision/status', {
      attempts: 4,
      delayMs: 1,
      fetchImpl: async() => {
        calls += 1;
        return jsonResponse({ error: 'boom' }, 500);
      },
      sleep: async() => undefined,
    })).rejects.toThrow(/answered 500/u);
    expect(calls).toBe(1);
  });

  it('surfaces how many tries were spent when the endpoint never answers', async() => {
    let calls = 0;
    await expect(fetchJsonWithRetry('http://127.0.0.1:1/provision/status', {
      attempts: 3,
      delayMs: 1,
      fetchImpl: async() => {
        calls += 1;
        throw new Error('socket hang up');
      },
      sleep: async() => undefined,
    })).rejects.toThrow(/did not answer after 3 attempt\(s\): socket hang up/u);
    expect(calls).toBe(3);
  });
});
