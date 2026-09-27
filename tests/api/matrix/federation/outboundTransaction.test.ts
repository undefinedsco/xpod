import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_EDUS_PER_TRANSACTION,
  MAX_PDUS_PER_TRANSACTION,
  MatrixFederationClient,
  readRetryAfter,
} from '../../../../src/api/matrix/federation/outboundTransaction';
import { authenticateXMatrixRequest } from '../../../../src/api/matrix/federation/requestAuth';
import { parseServerKeyResponse, type MatrixServerKeySource } from '../../../../src/api/matrix/federation/serverKeys';
import { MatrixServiceIdentity } from '../../../../src/api/matrix/protocol/serviceIdentity';
import type { MatrixResolvedServer } from '../../../../src/api/matrix/federation/serverNameResolution';

const US = 'pod.example';
const THEM = 'remote.example';
const TXN = 'txn-1';
const NOW = 1_700_000_000_000;

function ourIdentity() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return new MatrixServiceIdentity({
    serverName: US,
    activeKey: { keyId: 'ed25519:1', privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
    now: () => NOW,
  });
}

/** The peer's view of our keys, so an outbound request can be verified end to end. */
function peerKeySource(us: MatrixServiceIdentity): MatrixServerKeySource {
  const keys = parseServerKeyResponse(us.serverKeyResponse(), { expectedServerName: US, now: NOW });
  return { keysFor: async name => (name === US ? keys : undefined) };
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function client(options: {
  respond?: (captured: Captured) => Response | Promise<Response>;
  /** `null` means the resolver finds nothing; omitted means a plain implicit-port target. */
  resolved?: MatrixResolvedServer | null;
  identity?: MatrixServiceIdentity;
  random?: () => number;
  now?: () => number;
} = {}) {
  const identity = options.identity ?? ourIdentity();
  const captured: Captured[] = [];
  const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const entry: Captured = {
      url: String(url),
      method: String(init?.method),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([ k, v ]) => [ k.toLowerCase(), v ])),
      body: JSON.parse(String(init?.body ?? '{}')),
    };
    captured.push(entry);
    return await (options.respond?.(entry) ?? new Response(JSON.stringify({ pdus: { $e: {} } }), { status: 200 }));
  });
  const instance = new MatrixFederationClient({
    identity,
    resolve: async serverName => (options.resolved === undefined
      ? { baseUrl: `https://${serverName}:8448`, hostHeader: serverName, via: 'implicit-port' }
      : options.resolved ?? undefined),
    fetch: fetch as unknown as typeof fetch,
    now: options.now ?? (() => NOW),
    ...(options.random ? { random: options.random } : {}),
  });
  return { client: instance, captured, fetch, identity };
}

const pdu = { type: 'm.room.message', room_id: '!r:pod.example', sender: '@u:pod.example', content: { body: 'hi' } };

describe('sending a federation transaction', () => {
  it('sends a signed PUT whose request the receiving server authenticates', async () => {
    const { client: instance, captured, identity } = client({ identity: ourIdentity() });
    const outcome = await instance.sendTransaction({ destination: THEM, txnId: TXN, pdus: [ pdu ] });

    expect(outcome).toMatchObject({ status: 'delivered', origin: US, destination: THEM, txnId: TXN });
    const [ sent ] = captured;
    expect(sent.method).toBe('PUT');
    expect(sent.url).toBe(`https://${THEM}:8448/_matrix/federation/v1/send/${TXN}`);
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.body).toEqual({ origin: US, origin_server_ts: NOW, pdus: [ pdu ] });
    // No EDUs means no `edus` field at all.
    expect('edus' in sent.body).toBe(false);

    // The receiver reconstructs its own signed object and accepts ours.
    await expect(authenticateXMatrixRequest({
      authorization: sent.headers.authorization,
      method: 'PUT',
      uri: `/_matrix/federation/v1/send/${TXN}`,
      content: sent.body,
      keys: peerKeySource(identity),
      serverName: THEM,
    })).resolves.toMatchObject({ valid: true, origin: US });
  });

  it('signs the endpoint too, encoding a transaction id that is not URL-safe', async () => {
    const { client: instance, captured, identity } = client();
    const txnId = 'a b/c';
    await instance.sendTransaction({ destination: THEM, txnId, pdus: [] });

    const [ sent ] = captured;
    const uri = '/_matrix/federation/v1/send/a%20b%2Fc';
    expect(sent.url.endsWith(uri)).toBe(true);
    await expect(authenticateXMatrixRequest({
      authorization: sent.headers.authorization, method: 'PUT', uri, content: sent.body,
      keys: peerKeySource(identity), serverName: THEM,
    })).resolves.toMatchObject({ valid: true });
  });

  it('sends EDUs when there are any, and requires a transaction id', async () => {
    const { client: instance, captured } = client();
    await instance.sendTransaction({ destination: THEM, txnId: TXN, pdus: [], edus: [ { edu_type: 'm.typing' } ] });
    expect(captured[0].body.edus).toEqual([ { edu_type: 'm.typing' } ]);
    await expect(instance.sendTransaction({ destination: THEM, txnId: '  ', pdus: [] })).resolves.toMatchObject({ status: 'rejected' });
    expect(captured).toHaveLength(1);
  });

  it('reports per-PDU results, including the ones the peer refused', async () => {
    const { client: instance } = client({
      respond: () => new Response(JSON.stringify({ pdus: { $ok: {}, $bad: { error: 'not allowed' } } }), { status: 200 }),
    });
    const outcome = await instance.sendTransaction({ destination: THEM, txnId: TXN, pdus: [ pdu ] });
    expect(outcome.status).toBe('delivered');
    expect(outcome.pdus).toEqual({ $ok: {}, $bad: { error: 'not allowed' } });
  });

  it('treats a 200 it cannot read as worth retrying, not as delivered', async () => {
    for (const body of [ 'not json', '{}', JSON.stringify({ pdus: [] }) ]) {
      const { client: instance } = client({ respond: () => new Response(body, { status: 200 }) });
      await expect(instance.sendTransaction({ destination: THEM, txnId: TXN, pdus: [] })).resolves.toMatchObject({ status: 'retry' });
    }
  });

  it('retries rate limiting and server errors, taking the peer\'s hint when given', async () => {
    const limited = client({ respond: () => new Response(JSON.stringify({ errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 2500 }), { status: 429 }) });
    await expect(limited.client.sendTransaction({ destination: THEM, txnId: TXN, pdus: [] })).resolves.toMatchObject({ status: 'retry', retryAfterMs: 2500 });

    const header = client({ respond: () => new Response('', { status: 502, headers: { 'retry-after': '3' } }) });
    await expect(header.client.sendTransaction({ destination: THEM, txnId: TXN, pdus: [] })).resolves.toMatchObject({ status: 'retry', retryAfterMs: 3000, reason: expect.stringContaining('502') });

    const noHint = client({ respond: () => new Response('', { status: 503 }) });
    const outcome = await noHint.client.sendTransaction({ destination: THEM, txnId: TXN, pdus: [] });
    expect(outcome).toMatchObject({ status: 'retry' });
    expect(outcome.retryAfterMs).toBeUndefined();
  });

  it('treats a refusal as final and an unreachable peer as worth retrying', async () => {
    for (const status of [ 400, 401, 403, 404 ]) {
      const { client: instance } = client({ respond: () => new Response('', { status }) });
      await expect(instance.sendTransaction({ destination: THEM, txnId: TXN, pdus: [] })).resolves.toMatchObject({ status: 'rejected' });
    }
    const offline = client({ respond: () => { throw new Error('connect ECONNREFUSED'); } });
    await expect(offline.client.sendTransaction({ destination: THEM, txnId: TXN, pdus: [] })).resolves.toMatchObject({
      status: 'retry', reason: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('refuses to send to a destination it cannot resolve', async () => {
    const { client: instance, fetch } = client({ resolved: null });
    await expect(instance.sendTransaction({ destination: 'not a server name', txnId: TXN, pdus: [] })).resolves.toMatchObject({ status: 'rejected' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('enforces the transaction size limits the specification sets', async () => {
    const { client: instance, fetch } = client();
    await expect(instance.sendTransaction({
      destination: THEM, txnId: TXN, pdus: Array.from({ length: MAX_PDUS_PER_TRANSACTION + 1 }, () => pdu),
    })).rejects.toThrow(/50 PDUs/u);
    await expect(instance.sendTransaction({
      destination: THEM, txnId: TXN, pdus: [], edus: Array.from({ length: MAX_EDUS_PER_TRANSACTION + 1 }, () => ({})),
    })).rejects.toThrow(/100 EDUs/u);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('delivering a transaction', () => {
  const retryPolicy = { initialBackoffMs: 100, maxBackoffMs: 10_000, jitter: 0 };

  it('keeps one transaction id across attempts and stops when the peer delivers', async () => {
    let attempt = 0;
    const { client: instance, captured } = client({
      respond: () => {
        attempt += 1;
        return attempt < 3 ? new Response('', { status: 503 }) : new Response(JSON.stringify({ pdus: { $e: {} } }), { status: 200 });
      },
    });
    const slept: number[] = [];
    const result = await instance.deliverTransaction({
      destination: THEM, txnId: TXN, pdus: [ pdu ], policy: retryPolicy,
      sleep: async ms => { slept.push(ms); },
    });

    expect(result.outcome.status).toBe('delivered');
    expect(result.attempts).toBe(3);
    expect(slept).toEqual([ 100, 200 ]);
    expect(result.waitedMs).toBe(300);
    // The specification requires the same txnId until the peer answers 200: a new id
    // would make the peer process the same PDUs again.
    expect(captured.map(entry => entry.url)).toEqual([
      `https://${THEM}:8448/_matrix/federation/v1/send/${TXN}`,
      `https://${THEM}:8448/_matrix/federation/v1/send/${TXN}`,
      `https://${THEM}:8448/_matrix/federation/v1/send/${TXN}`,
    ]);
  });

  it('gives up after the attempt budget, reporting the last outcome', async () => {
    const { client: instance, fetch } = client({ respond: () => new Response('', { status: 500 }) });
    const result = await instance.deliverTransaction({
      destination: THEM, txnId: TXN, pdus: [], policy: { ...retryPolicy, maxAttempts: 3 }, sleep: async () => undefined,
    });
    expect(result.attempts).toBe(3);
    expect(result.outcome.status).toBe('retry');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not wait at all when the peer refuses the transaction', async () => {
    const { client: instance, fetch } = client({ respond: () => new Response('', { status: 403 }) });
    const sleep = vi.fn(async () => undefined);
    const result = await instance.deliverTransaction({ destination: THEM, txnId: TXN, pdus: [], policy: retryPolicy, sleep });
    expect(result.outcome.status).toBe('rejected');
    expect(result.attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('waits what the peer asked for, never beyond the backoff ceiling', async () => {
    const capped = client({ respond: () => new Response(JSON.stringify({ retry_after_ms: 999_999 }), { status: 429 }) });
    const slept: number[] = [];
    await capped.client.deliverTransaction({
      destination: THEM, txnId: TXN, pdus: [], policy: { ...retryPolicy, maxAttempts: 2 }, sleep: async ms => { slept.push(ms); },
    });
    expect(slept).toEqual([ retryPolicy.maxBackoffMs ]);

    const hint = client({ respond: () => new Response(JSON.stringify({ retry_after_ms: 750 }), { status: 429 }) });
    const waited: number[] = [];
    await hint.client.deliverTransaction({
      destination: THEM, txnId: TXN, pdus: [], policy: { ...retryPolicy, maxAttempts: 2 }, sleep: async ms => { waited.push(ms); },
    });
    expect(waited).toEqual([ 750 ]);
  });

  it('jitters the backoff around the base delay', async () => {
    const early = client({ respond: () => new Response('', { status: 500 }), random: () => 0 });
    const late = client({ respond: () => new Response('', { status: 500 }), random: () => 1 });
    const delays = async (harness: ReturnType<typeof client>) => {
      const slept: number[] = [];
      await harness.client.deliverTransaction({
        destination: THEM, txnId: TXN, pdus: [],
        policy: { initialBackoffMs: 1_000, maxBackoffMs: 10_000, jitter: 0.5, maxAttempts: 3 },
        sleep: async ms => { slept.push(ms); },
      });
      return slept;
    };
    expect(await delays(early)).toEqual([ 500, 1_000 ]);
    expect(await delays(late)).toEqual([ 1_500, 3_000 ]);
  });

  it('rejects a nonsensical attempt budget', async () => {
    const { client: instance } = client();
    await expect(instance.deliverTransaction({ destination: THEM, txnId: TXN, pdus: [], policy: { maxAttempts: 0 } }))
      .rejects.toThrow(/positive integer/u);
  });
});

describe('retry hints', () => {
  it('prefers the body field, then seconds, then an HTTP date', () => {
    expect(readRetryAfter(JSON.stringify({ retry_after_ms: 1500 }), '30', NOW)).toBe(1500);
    expect(readRetryAfter('', '30', NOW)).toBe(30_000);
    expect(readRetryAfter('', new Date(NOW + 5_000).toUTCString(), NOW)).toBe(5_000);
    // A date in the past means "now", not a negative wait.
    expect(readRetryAfter('', new Date(NOW - 5_000).toUTCString(), NOW)).toBe(0);
    expect(readRetryAfter('', 'soon', NOW)).toBeUndefined();
    expect(readRetryAfter('', null, NOW)).toBeUndefined();
    expect(readRetryAfter(JSON.stringify({ retry_after_ms: -1 }), null, NOW)).toBeUndefined();
  });
});
