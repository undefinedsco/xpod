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
import { computeEventId } from '../../../../src/api/matrix/protocol/eventIntegrity';
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

describe('asking a peer for missing events', () => {
  it('posts a signed request for the room, and reads the events back', async () => {
    const identity = ourIdentity();
    const { client: instance, captured } = client({
      identity,
      respond: () => new Response(JSON.stringify({ events: [ { event_id: '$a' }, { event_id: '$b' } ] }), { status: 200 }),
    });
    const outcome = await instance.getMissingEvents({
      destination: THEM, roomId: '!room:remote.example', earliestEvents: [ '$known' ], latestEvents: [ '$latest' ], limit: 25, minDepth: 3,
    });

    expect(outcome).toMatchObject({ status: 'ok' });
    expect(outcome.events?.map(event => event.event_id)).toEqual([ '$a', '$b' ]);
    const [ sent ] = captured;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe(`https://${THEM}:8448/_matrix/federation/v1/get_missing_events/${encodeURIComponent('!room:remote.example')}`);
    expect(sent.body).toEqual({ earliest_events: [ '$known' ], latest_events: [ '$latest' ], limit: 25, min_depth: 3 });

    // The peer verifies the same signed object, so the signature covers this endpoint too.
    await expect(authenticateXMatrixRequest({
      authorization: sent.headers.authorization, method: 'POST',
      uri: `/_matrix/federation/v1/get_missing_events/${encodeURIComponent('!room:remote.example')}`,
      content: sent.body, keys: peerKeySource(identity), serverName: THEM,
    })).resolves.toMatchObject({ valid: true, origin: US });
  });

  it('omits limit and min_depth when the caller did not ask for them', async () => {
    const { client: instance, captured } = client();
    await instance.getMissingEvents({ destination: THEM, roomId: '!r:remote.example', earliestEvents: [], latestEvents: [ '$x' ] });
    expect(captured[0].body).toEqual({ earliest_events: [], latest_events: [ '$x' ] });
  });

  it('retries an answer it cannot read, and a rate limit or server error', async () => {
    const unreadable = client({ respond: () => new Response('not json', { status: 200 }) });
    await expect(unreadable.client.getMissingEvents({ destination: THEM, roomId: '!r:x', earliestEvents: [], latestEvents: [] }))
      .resolves.toMatchObject({ status: 'retry', reason: expect.stringContaining('events array') });
    const empty = client({ respond: () => new Response(JSON.stringify({}), { status: 200 }) });
    await expect(empty.client.getMissingEvents({ destination: THEM, roomId: '!r:x', earliestEvents: [], latestEvents: [] }))
      .resolves.toMatchObject({ status: 'retry' });
    const limited = client({ respond: () => new Response(JSON.stringify({ retry_after_ms: 750 }), { status: 429 }) });
    await expect(limited.client.getMissingEvents({ destination: THEM, roomId: '!r:x', earliestEvents: [], latestEvents: [] }))
      .resolves.toMatchObject({ status: 'retry', retryAfterMs: 750 });
    const down = client({ respond: () => new Response('', { status: 502 }) });
    await expect(down.client.getMissingEvents({ destination: THEM, roomId: '!r:x', earliestEvents: [], latestEvents: [] }))
      .resolves.toMatchObject({ status: 'retry', reason: expect.stringContaining('502') });
  });

  it('treats a refusal and an unreachable peer differently', async () => {
    const refused = client({ respond: () => new Response('', { status: 403 }) });
    await expect(refused.client.getMissingEvents({ destination: THEM, roomId: '!r:x', earliestEvents: [], latestEvents: [] }))
      .resolves.toMatchObject({ status: 'rejected' });
    const offline = client({ respond: () => { throw new Error('connect ECONNREFUSED'); } });
    await expect(offline.client.getMissingEvents({ destination: THEM, roomId: '!r:x', earliestEvents: [], latestEvents: [] }))
      .resolves.toMatchObject({ status: 'retry', reason: expect.stringContaining('ECONNREFUSED') });
    const unresolved = client({ resolved: null });
    await expect(unresolved.client.getMissingEvents({ destination: THEM, roomId: '!r:x', earliestEvents: [], latestEvents: [] }))
      .resolves.toMatchObject({ status: 'rejected' });
  });
});

describe('asking a peer for an auth chain', () => {
  it('signs a GET with no body and reads the chain back', async () => {
    const identity = ourIdentity();
    const { client: instance, captured } = client({
      identity,
      respond: () => new Response(JSON.stringify({ auth_chain: [ { event_id: '$create' }, { event_id: '$join' } ] }), { status: 200 }),
    });
    const outcome = await instance.getAuthChain({ destination: THEM, roomId: '!room:remote.example', eventId: '$invite' });

    expect(outcome).toMatchObject({ status: 'ok' });
    expect(outcome.events?.map(event => event.event_id)).toEqual([ '$create', '$join' ]);
    const [ sent ] = captured;
    expect(sent.method).toBe('GET');
    expect(sent.url).toBe(`https://${THEM}:8448/_matrix/federation/v1/event_auth/${encodeURIComponent('!room:remote.example')}/${encodeURIComponent('$invite')}`);
    // No body means no `content` in the signed object and no content-type header.
    expect(sent.body).toEqual({});
    expect(sent.headers['content-type']).toBeUndefined();
    await expect(authenticateXMatrixRequest({
      authorization: sent.headers.authorization, method: 'GET',
      uri: `/_matrix/federation/v1/event_auth/${encodeURIComponent('!room:remote.example')}/${encodeURIComponent('$invite')}`,
      keys: peerKeySource(identity), serverName: THEM,
    })).resolves.toMatchObject({ valid: true, origin: US });
  });

  it('retries an unreadable answer and refuses a 404', async () => {
    const unreadable = client({ respond: () => new Response(JSON.stringify({}), { status: 200 }) });
    await expect(unreadable.client.getAuthChain({ destination: THEM, roomId: '!r:x', eventId: '$e' }))
      .resolves.toMatchObject({ status: 'retry', reason: expect.stringContaining('auth_chain') });
    const missing = client({ respond: () => new Response('', { status: 404 }) });
    await expect(missing.client.getAuthChain({ destination: THEM, roomId: '!r:x', eventId: '$e' }))
      .resolves.toMatchObject({ status: 'rejected' });
  });
});

describe('asking a peer for history and state', () => {
  it('asks for a backfill window with the events in the query string', async () => {
    const identity = ourIdentity();
    const { client: instance, captured } = client({
      identity,
      respond: () => new Response(JSON.stringify({ origin: US, origin_server_ts: NOW, pdus: [ { event_id: '$b' }, { event_id: '$a' } ] }), { status: 200 }),
    });
    const outcome = await instance.backfill({ destination: THEM, roomId: '!r:remote.example', from: [ '$b' ], limit: 2 });

    expect(outcome).toMatchObject({ status: 'ok' });
    expect(outcome.events?.map(event => event.event_id)).toEqual([ '$b', '$a' ]);
    const [ sent ] = captured;
    const uri = sent.url.slice(sent.url.indexOf('/_matrix'));
    expect(uri).toBe(`/_matrix/federation/v1/backfill/${encodeURIComponent('!r:remote.example')}?v=%24b&limit=2`);
    // The query string is part of the signed target, so the receiver reconstructs the same one.
    await expect(authenticateXMatrixRequest({
      authorization: sent.headers.authorization, method: 'GET', uri,
      keys: peerKeySource(identity), serverName: THEM,
    })).resolves.toMatchObject({ valid: true });
    expect(sent.headers['content-type']).toBeUndefined();
  });

  it('sends every named event when several are given', async () => {
    const { client: instance, captured } = client();
    await instance.backfill({ destination: THEM, roomId: '!r:x', from: [ '$a', '$b' ], limit: 10 });
    expect(captured[0].url).toContain('v=%24a&v=%24b&limit=10');
  });

  it('reads a state snapshot and its auth chain', async () => {
    const { client: instance, captured } = client({
      respond: () => new Response(JSON.stringify({ pdus: [ { event_id: '$create' } ], auth_chain: [ { event_id: '$power' } ] }), { status: 200 }),
    });
    const outcome = await instance.getState({ destination: THEM, roomId: '!r:remote.example', eventId: '$e' });
    expect(outcome).toMatchObject({ status: 'ok' });
    expect(outcome.events?.map(event => event.event_id)).toEqual([ '$create' ]);
    expect(outcome.authChain?.map(event => event.event_id)).toEqual([ '$power' ]);
    expect(captured[0].url).toBe(`https://${THEM}:8448/_matrix/federation/v1/state/${encodeURIComponent('!r:remote.example')}?event_id=%24e`);
  });

  it('reads state ids, and retries an answer that is missing either list', async () => {
    const ids = client({ respond: () => new Response(JSON.stringify({ pdu_ids: [ '$a' ], auth_chain_ids: [ '$b', '$c' ] }), { status: 200 }) });
    await expect(ids.client.getStateIds({ destination: THEM, roomId: '!r:x', eventId: '$e' }))
      .resolves.toMatchObject({ status: 'ok', pduIds: [ '$a' ], authChainIds: [ '$b', '$c' ] });

    const partial = client({ respond: () => new Response(JSON.stringify({ pdu_ids: [ '$a' ] }), { status: 200 }) });
    await expect(partial.client.getStateIds({ destination: THEM, roomId: '!r:x', eventId: '$e' }))
      .resolves.toMatchObject({ status: 'retry', reason: expect.stringContaining('auth_chain_ids') });
    const empty = client({ respond: () => new Response(JSON.stringify({}), { status: 200 }) });
    await expect(empty.client.getState({ destination: THEM, roomId: '!r:x', eventId: '$e' }))
      .resolves.toMatchObject({ status: 'retry', reason: expect.stringContaining('auth_chain') });
  });

  it('classifies refusals and unreachable peers for these requests too', async () => {
    const refused = client({ respond: () => new Response('', { status: 404 }) });
    await expect(refused.client.backfill({ destination: THEM, roomId: '!r:x', from: [ '$a' ], limit: 1 }))
      .resolves.toMatchObject({ status: 'rejected' });
    const down = client({ respond: () => new Response('', { status: 503 }) });
    await expect(down.client.getStateIds({ destination: THEM, roomId: '!r:x', eventId: '$e' }))
      .resolves.toMatchObject({ status: 'retry' });
    const offline = client({ respond: () => { throw new Error('connect ECONNREFUSED'); } });
    await expect(offline.client.getState({ destination: THEM, roomId: '!r:x', eventId: '$e' }))
      .resolves.toMatchObject({ status: 'retry', reason: expect.stringContaining('ECONNREFUSED') });
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

describe('the join and leave handshake', () => {
  const ROOM = '!r:remote.example';
  const USER = `@u_us:${US}`;
  const template = (membership: 'join' | 'leave') => ({
    room_version: '11',
    event: {
      room_id: ROOM, type: 'm.room.member', sender: USER, state_key: USER,
      content: { membership }, depth: 4, prev_events: [ '$prev' ], auth_events: [ '$create' ],
    },
  });
  /** The join event this server would sign and submit, with its own derived id. */
  const joinEvent = () => ({
    room_id: ROOM, type: 'm.room.member', sender: USER, state_key: USER, origin: US, origin_server_ts: NOW,
    content: { membership: 'join' }, depth: 4, prev_events: [ '$prev' ], auth_events: [ '$create' ],
  });
  const joinId = () => computeEventId(joinEvent());

  it('asks for a join template, offering the room version it implements', async () => {
    const { client: instance, captured, identity } = client({
      respond: () => new Response(JSON.stringify(template('join')), { status: 200 }),
    });
    const outcome = await instance.makeJoin({ destination: THEM, roomId: ROOM, userId: USER });

    expect(outcome).toMatchObject({ status: 'ok', roomVersion: '11' });
    expect(outcome.event).toMatchObject({ type: 'm.room.member', state_key: USER, content: { membership: 'join' } });
    const [ sent ] = captured;
    expect(sent.method).toBe('GET');
    const uri = `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(USER)}?ver=11`;
    expect(sent.url).toBe(`https://${THEM}:8448${uri}`);
    // A GET has no body, so the signed object carries no `content` at all.
    await expect(authenticateXMatrixRequest({
      authorization: sent.headers.authorization, method: 'GET', uri, keys: peerKeySource(identity), serverName: THEM,
    })).resolves.toMatchObject({ valid: true, origin: US });
  });

  it('sends every version the caller offers, and none when the caller offers none', async () => {
    const { client: instance, captured } = client({ respond: () => new Response(JSON.stringify(template('join')), { status: 200 }) });
    await instance.makeJoin({ destination: THEM, roomId: ROOM, userId: USER, versions: [ '11', '12' ] });
    expect(captured[0].url).toContain('?ver=11&ver=12');
    await instance.makeJoin({ destination: THEM, roomId: ROOM, userId: USER, versions: [] });
    // An empty list means the specification's default, `['1']`, so no parameter is sent.
    expect(captured[1].url.endsWith(encodeURIComponent(USER))).toBe(true);
  });

  it('discards a template that is not for the request that was made', async () => {
    const elsewhere = { ...template('join'), event: { ...template('join').event, room_id: '!other:x.example' } };
    const { client: instance } = client({ respond: () => new Response(JSON.stringify(elsewhere), { status: 200 }) });
    const outcome = await instance.makeJoin({ destination: THEM, roomId: ROOM, userId: USER });
    expect(outcome.status).toBe('rejected');
    expect(outcome.reason).toMatch(/!other:x\.example/u);
    expect(outcome.event).toBeUndefined();
  });

  it('discards a template for a room version it did not offer', async () => {
    const { client: instance } = client({
      respond: () => new Response(JSON.stringify({ ...template('join'), room_version: '10' }), { status: 200 }),
    });
    await expect(instance.makeJoin({ destination: THEM, roomId: ROOM, userId: USER }))
      .resolves.toMatchObject({ status: 'rejected', reason: expect.stringMatching(/room version 10/u) });
  });

  it('asks for a leave template and checks its membership', async () => {
    const { client: instance, captured } = client({ respond: () => new Response(JSON.stringify(template('leave')), { status: 200 }) });
    const outcome = await instance.makeLeave({ destination: THEM, roomId: ROOM, userId: USER });
    expect(outcome).toMatchObject({ status: 'ok', roomVersion: '11' });
    expect(captured[0].url).toBe(`https://${THEM}:8448/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(USER)}`);
  });

  it('submits a signed join and reads the state, auth chain and accepted event back', async () => {
    const accepted = { ...joinEvent(), event_id: joinId(), signatures: { [THEM]: { 'ed25519:1': 'sig' } } };
    const { client: instance, captured, identity } = client({
      respond: () => new Response(JSON.stringify({
        state: [ { event_id: '$create' } ], auth_chain: [ { event_id: '$create' } ], event: accepted,
      }), { status: 200 }),
    });
    const outcome = await instance.sendJoin({ destination: THEM, roomId: ROOM, eventId: joinId(), event: joinEvent() });

    expect(outcome.status).toBe('ok');
    expect(outcome.state).toEqual([ { event_id: '$create' } ]);
    expect(outcome.authChain).toEqual([ { event_id: '$create' } ]);
    expect(outcome.event).toMatchObject({ event_id: joinId() });
    expect(outcome.membersOmitted).toBeUndefined();

    const [ sent ] = captured;
    const uri = `/_matrix/federation/v2/send_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(joinId())}`;
    expect(sent.method).toBe('PUT');
    expect(sent.url).toBe(`https://${THEM}:8448${uri}`);
    expect(sent.body).toEqual(joinEvent());
    // The body *is* the event, so the signature covers the event itself.
    await expect(authenticateXMatrixRequest({
      authorization: sent.headers.authorization, method: 'PUT', uri, content: sent.body, keys: peerKeySource(identity), serverName: THEM,
    })).resolves.toMatchObject({ valid: true, origin: US });
  });

  it('asks for membership events to be left out, and reads back what the resident omitted', async () => {
    const { client: instance, captured } = client({
      respond: () => new Response(JSON.stringify({
        state: [], auth_chain: [], members_omitted: true, servers_in_room: [ THEM ],
      }), { status: 200 }),
    });
    const outcome = await instance.sendJoin({
      destination: THEM, roomId: ROOM, eventId: joinId(), event: joinEvent(), omitMembers: true,
    });
    expect(captured[0].url).toContain('?omit_members=true');
    expect(outcome).toMatchObject({ status: 'ok', membersOmitted: true, serversInRoom: [ THEM ] });
    // Our own resident never omits anything, so the flag is absent from our answers.
    expect(outcome.event).toBeUndefined();
  });

  it('refuses an event the resident answered with, when it is not the one submitted', async () => {
    const other = { ...joinEvent(), depth: 9, event_id: computeEventId({ ...joinEvent(), depth: 9 }) };
    const { client: instance } = client({
      respond: () => new Response(JSON.stringify({ state: [], auth_chain: [], event: other }), { status: 200 }),
    });
    await expect(instance.sendJoin({ destination: THEM, roomId: ROOM, eventId: joinId(), event: joinEvent() }))
      .resolves.toMatchObject({ status: 'rejected', reason: expect.stringMatching(/not \$/u) });
  });

  it('retries an answer that is missing the state, and classifies refusals as final', async () => {
    const { client: unreadable } = client({ respond: () => new Response(JSON.stringify({ state: [] }), { status: 200 }) });
    await expect(unreadable.sendJoin({ destination: THEM, roomId: ROOM, eventId: joinId(), event: joinEvent() }))
      .resolves.toMatchObject({ status: 'retry' });

    const { client: refused } = client({ respond: () => new Response('{}', { status: 403 }) });
    await expect(refused.sendJoin({ destination: THEM, roomId: ROOM, eventId: joinId(), event: joinEvent() }))
      .resolves.toMatchObject({ status: 'rejected' });

    const { client: failing } = client({ respond: () => new Response('{}', { status: 500 }) });
    await expect(failing.sendJoin({ destination: THEM, roomId: ROOM, eventId: joinId(), event: joinEvent() }))
      .resolves.toMatchObject({ status: 'retry' });
  });

  it('submits a leave, which v2 answers with an empty object', async () => {
    const { client: instance, captured } = client({ respond: () => new Response('{}', { status: 200 }) });
    const leave = { ...joinEvent(), content: { membership: 'leave' } };
    const outcome = await instance.sendLeave({ destination: THEM, roomId: ROOM, eventId: joinId(), event: leave });
    expect(outcome).toEqual({ status: 'ok', reason: 'ok' });
    expect(captured[0].url).toBe(`https://${THEM}:8448/_matrix/federation/v2/send_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(joinId())}`);
    expect(captured[0].body).toEqual(leave);
  });
});

describe('asking a peer to sign an invite', () => {
  const ROOM = '!r:remote.example';
  const SENDER = `@u_us:${US}`;
  const INVITED = `@u_them:${THEM}`;
  const invite = () => ({
    room_id: ROOM, type: 'm.room.member', sender: SENDER, state_key: INVITED, origin: US, origin_server_ts: NOW,
    content: { membership: 'invite' }, depth: 4, prev_events: [ '$prev' ], auth_events: [ '$create' ],
  });
  const inviteId = () => computeEventId(invite());
  const createState = { type: 'm.room.create', state_key: '', sender: SENDER, content: { room_version: '11' } };
  /** The same event with the invited server's signature on it. */
  const signedByThem = () => ({ ...invite(), event_id: inviteId(), signatures: { [THEM]: { 'ed25519:1': 'sig' } } });

  it('sends the container the specification asks for, and reads the signed event back', async () => {
    const { client: instance, captured, identity } = client({
      respond: () => new Response(JSON.stringify({ event: signedByThem() }), { status: 200 }),
    });
    const outcome = await instance.sendInvite({
      destination: THEM, roomId: ROOM, eventId: inviteId(), event: invite(), inviteRoomState: [ createState ],
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.event).toMatchObject({ event_id: inviteId(), signatures: { [THEM]: { 'ed25519:1': 'sig' } } });

    const [ sent ] = captured;
    const uri = `/_matrix/federation/v2/invite/${encodeURIComponent(ROOM)}/${encodeURIComponent(inviteId())}`;
    expect(sent.method).toBe('PUT');
    expect(sent.url).toBe(`https://${THEM}:8448${uri}`);
    // Not the bare event: `/invite` wraps it with the room version and the display state.
    expect(sent.body).toEqual({ room_version: '11', event: invite(), invite_room_state: [ createState ] });
    // The signature covers the container that is actually sent.
    await expect(authenticateXMatrixRequest({
      authorization: sent.headers.authorization, method: 'PUT', uri, content: sent.body, keys: peerKeySource(identity), serverName: THEM,
    })).resolves.toMatchObject({ valid: true, origin: US });
  });

  it('omits the display state when there is none, and keeps the version the caller named', async () => {
    const { client: instance, captured } = client({ respond: () => new Response(JSON.stringify({ event: signedByThem() }), { status: 200 }) });
    await instance.sendInvite({
      destination: THEM, roomId: ROOM, eventId: inviteId(), event: invite(), roomVersion: '10', inviteRoomState: [],
    });
    // An empty list would be a field the peer has to interpret for nothing.
    expect('invite_room_state' in captured[0].body).toBe(false);
    expect(captured[0].body.room_version).toBe('10');
  });

  it('will not take an answer that is unsigned, unreadable or about another event', async () => {
    // The signature is the reason for the request: without it there is nothing to use.
    const unsigned = client({ respond: () => new Response(JSON.stringify({ event: { ...invite(), event_id: inviteId() } }), { status: 200 }) });
    await expect(unsigned.client.sendInvite({ destination: THEM, roomId: ROOM, eventId: inviteId(), event: invite() }))
      .resolves.toMatchObject({ status: 'retry', reason: expect.stringMatching(/without its own signature/u) });

    const unreadable = client({ respond: () => new Response('{}', { status: 200 }) });
    await expect(unreadable.client.sendInvite({ destination: THEM, roomId: ROOM, eventId: inviteId(), event: invite() }))
      .resolves.toMatchObject({ status: 'retry' });

    const other = { ...signedByThem(), depth: 9 };
    const elsewhere = client({ respond: () => new Response(JSON.stringify({ event: other }), { status: 200 }) });
    await expect(elsewhere.client.sendInvite({ destination: THEM, roomId: ROOM, eventId: inviteId(), event: invite() }))
      .resolves.toMatchObject({ status: 'rejected', reason: expect.stringMatching(/not \$/u) });

    const refused = client({ respond: () => new Response(JSON.stringify({ errcode: 'M_FORBIDDEN' }), { status: 403 }) });
    await expect(refused.client.sendInvite({ destination: THEM, roomId: ROOM, eventId: inviteId(), event: invite() }))
      .resolves.toMatchObject({ status: 'rejected' });
  });
});

describe('knocking on a room', () => {
  const ROOM = '!r:remote.example';
  const KNOCKER = `@u_us:${US}`;
  const template = {
    room_version: '11',
    event: {
      room_id: ROOM, type: 'm.room.member', sender: KNOCKER, state_key: KNOCKER,
      content: { membership: 'knock' }, depth: 4, prev_events: [ '$prev' ], auth_events: [ '$rules' ],
    },
  };
  const knockEvent = () => ({
    room_id: ROOM, type: 'm.room.member', sender: KNOCKER, state_key: KNOCKER, origin: US, origin_server_ts: NOW,
    content: { membership: 'knock' }, depth: 4, prev_events: [ '$prev' ], auth_events: [ '$rules' ],
  });
  const knockId = () => computeEventId(knockEvent());

  it('asks for a knock template, always naming the versions it supports', async () => {
    const { client: instance, captured, identity } = client({ respond: () => new Response(JSON.stringify(template), { status: 200 }) });
    const outcome = await instance.makeKnock({ destination: THEM, roomId: ROOM, userId: KNOCKER });

    expect(outcome).toMatchObject({ status: 'ok', roomVersion: '11' });
    expect(outcome.event).toMatchObject({ content: { membership: 'knock' } });
    const uri = `/_matrix/federation/v1/make_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(KNOCKER)}?ver=11`;
    expect(captured[0].method).toBe('GET');
    expect(captured[0].url).toBe(`https://${THEM}:8448${uri}`);
    await expect(authenticateXMatrixRequest({
      authorization: captured[0].headers.authorization, method: 'GET', uri, keys: peerKeySource(identity), serverName: THEM,
    })).resolves.toMatchObject({ valid: true, origin: US });
  });

  it('submits the knock event itself and reads the stripped state back', async () => {
    const state = [ { type: 'm.room.create', state_key: '', sender: `@u_alice:${THEM}`, content: { room_version: '11' } } ];
    const { client: instance, captured, identity } = client({ respond: () => new Response(JSON.stringify({ knock_room_state: state }), { status: 200 }) });
    const outcome = await instance.sendKnock({ destination: THEM, roomId: ROOM, eventId: knockId(), event: knockEvent() });

    expect(outcome).toMatchObject({ status: 'ok', knockRoomState: state });
    const uri = `/_matrix/federation/v1/send_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(knockId())}`;
    expect(captured[0].method).toBe('PUT');
    // The body is the event, as for joins and leaves.
    expect(captured[0].body).toEqual(knockEvent());
    await expect(authenticateXMatrixRequest({
      authorization: captured[0].headers.authorization, method: 'PUT', uri, content: captured[0].body, keys: peerKeySource(identity), serverName: THEM,
    })).resolves.toMatchObject({ valid: true });
  });

  it('retries an answer without the room state, and treats a refusal as final', async () => {
    const unreadable = client({ respond: () => new Response('{}', { status: 200 }) });
    await expect(unreadable.client.sendKnock({ destination: THEM, roomId: ROOM, eventId: knockId(), event: knockEvent() }))
      .resolves.toMatchObject({ status: 'retry', reason: expect.stringMatching(/knock_room_state/u) });

    const refused = client({ respond: () => new Response(JSON.stringify({ errcode: 'M_FORBIDDEN' }), { status: 403 }) });
    await expect(refused.client.sendKnock({ destination: THEM, roomId: ROOM, eventId: knockId(), event: knockEvent() }))
      .resolves.toMatchObject({ status: 'rejected' });
  });
});

describe('asking which room an alias names', () => {
  const ALIAS = '#lobby:remote.example';

  it('signs a query for the alias and reads the room and its servers back', async () => {
    const { client: instance, captured, identity } = client({
      respond: () => new Response(JSON.stringify({ room_id: '!r:remote.example', servers: [ 'remote.example', 'pod.example' ] }), { status: 200 }),
    });
    const outcome = await instance.queryDirectory({ destination: THEM, roomAlias: ALIAS });

    expect(outcome).toMatchObject({ status: 'ok', roomId: '!r:remote.example', servers: [ 'remote.example', 'pod.example' ] });
    const [ sent ] = captured;
    const uri = `/_matrix/federation/v1/query/directory?${new URLSearchParams({ room_alias: ALIAS }).toString()}`;
    expect(sent.method).toBe('GET');
    expect(sent.url).toBe(`https://${THEM}:8448${uri}`);
    await expect(authenticateXMatrixRequest({
      authorization: sent.headers.authorization, method: 'GET', uri, keys: peerKeySource(identity), serverName: THEM,
    })).resolves.toMatchObject({ valid: true, origin: US });
  });

  it('retries an answer it cannot read, and treats a refusal as final', async () => {
    const unreadable = client({ respond: () => new Response(JSON.stringify({ room_id: '!r:x' }), { status: 200 }) });
    await expect(unreadable.client.queryDirectory({ destination: THEM, roomAlias: ALIAS }))
      .resolves.toMatchObject({ status: 'retry', reason: expect.stringMatching(/room_id and servers/u) });

    const refused = client({ respond: () => new Response(JSON.stringify({ errcode: 'M_NOT_FOUND' }), { status: 404 }) });
    await expect(refused.client.queryDirectory({ destination: THEM, roomAlias: ALIAS }))
      .resolves.toMatchObject({ status: 'rejected' });
  });
});

describe('asking about a user\'s profile', () => {
  it('signs the query and reads back whatever the server publishes', async () => {
    const { client: instance, captured, identity } = client({
      respond: () => new Response(JSON.stringify({ displayname: 'Alice' }), { status: 200 }),
    });
    const outcome = await instance.queryProfile({ destination: THEM, userId: `@u_x:${THEM}`, field: 'displayname' });

    expect(outcome).toMatchObject({ status: 'ok', profile: { displayname: 'Alice' } });
    const [ sent ] = captured;
    const uri = `/_matrix/federation/v1/query/profile?${new URLSearchParams({ user_id: `@u_x:${THEM}`, field: 'displayname' }).toString()}`;
    expect(sent.url).toBe(`https://${THEM}:8448${uri}`);
    await expect(authenticateXMatrixRequest({
      authorization: sent.headers.authorization, method: 'GET', uri, keys: peerKeySource(identity), serverName: THEM,
    })).resolves.toMatchObject({ valid: true, origin: US });
  });

  it('takes an empty profile as an answer, and a refusal as final', async () => {
    const empty = client({ respond: () => new Response('{}', { status: 200 }) });
    await expect(empty.client.queryProfile({ destination: THEM, userId: `@u_x:${THEM}` }))
      .resolves.toMatchObject({ status: 'ok', profile: {} });

    const refused = client({ respond: () => new Response(JSON.stringify({ errcode: 'M_FORBIDDEN' }), { status: 403 }) });
    await expect(refused.client.queryProfile({ destination: THEM, userId: `@u_x:${THEM}` }))
      .resolves.toMatchObject({ status: 'rejected' });
  });
});
