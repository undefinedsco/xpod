import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, encodeCanonicalJson } from '../../../../src/api/matrix/protocol/canonicalJson';
import {
  computeContentHash,
  computeEventId,
  computeReferenceHash,
  decodeVerifyKey,
  encodeUnpaddedBase64,
  encodeUnpaddedBase64Url,
  encodeVerifyKey,
  redactEvent,
  signEvent,
  signJson,
  verifyJson,
} from '../../../../src/api/matrix/protocol/eventIntegrity';

function keyPair(keyId = 'ed25519:1') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    keyId,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

describe('Canonical JSON', () => {
  it('matches the specification vectors', () => {
    expect(encodeCanonicalJson({})).toBe('{}');
    expect(encodeCanonicalJson({ one: 1, two: 'Two' })).toBe('{"one":1,"two":"Two"}');
    expect(encodeCanonicalJson({ b: '2', a: '1' })).toBe('{"a":"1","b":"2"}');
  });

  it('keeps non-ASCII as UTF-8 and sorts keys by code point', () => {
    // 'emoji' < 'é' by code point: the specification forbids escaping either.
    expect(encodeCanonicalJson({ é: '中文', emoji: '😀' })).toBe('{"emoji":"😀","é":"中文"}');
    // U+FF3A (Ｚ) is below U+1F600 (😀) by code point, so it sorts first.
    expect(encodeCanonicalJson({ '\uFF3A': 1, '\u{1F600}': 2 })).toBe('{"Ｚ":1,"😀":2}');
  });

  it('uses only the escapes the grammar requires', () => {
    expect(encodeCanonicalJson({ s: 'a\nb\t"c"\\d' })).toBe('{"s":"a\\nb\\t\\"c\\"\\\\d"}');
    expect(encodeCanonicalJson({ s: '\u0001\u001f' })).toBe('{"s":"\\u0001\\u001f"}');
  });

  it('accepts safe integers and rejects everything the encoding excludes', () => {
    expect(encodeCanonicalJson({ n: 9007199254740991, m: -9007199254740991 })).toBe('{"m":-9007199254740991,"n":9007199254740991}');
    expect(() => encodeCanonicalJson({ n: 1.5 })).toThrow(CanonicalJsonError);
    expect(() => encodeCanonicalJson({ n: -0 })).toThrow(CanonicalJsonError);
    expect(() => encodeCanonicalJson({ n: 1e21 })).toThrow(CanonicalJsonError);
    expect(() => encodeCanonicalJson({ n: undefined })).toThrow(CanonicalJsonError);
  });
});

describe('event integrity', () => {
  const messageEvent = {
    type: 'm.room.message',
    room_id: '!room:example.org',
    sender: '@alice:example.org',
    origin_server_ts: 1_700_000_000_000,
    content: { msgtype: 'm.text', body: 'hello' },
    depth: 3,
    prev_events: [ '$prev' ],
    auth_events: [ '$auth' ],
  };

  it('derives the event ID from the reference hash as URL-safe unpadded base64', () => {
    const eventId = computeEventId(messageEvent);
    expect(eventId).toMatch(/^\$[A-Za-z0-9_-]+$/u);
    expect(eventId).toBe(`$${encodeUnpaddedBase64Url(computeReferenceHash(messageEvent))}`);
    // Stable across calls and independent of key order in the source object.
    const reordered = { ...messageEvent, content: { body: 'hello', msgtype: 'm.text' } };
    expect(computeEventId(reordered)).toBe(eventId);
  });

  it('excludes signatures, unsigned and event_id from the reference hash', () => {
    const withNoise = { ...messageEvent, unsigned: { age: 1 }, signatures: { 'example.org': { 'ed25519:1': 'sig' } } };
    expect(computeEventId(withNoise)).toBe(computeEventId(messageEvent));
    // The id is computed before it exists, so hashing a stored event that already
    // carries one must not fold it back into its own identity.
    const stored = { ...messageEvent, event_id: computeEventId(messageEvent) };
    expect(computeEventId(stored)).toBe(stored.event_id);
  });

  it('keeps unsigned out of the content hash but covers content', () => {
    const withUnsigned = { ...messageEvent, unsigned: { age: 1 } };
    expect(encodeUnpaddedBase64(computeContentHash(withUnsigned)))
      .toBe(encodeUnpaddedBase64(computeContentHash(messageEvent)));
    const changed = { ...messageEvent, content: { msgtype: 'm.text', body: 'hello!' } };
    expect(encodeUnpaddedBase64(computeContentHash(changed)))
      .not.toBe(encodeUnpaddedBase64(computeContentHash(messageEvent)));
  });

  it('applies the room v11 redaction content whitelist', () => {
    expect(redactEvent({ ...messageEvent, content: { msgtype: 'm.text', body: 'secret' } }).content).toEqual({});
    expect(redactEvent({
      type: 'm.room.member', room_id: '!room', sender: '@a:b', state_key: '@a:b',
      content: { membership: 'join', displayname: 'Alice', third_party_invite: { signed: { token: 't' }, other: 1 } },
    }).content).toEqual({ membership: 'join', third_party_invite: { signed: { token: 't' } } });
    expect(redactEvent({ type: 'm.room.create', content: { creator: '@a:b', extra: 1 } }).content)
      .toEqual({ creator: '@a:b', extra: 1 });
    expect(redactEvent({ type: 'm.room.power_levels', content: { users: {}, bogus: 1 } }).content).toEqual({ users: {} });
    // Keys outside the kept list never survive.
    expect(redactEvent({ ...messageEvent, unexpected: 'x' })).not.toHaveProperty('unexpected');
  });

  it('signs the redacted event, so the signature survives redaction', () => {
    const key = keyPair();
    const signed = signEvent(messageEvent, key, 'example.org');
    expect(signed.hashes).toEqual({ sha256: encodeUnpaddedBase64(computeContentHash(signed)) });

    // The signature covers the redacted event: that is what other servers see.
    const redacted = redactEvent(signed);
    expect(verifyJson(redacted, 'example.org', key.keyId, key.publicKeyPem)).toBe(true);
    // Signing the unredacted event would instead produce a signature that fails
    // here, which is exactly the bug this test guards.
    expect(verifyJson(signed, 'example.org', key.keyId, key.publicKeyPem)).toBe(false);

    // Wrong signer, wrong key id and missing signature all fail closed.
    expect(verifyJson(redacted, 'other.example', key.keyId, key.publicKeyPem)).toBe(false);
    expect(verifyJson(redacted, 'example.org', 'ed25519:9', key.publicKeyPem)).toBe(false);
    expect(verifyJson(messageEvent, 'example.org', key.keyId, key.publicKeyPem)).toBe(false);
  });

  it('keeps the signature valid when only unredacted content changes', () => {
    const key = keyPair();
    const signed = signEvent({ ...messageEvent, content: { msgtype: 'm.text', body: 'first' } }, key, 'example.org');
    // A message redacts to `{}`, so its body is outside the signed surface. The
    // content hash is what guards the payload, not the signature.
    const edited = { ...signed, content: { msgtype: 'm.text', body: 'edited' } };
    expect(verifyJson(redactEvent(edited), 'example.org', key.keyId, key.publicKeyPem)).toBe(true);
    expect(encodeUnpaddedBase64(computeContentHash(edited)))
      .not.toBe(encodeUnpaddedBase64(computeContentHash(signed)));
  });

  it('binds the signature to redacted fields that survive redaction', () => {
    const key = keyPair();
    const signed = signEvent(messageEvent, key, 'example.org');
    // `sender` survives redaction, so changing it must break the signature.
    const tampered = redactEvent({ ...signed, sender: '@mallory:example.org' });
    expect(verifyJson(tampered, 'example.org', key.keyId, key.publicKeyPem)).toBe(false);
  });

  it('ignores unsigned changes when verifying, as the specification requires', () => {
    const key = keyPair();
    const signed = signEvent(messageEvent, key, 'example.org');
    // `unsigned` is transport metadata: adding or changing it must not invalidate
    // the signature. Redaction drops it entirely, so the redacted form — the only
    // form a verifier ever sees — carries no trace of it.
    const withUnsigned = { ...signed, unsigned: { age_ts: 123 } };
    expect(redactEvent(withUnsigned)).not.toHaveProperty('unsigned');
    expect(verifyJson(redactEvent(withUnsigned), 'example.org', key.keyId, key.publicKeyPem)).toBe(true);
    expect(verifyJson(redactEvent({ ...withUnsigned, unsigned: { age_ts: 999 } }), 'example.org', key.keyId, key.publicKeyPem))
      .toBe(true);
  });

  it('hashes the content without the event id, which does not exist when a sender hashes', () => {
    // Room v4+ derives the id from the event, so implementations keep it beside
    // the event rather than inside it (Synapse caches the derived id and hashes
    // the parsed event, which has none). Hashing must therefore ignore an
    // attached id, or an event read back out of a Pod could never verify.
    const withId = { ...messageEvent, event_id: '$derived' };
    expect(encodeUnpaddedBase64(computeContentHash(withId)))
      .toBe(encodeUnpaddedBase64(computeContentHash(messageEvent)));
    const edited = { ...withId, content: { msgtype: 'm.text', body: 'changed' } };
    expect(encodeUnpaddedBase64(computeContentHash(edited)))
      .not.toBe(encodeUnpaddedBase64(computeContentHash(withId)));
  });

  it('signs and verifies a server key response payload', () => {
    const key = keyPair();
    const payload = { name: 'example.org', signing_keys: { [key.keyId]: encodeVerifyKey(key.publicKeyPem) } };
    const signature = signJson(payload, key);
    const response = { ...payload, signatures: { 'example.org': { [key.keyId]: signature } } };
    expect(verifyJson(response, 'example.org', key.keyId, key.publicKeyPem)).toBe(true);
    expect(verifyJson({ ...response, name: 'evil.example' }, 'example.org', key.keyId, key.publicKeyPem)).toBe(false);
  });

  it('publishes verify keys in the raw form servers exchange', () => {
    const key = keyPair();
    const published = encodeVerifyKey(key.publicKeyPem);
    expect(published).toMatch(/^[A-Za-z0-9+/]+$/u);
    const rebuilt = decodeVerifyKey(published);
    const signature = signJson({ name: 'example.org' }, key);
    expect(verifyJson({ name: 'example.org', signatures: { 'example.org': { [key.keyId]: signature } } },
      'example.org', key.keyId, rebuilt)).toBe(true);
    expect(() => decodeVerifyKey(encodeUnpaddedBase64(Buffer.alloc(16)))).toThrow();
  });
});
