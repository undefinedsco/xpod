import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  MatrixServerKeyFetcher,
  parseServerKeyResponse,
  verifyRemoteEventSignature,
} from '../../../../src/api/matrix/federation/serverKeys';
import { MatrixServiceIdentity } from '../../../../src/api/matrix/protocol/serviceIdentity';
import { signEvent, signJson } from '../../../../src/api/matrix/protocol/eventIntegrity';

const DAY = 24 * 60 * 60 * 1000;
const REMOTE = 'remote.example';
const ROOM = '!r:remote.example';
const ALICE = '@u_alice:remote.example';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fetcher(fetchImpl: typeof fetch, now: () => number) {
  return new MatrixServerKeyFetcher({ fetch: fetchImpl, now, maxValidityMs: 7 * DAY });
}

/** Identities whose private key the test keeps, so it can sign events as that server. */
const keysOf = new Map<string, string>();

function identityWithPrivateKey(serverName = REMOTE, keyId = 'ed25519:1', now?: () => number) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  keysOf.set(keyId, pem);
  return new MatrixServiceIdentity({ serverName, activeKey: { keyId, privateKeyPem: pem }, ...(now ? { now } : {}) });
}

describe('remote server keys', () => {
  it('fetches, self-checks and caches a key response', async () => {
    let now = 1_000;
    const service = identityWithPrivateKey(REMOTE, 'ed25519:1', () => now);
    const fetchImpl = vi.fn(async () => jsonResponse(service.serverKeyResponse()));
    const keys = fetcher(fetchImpl as unknown as typeof fetch, () => now);

    const first = await keys.keysFor(REMOTE);
    expect(first).toBeDefined();
    expect(first!.serverName).toBe(REMOTE);
    expect(Object.keys(first!.verifyKeys)).toEqual([ 'ed25519:1' ]);
    expect(first!.validUntilTs).toBeLessThanOrEqual(now + 7 * DAY);

    // A second check inside the validity window does not refetch.
    expect(await keys.keysFor(REMOTE)).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('shares one request between concurrent callers and refetches after it expires', async () => {
    let now = 1_000;
    const service = identityWithPrivateKey(REMOTE, 'ed25519:1', () => now);
    const fetchImpl = vi.fn(async () => jsonResponse(service.serverKeyResponse()));
    const keys = fetcher(fetchImpl as unknown as typeof fetch, () => now);

    const [ first, second ] = await Promise.all([ keys.keysFor(REMOTE), keys.keysFor(REMOTE) ]);
    expect(first).toBe(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 7 * DAY + 1;
    await keys.keysFor(REMOTE);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('clamps a long publication to the seven-day cap', () => {
    const service = identityWithPrivateKey(REMOTE, 'ed25519:1');
    const response = service.serverKeyResponse() as Record<string, unknown>;
    // A server that publishes a year-long window must still be re-checked weekly, so
    // the response has to be re-signed for the longer value to be a valid publication.
    const payload = { ...response, valid_until_ts: 1_000 + 365 * DAY };
    const signed = {
      ...payload,
      signatures: { [REMOTE]: { 'ed25519:1': signJson(payload, { keyId: 'ed25519:1', privateKeyPem: keysOf.get('ed25519:1')! }) } },
    };
    const parsed = parseServerKeyResponse(signed, { expectedServerName: REMOTE, now: 1_000 });
    expect(parsed.validUntilTs).toBe(1_000 + 7 * DAY);
  });

  it('refuses a response it cannot trust', () => {
    const service = identityWithPrivateKey(REMOTE, 'ed25519:1');
    const response = service.serverKeyResponse() as Record<string, unknown>;

    expect(() => parseServerKeyResponse(response, { expectedServerName: 'other.example', now: 1_000 }))
      .toThrow(/is for remote\.example, not other\.example/u);

    // A relay swapping in its own keys cannot produce a self-signature for REMOTE.
    const forged = {
      ...response,
      verify_keys: { 'ed25519:1': { key: identityWithPrivateKey('attacker.example', 'ed25519:1').serverKeyResponse().verify_keys['ed25519:1'].key } },
    };
    expect(() => parseServerKeyResponse(forged, { expectedServerName: REMOTE, now: 1_000 }))
      .toThrow(/not signed by a key it publishes/u);

    expect(() => parseServerKeyResponse({ ...response, valid_until_ts: 999 }, { expectedServerName: REMOTE, now: 1_000 }))
      .toThrow(/already expired/u);
    expect(() => parseServerKeyResponse({ ...response, verify_keys: {} }, { expectedServerName: REMOTE, now: 1_000 }))
      .toThrow(/publishes no verify keys/u);
  });

  it('reports an unreachable or failing endpoint as "no keys"', async () => {
    const failing = vi.fn(async () => jsonResponse({ errcode: 'M_NOT_FOUND' }, 404));
    expect(await fetcher(failing as unknown as typeof fetch, () => 1_000).keysFor(REMOTE)).toBeUndefined();
    const throwing = vi.fn(async () => { throw new Error('network'); });
    expect(await fetcher(throwing as unknown as typeof fetch, () => 1_000).keysFor(REMOTE)).toBeUndefined();
  });

  it('verifies an event signed by the server it names', async () => {
    let now = 1_000;
    const service = identityWithPrivateKey(REMOTE, 'ed25519:1', () => now);
    const response = service.serverKeyResponse();
    const event = signEvent({
      type: 'm.room.create', room_id: ROOM, sender: ALICE, state_key: '', origin_server_ts: 1_500,
      content: { room_version: '11' }, prev_events: [], auth_events: [],
    }, { keyId: service.keyId, privateKeyPem: keysOf.get('ed25519:1')! }, REMOTE);
    const keys = parseServerKeyResponse(response, { expectedServerName: REMOTE, now });

    expect(verifyRemoteEventSignature(event as Record<string, unknown>, keys, now).valid).toBe(true);
    // The signature covers the redacted event, so a state event's content is protected.
    const tampered = { ...event, content: { room_version: '11', extra: 'tampered' } };
    expect(verifyRemoteEventSignature(tampered as Record<string, unknown>, keys, now).valid).toBe(false);
    expect(verifyRemoteEventSignature(event as Record<string, unknown>, undefined, now).valid).toBe(false);
  });

  it('refuses a signature whose key list had expired when the event was sent', () => {
    const service = identityWithPrivateKey(REMOTE, 'ed25519:1');
    const keys = parseServerKeyResponse(service.serverKeyResponse(), { expectedServerName: REMOTE, now: 1_000 });
    const later = signEvent({
      type: 'm.room.create', room_id: ROOM, sender: ALICE, state_key: '', origin_server_ts: keys.validUntilTs + 1,
      content: { room_version: '11' }, prev_events: [], auth_events: [],
    }, { keyId: service.keyId, privateKeyPem: keysOf.get('ed25519:1')! }, REMOTE);
    const check = verifyRemoteEventSignature(later as Record<string, unknown>, keys, keys.validUntilTs + 1);
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/expired before the event was sent/u);
  });

  it('accepts a retired key only for events sent while it was in use', () => {
    const oldKey = identityWithPrivateKey(REMOTE, 'ed25519:old');
    const response = oldKey.serverKeyResponse();
    const keys = {
      serverName: REMOTE,
      verifyKeys: { 'ed25519:new': response.verify_keys['ed25519:old'].key },
      oldVerifyKeys: { 'ed25519:old': { verifyKey: response.verify_keys['ed25519:old'].key, expiredTs: 2_000 } },
      validUntilTs: 10_000,
    };
    const before = signEvent({
      type: 'm.room.create', room_id: ROOM, sender: ALICE, state_key: '', origin_server_ts: 1_500,
      content: { room_version: '11' }, prev_events: [], auth_events: [],
    }, { keyId: 'ed25519:old', privateKeyPem: keysOf.get('ed25519:old')! }, REMOTE);
    expect(verifyRemoteEventSignature(before as Record<string, unknown>, keys, 1_500).valid).toBe(true);

    const after = signEvent({
      type: 'm.room.create', room_id: ROOM, sender: ALICE, state_key: '', origin_server_ts: 2_500,
      content: { room_version: '11' }, prev_events: [], auth_events: [],
    }, { keyId: 'ed25519:old', privateKeyPem: keysOf.get('ed25519:old')! }, REMOTE);
    const check = verifyRemoteEventSignature(after as Record<string, unknown>, keys, 2_500);
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/no signature verifies/u);
  });

  it('uses the injected endpoint so discovery can plug in', async () => {
    const service = identityWithPrivateKey(REMOTE, 'ed25519:1');
    const fetchImpl = vi.fn(async () => jsonResponse(service.serverKeyResponse()));
    const keys = new MatrixServerKeyFetcher({
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => 1_000,
      resolveKeyEndpoint: serverName => `https://delegated.example/_matrix/key/v2/server?name=${serverName}`,
    });
    await keys.keysFor(REMOTE);
    expect(fetchImpl).toHaveBeenCalledWith(`https://delegated.example/_matrix/key/v2/server?name=${REMOTE}`,
      expect.objectContaining({ headers: { accept: 'application/json' } }));
  });
});
