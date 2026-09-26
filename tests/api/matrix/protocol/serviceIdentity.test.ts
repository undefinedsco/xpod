import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { decodeVerifyKey, redactEvent, verifyJson } from '../../../../src/api/matrix/protocol/eventIntegrity';
import { EventIntegrityError } from '../../../../src/api/matrix/protocol/eventIntegrity';
import { MatrixServiceIdentity } from '../../../../src/api/matrix/protocol/serviceIdentity';

function signingKey(keyId = 'ed25519:1') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    keyId,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

describe('MatrixServiceIdentity', () => {
  it('publishes a self-signed server key response with the required fields', () => {
    const key = signingKey();
    const identity = new MatrixServiceIdentity({ serverName: 'example.org', activeKey: key, now: () => 1_000 });
    const response = identity.serverKeyResponse();

    expect(response.server_name).toBe('example.org');
    expect(Object.keys(response.verify_keys)).toEqual([ 'ed25519:1' ]);
    expect(response).toHaveProperty('signatures');
    expect(response.valid_until_ts).toBeGreaterThan(1_000);
    // The response must verify with the key it publishes, in the published form.
    const published = decodeVerifyKey(response.verify_keys['ed25519:1'].key);
    expect(verifyJson(response, 'example.org', 'ed25519:1', published)).toBe(true);
  });

  it('keeps the published key list fresh well inside the seven day cap', () => {
    const identity = new MatrixServiceIdentity({ serverName: 'example.org', activeKey: signingKey(), now: () => 0 });
    const response = identity.serverKeyResponse();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(response.valid_until_ts).toBeLessThanOrEqual(sevenDays);
    expect(() => new MatrixServiceIdentity({ serverName: 'e.org', activeKey: signingKey(), keyRefreshMs: sevenDays + 1 }))
      .toThrow(EventIntegrityError);
  });

  it('publishes old keys with their expiry so historical events stay verifiable', () => {
    const active = signingKey('ed25519:2');
    const old = signingKey('ed25519:1');
    const identity = new MatrixServiceIdentity({
      serverName: 'example.org',
      activeKey: active,
      oldKeys: [{ keyId: old.keyId, privateKeyPem: old.privateKeyPem, expiredTs: 1_532_645_052_628 }],
    });
    const response = identity.serverKeyResponse();
    expect(response.old_verify_keys).toEqual({
      'ed25519:1': { key: expect.stringMatching(/^[A-Za-z0-9+/]+$/u), expired_ts: 1_532_645_052_628 },
    });
    // Old keys are published for verification only; the response is signed by the active key.
    expect(Object.keys(response.signatures['example.org'])).toEqual([ 'ed25519:2' ]);
    expect(verifyJson(response, 'example.org', 'ed25519:2', decodeVerifyKey(response.verify_keys['ed25519:2'].key))).toBe(true);
    expect(verifyJson(response, 'example.org', 'ed25519:1', decodeVerifyKey(response.old_verify_keys!['ed25519:1'].key))).toBe(false);
  });

  it('signs events with the deployment identity', () => {
    const key = signingKey();
    const identity = new MatrixServiceIdentity({ serverName: 'example.org', activeKey: key });
    const signed = identity.signEvent({
      type: 'm.room.message', room_id: '!r:example.org', sender: '@a:example.org',
      content: { msgtype: 'm.text', body: 'hi' }, origin_server_ts: 1,
    });
    expect((signed.signatures as Record<string, Record<string, string>>)['example.org']).toHaveProperty('ed25519:1');
    // The signature covers the redacted event, which is the form a verifier
    // reconstructs; the full content is not part of the signed surface.
    expect(verifyJson(redactEvent(signed as Record<string, unknown>), 'example.org', key.keyId, key.publicKeyPem))
      .toBe(true);
  });

  it('generates a development key only when none is configured, and reports it', () => {
    const onGeneratedKey = vi.fn();
    const identity = new MatrixServiceIdentity({ serverName: 'example.org', onGeneratedKey });
    expect(identity.keyId).toBe('ed25519:auto');
    expect(onGeneratedKey).toHaveBeenCalledWith('ed25519:auto');
    // A generated key still yields a verifiable response: the stack must work
    // with zero configuration while the caller decides whether that is acceptable.
    const response = identity.serverKeyResponse();
    expect(verifyJson(response, 'example.org', identity.keyId, decodeVerifyKey(response.verify_keys[identity.keyId].key))).toBe(true);

    const configured = new MatrixServiceIdentity({ serverName: 'example.org', activeKey: signingKey(), onGeneratedKey });
    expect(configured.keyId).toBe('ed25519:1');
  });

  it('rejects malformed identity inputs', () => {
    expect(() => new MatrixServiceIdentity({ serverName: '  ' })).toThrow(EventIntegrityError);
    expect(() => new MatrixServiceIdentity({ serverName: 'e.org', activeKey: signingKey('ed25519:bad-version') }))
      .toThrow(EventIntegrityError);
    expect(() => new MatrixServiceIdentity({ serverName: 'e.org', activeKey: signingKey('rsa:1') }))
      .toThrow(EventIntegrityError);
    expect(() => new MatrixServiceIdentity({
      serverName: 'e.org', activeKey: signingKey(),
      oldKeys: [{ keyId: 'ed25519:1', privateKeyPem: signingKey().privateKeyPem, expiredTs: 0 }],
    })).toThrow(EventIntegrityError);
  });
});
