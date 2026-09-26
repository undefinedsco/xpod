import { describe, expect, it } from 'vitest';
import {
  activateMatrixSigningKey,
  activeSigningKey,
  createMatrixSigningKeySet,
  decodeMatrixSigningKeySet,
  encodeMatrixSigningKeySet,
  pruneExpiredSigningKeys,
  publishableVerifyKeys,
  stageMatrixSigningKey,
} from '../../../../src/api/matrix/protocol/signingKeys';
import {
  createMatrixServiceIdentityFromKeySet,
} from '../../../../src/api/matrix/protocol/serviceIdentity';
import {
  decodeVerifyKey,
  redactEvent,
  signEvent,
  verifyJson,
} from '../../../../src/api/matrix/protocol/eventIntegrity';

const DAY = 24 * 60 * 60 * 1000;

function identityKeys(now = 1_000) {
  return createMatrixSigningKeySet({ now });
}

describe('Matrix signing key sets', () => {
  it('starts with one active key whose published form belongs to its private key', () => {
    const keySet = identityKeys();
    expect(keySet.version).toBe(1);
    expect(keySet.keys).toHaveLength(1);
    const active = activeSigningKey(keySet);
    expect(active.keyId).toBe('ed25519:1');
    expect(active.status).toBe('active');
    // decodeVerifyKey throws unless the published form is a real Ed25519 key, and
    // validation already proved it matches the private half.
    expect(() => decodeVerifyKey(active.verifyKey)).not.toThrow();
  });

  it('publishes a staged key before it signs anything', () => {
    const staged = stageMatrixSigningKey(identityKeys(), { now: 2_000 });
    expect(staged.version).toBe(2);
    expect(staged.keys.map(key => key.status)).toEqual([ 'active', 'pending' ]);
    expect(activeSigningKey(staged).keyId).toBe('ed25519:1');

    // Both the signing key and the staged key are verifiable, which is what lets a
    // peer cache the new key before the switch happens.
    const publication = publishableVerifyKeys(staged, 2_000);
    expect(Object.keys(publication.verify_keys)).toEqual([ 'ed25519:1', 'ed25519:2' ]);
    expect(publication.old_verify_keys).toEqual({});
  });

  it('moves the previous key to old_verify_keys with the moment it stopped signing', () => {
    const staged = stageMatrixSigningKey(identityKeys(), { now: 2_000 });
    const rotated = activateMatrixSigningKey(staged, 'ed25519:2', { now: 3_000, retentionMs: 7 * DAY });

    expect(rotated.version).toBe(3);
    expect(activeSigningKey(rotated).keyId).toBe('ed25519:2');
    const retired = rotated.keys.find(key => key.keyId === 'ed25519:1')!;
    expect(retired).toMatchObject({ status: 'retired', retiredAt: 3_000, expiresAt: 3_000 + 7 * DAY });

    const publication = publishableVerifyKeys(rotated, 3_000);
    expect(Object.keys(publication.verify_keys)).toEqual([ 'ed25519:2' ]);
    // `expired_ts` is when the key stopped being used, not when we stop publishing it.
    expect(publication.old_verify_keys['ed25519:1'].expired_ts).toBe(3_000);
    expect(publication.old_verify_keys['ed25519:1'].key).toBe(retired.verifyKey);
  });

  it('drops a retired key once its window has passed, and only then', () => {
    const rotated = activateMatrixSigningKey(
      stageMatrixSigningKey(identityKeys(), { now: 2_000 }), 'ed25519:2', { now: 3_000, retentionMs: DAY });

    expect(pruneExpiredSigningKeys(rotated, 3_000 + DAY)).toBe(rotated);
    const pruned = pruneExpiredSigningKeys(rotated, 3_000 + DAY + 1);
    expect(pruned.version).toBe(rotated.version + 1);
    expect(pruned.keys.map(key => key.keyId)).toEqual([ 'ed25519:2' ]);
    expect(publishableVerifyKeys(pruned, 3_000 + DAY + 1).old_verify_keys).toEqual({});
  });

  it('refuses to activate a key that is unknown, already retired, or already active twice', () => {
    const rotated = activateMatrixSigningKey(
      stageMatrixSigningKey(identityKeys(), { now: 2_000 }), 'ed25519:2', { now: 3_000, retentionMs: DAY });
    // Re-running the activation step is safe: an operator retry must not rotate again.
    expect(activateMatrixSigningKey(rotated, 'ed25519:2', { now: 4_000, retentionMs: DAY })).toBe(rotated);
    expect(() => activateMatrixSigningKey(rotated, 'ed25519:1', { now: 4_000, retentionMs: DAY }))
      .toThrow(/already retired/u);
    expect(() => activateMatrixSigningKey(rotated, 'ed25519:9', { now: 4_000, retentionMs: DAY }))
      .toThrow(/No such Matrix signing key/u);
    expect(() => activateMatrixSigningKey(rotated, 'ed25519:2', { now: 4_000, retentionMs: 0 }))
      .toThrow(/retention/u);
    expect(() => stageMatrixSigningKey(rotated, { now: 4_000, keyId: 'ed25519:2' }))
      .toThrow(/already exists/u);
  });

  it('keeps an event signed before a rotation verifiable afterwards', () => {
    const before = identityKeys(1_000);
    const oldKey = activeSigningKey(before);
    const signed = signEvent({
      type: 'm.room.message', room_id: '!r:example.test', sender: '@a:example.test',
      origin_server_ts: 1_500, content: { msgtype: 'm.text', body: 'before rotation' },
    }, { keyId: oldKey.keyId, privateKeyPem: oldKey.privateKeyPem }, 'example.test');

    const after = activateMatrixSigningKey(
      stageMatrixSigningKey(before, { now: 2_000 }), 'ed25519:2', { now: 3_000, retentionMs: 7 * DAY });
    const publication = publishableVerifyKeys(after, 4_000);

    // The retired key is still published, so the signature is verifiable from the key
    // response alone — this is the whole point of keeping it.
    expect(verifyJson(redactEvent(signed as Record<string, unknown>), 'example.test', oldKey.keyId,
      decodeVerifyKey(publication.old_verify_keys[oldKey.keyId].key))).toBe(true);
  });

  it('round-trips through storage and rejects a tampered payload', () => {
    const keySet = stageMatrixSigningKey(identityKeys(), { now: 2_000 });
    expect(decodeMatrixSigningKeySet(encodeMatrixSigningKeySet(keySet))).toEqual(keySet);

    const tampered = JSON.parse(encodeMatrixSigningKeySet(keySet));
    tampered.keys[1].verifyKey = tampered.keys[0].verifyKey;
    expect(() => decodeMatrixSigningKeySet(JSON.stringify(tampered))).toThrow(/does not match its verify key/u);

    expect(() => decodeMatrixSigningKeySet('{')).toThrow(/not valid JSON/u);
    expect(() => decodeMatrixSigningKeySet(JSON.stringify({ version: 1, keys: [] }))).toThrow(/at least one key/u);
  });

  it('rejects key sets that could not sign or verify unambiguously', () => {
    const keySet = identityKeys();
    const withTwoActives = { version: 2, keys: [
      keySet.keys[0],
      { ...keySet.keys[0], keyId: 'ed25519:2' },
    ] };
    expect(() => decodeMatrixSigningKeySet(JSON.stringify(withTwoActives))).toThrow(/exactly one active/u);

    const noActive = { version: 1, keys: [ { ...keySet.keys[0], status: 'pending' } ] };
    expect(() => decodeMatrixSigningKeySet(JSON.stringify(noActive))).toThrow(/exactly one active/u);

    const noPrivateKey = { version: 1, keys: [ { ...keySet.keys[0], privateKeyPem: undefined } ] };
    expect(() => decodeMatrixSigningKeySet(JSON.stringify(noPrivateKey))).toThrow(/missing its private key/u);

    const badStatus = { version: 1, keys: [ { ...keySet.keys[0], status: 'signing' } ] };
    expect(() => decodeMatrixSigningKeySet(JSON.stringify(badStatus))).toThrow(/unknown status/u);

    const retiredWithoutWindow = { version: 1, keys: [ { ...keySet.keys[0], status: 'retired' } ] };
    expect(() => decodeMatrixSigningKeySet(JSON.stringify(retiredWithoutWindow))).toThrow(/needs retiredAt/u);
  });

  it('builds an identity that signs with the active key and publishes the rest', () => {
    const staged = stageMatrixSigningKey(identityKeys(1_000), { now: 2_000 });
    const rotated = activateMatrixSigningKey(staged, 'ed25519:2', { now: 3_000, retentionMs: 7 * DAY });
    const identity = createMatrixServiceIdentityFromKeySet(rotated, { serverName: 'alice.example', now: () => 4_000 });

    expect(identity.keyId).toBe('ed25519:2');
    const response = identity.serverKeyResponse();
    expect(response.server_name).toBe('alice.example');
    // Only the active key is in verify_keys; the retired one moved to the old list.
    expect(Object.keys(response.verify_keys)).toEqual([ 'ed25519:2' ]);
    expect(Object.keys(response.old_verify_keys ?? {})).toEqual([ 'ed25519:1' ]);
    // The response verifies with the key it advertises.
    expect(verifyJson(response, 'alice.example', 'ed25519:2',
      decodeVerifyKey(response.verify_keys['ed25519:2'].key))).toBe(true);
    // And an event signed through it verifies against that published key.
    const signed = identity.signEvent({
      type: 'm.room.message', room_id: '!r:alice.example', sender: '@a:alice.example',
      origin_server_ts: 4_100, content: { msgtype: 'm.text', body: 'after rotation' },
    });
    expect(verifyJson(redactEvent(signed), 'alice.example', 'ed25519:2',
      decodeVerifyKey(response.verify_keys['ed25519:2'].key))).toBe(true);
  });

  it('publishes a staged key through the identity without letting it sign', () => {
    const staged = stageMatrixSigningKey(createMatrixSigningKeySet({ now: 1_000 }), { now: 2_000 });
    const identity = createMatrixServiceIdentityFromKeySet(staged, { serverName: 'alice.example', now: () => 2_500 });
    expect(identity.keyId).toBe('ed25519:1');
    expect(Object.keys(identity.serverKeyResponse().verify_keys).sort()).toEqual([ 'ed25519:1', 'ed25519:2' ]);
    // The staged key is published but must not be the one that signs.
    expect(activateMatrixSigningKey(staged, 'ed25519:1', { now: 3_000, retentionMs: DAY })).toBe(staged);
  });
});
