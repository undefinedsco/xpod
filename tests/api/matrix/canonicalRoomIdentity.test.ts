import { describe, expect, it } from 'vitest';
import { chatResource } from '@undefineds.co/models';
import {
  decodeSourceBoundRoomId,
  encodeSourceBoundRoomId,
  parseCanonicalChatIri,
  registeredPodForChatIri,
  validateCanonicalChatIri,
  MATRIX_ROOM_ID_MAX_BYTES,
  SOURCE_BOUND_ROOM_PREFIX,
} from '../../../src/api/matrix/canonicalRoomIdentity';

const POD_A = 'https://pod-a.example/alice/';
const POD_B = 'https://pod-b.example/alice/';
const HOST_A = 'pod-a.example';

function chatIri(pod: string, key: string): string {
  return chatResource.buildIri(pod, { id: key });
}

describe('source-bound room identity codec', () => {
  it('encodes a canonical Chat IRI and decodes it back to the exact same IRI', () => {
    const iri = chatIri(POD_A, 'roomkey');
    const roomId = encodeSourceBoundRoomId(iri);
    expect(roomId.startsWith(SOURCE_BOUND_ROOM_PREFIX)).toBe(true);
    expect(roomId.endsWith(`:${HOST_A}`)).toBe(true);
    const decoded = decodeSourceBoundRoomId(roomId);
    expect(decoded).toEqual({ status: 'source-bound', canonicalChatIri: iri, host: HOST_A });
  });

  it('round-trips through the public model builder and locator exactly', () => {
    const iri = chatIri(POD_A, 'roundtrip');
    const decoded = decodeSourceBoundRoomId(encodeSourceBoundRoomId(iri));
    expect(decoded.status).toBe('source-bound');
    if (decoded.status !== 'source-bound') return;
    const parsed = parseCanonicalChatIri(decoded.canonicalChatIri);
    expect(parsed?.templateValues.key).toBe('roundtrip');
    expect(chatResource.buildIri(POD_A, { id: parsed!.templateValues.key })).toBe(iri);
  });

  it('gives different room ids to the same layout key on different Pods', () => {
    const a = encodeSourceBoundRoomId(chatIri(POD_A, 'shared-key'));
    const b = encodeSourceBoundRoomId(chatIri(POD_B, 'shared-key'));
    expect(a).not.toBe(b);
    expect(decodeSourceBoundRoomId(a)).toMatchObject({ host: 'pod-a.example' });
    expect(decodeSourceBoundRoomId(b)).toMatchObject({ host: 'pod-b.example' });
  });

  it('keeps the full WebID source out of the host suffix and never makes an owner shortcut', () => {
    // A room hosted by a different full WebID on the same host is a different Chat IRI and a
    // different room id, and the validator rejects it against the wrong Pod.
    const mine = chatIri(POD_A, 'owned');
    const roomId = encodeSourceBoundRoomId(mine);
    const decoded = decodeSourceBoundRoomId(roomId);
    expect(decoded.status).toBe('source-bound');
    if (decoded.status !== 'source-bound') return;
    // The full IRI is carried, not the WebID; the host alone never proves ownership.
    expect(validateCanonicalChatIri(decoded.canonicalChatIri, POD_A)).toEqual({ key: 'owned' });
    const otherPodSameHost = 'https://pod-a.example/bob/';
    expect(validateCanonicalChatIri(decoded.canonicalChatIri, otherPodSameHost)).toBeNull();
  });

  it('honours a port in the routing host suffix', () => {
    const pod = 'https://pod-a.example:8443/alice/';
    const iri = chatIri(pod, 'ported');
    const roomId = encodeSourceBoundRoomId(iri);
    expect(roomId.endsWith(':pod-a.example:8443')).toBe(true);
    const decoded = decodeSourceBoundRoomId(roomId);
    expect(decoded).toMatchObject({ status: 'source-bound', host: 'pod-a.example:8443' });
    expect(validateCanonicalChatIri(iri, pod)).toEqual({ key: 'ported' });
  });

  it('honours an IPv6 host suffix with multiple colons', () => {
    const pod = 'https://[2001:db8::1]:8443/alice/';
    const iri = chatIri(pod, 'v6');
    const roomId = encodeSourceBoundRoomId(iri);
    expect(roomId.endsWith(':[2001:db8::1]:8443')).toBe(true);
    const decoded = decodeSourceBoundRoomId(roomId);
    expect(decoded).toMatchObject({ status: 'source-bound', host: '[2001:db8::1]:8443' });
    expect(validateCanonicalChatIri(iri, pod)).toEqual({ key: 'v6' });
  });

  it('encodes a unicode key in canonical URL form and round-trips it', () => {
    const key = 'ключ-😀';
    const iri = chatResource.buildIri(POD_A, { id: key });
    const decoded = decodeSourceBoundRoomId(encodeSourceBoundRoomId(iri));
    expect(decoded.status).toBe('source-bound');
    if (decoded.status !== 'source-bound') return;
    // The exact stored IRI is what the shared builder produces, not a guessed re-encoding.
    expect(decoded.canonicalChatIri).toBe(iri);
    expect(validateCanonicalChatIri(decoded.canonicalChatIri, POD_A)).toEqual({ key });
  });

  it('reports a legacy id explicitly as not source-bound instead of guessing', () => {
    for (const legacy of [
      '!abcdef:alice.example',
      '!c1room:alice.example', // starts like c1 but is not the !c1_ prefix
      '!room:alice.example',
    ]) {
      expect(decodeSourceBoundRoomId(legacy)).toEqual({ status: 'not-source-bound' });
    }
  });

  it('rejects a well-formed URL that is not a canonical Chat layout resource', () => {
    for (const notChat of [
      'https://pod-a.example/not-a-chat#evil',
      'https://pod-a.example/alice/.data/chat/x/index.ttl#evil', // a Chat with a changed fragment
      'https://pod-a.example/alice/.data/chat/x/index.ttl', // no #this fragment
      'https://pod-a.example/alice/.data/chat/x/other.ttl#this', // wrong document name
      'https://pod-a.example/alice/.data/chat/./index.ttl#this',
    ]) {
      const roomId = `${SOURCE_BOUND_ROOM_PREFIX}${Buffer.from(notChat, 'utf8').toString('base64url')}:pod-a.example`;
      expect(() => decodeSourceBoundRoomId(roomId), notChat).toThrow();
    }
  });

  it('rejects a malformed percent-encoded key and an empty query marker', () => {
    for (const bad of [
      'https://pod-a.example/alice/.data/chat/%ZZ/index.ttl#this',
      'https://pod-a.example/alice/.data/chat/%FF/index.ttl#this',
      'https://pod-a.example/alice/.data/chat/x/index.ttl?#this', // empty query marker
      'https://pod-a.example/alice/.data/chat/x/index.ttl?x=1#this',
    ]) {
      const roomId = `${SOURCE_BOUND_ROOM_PREFIX}${Buffer.from(bad, 'utf8').toString('base64url')}:pod-a.example`;
      expect(() => decodeSourceBoundRoomId(roomId), bad).toThrow();
    }
  });

  it('refuses to encode a non-Chat IRI or a non-canonical host form', () => {
    for (const bad of [
      'https://pod-a.example/not-a-chat#evil',
      'https://pod-a.example/alice/.data/chat/x/index.ttl#evil',
      'https://POD-A.EXAMPLE/alice/.data/chat/x/index.ttl#this',
      'https://user:pass@pod-a.example/alice/.data/chat/x/index.ttl#this',
      'https://pod-a.example/alice/.data/chat/x/index.ttl?#this',
    ]) {
      expect(() => encodeSourceBoundRoomId(bad), bad).toThrow();
    }
    // The encoded result of a valid IRI is always decodable (no self-rejecting encode).
    const roomId = encodeSourceBoundRoomId(chatIri(POD_A, 'self-consistent'));
    expect(decodeSourceBoundRoomId(roomId).status).toBe('source-bound');
  });

  it('rejects a malformed percent-escape in a root, base or key, but keeps valid escapes', () => {
    // A broken escape in the Pod root segment must be rejected at every boundary.
    const badRoot = 'https://a/alice/%ZZ/';
    expect(() => encodeSourceBoundRoomId(`${badRoot}.data/chat/x/index.ttl#this`)).toThrow();
    expect(validateCanonicalChatIri(`${badRoot}.data/chat/x/index.ttl#this`, badRoot)).toBeNull();
    expect(registeredPodForChatIri(`${badRoot}.data/chat/x/index.ttl#this`, [ badRoot ])).toBeNull();
    const encodedBadRoot = `${SOURCE_BOUND_ROOM_PREFIX}${Buffer.from(`${badRoot}.data/chat/x/index.ttl#this`, 'utf8').toString('base64url')}:a`;
    expect(() => decodeSourceBoundRoomId(encodedBadRoot)).toThrow();

    // A valid percent-escape in the Pod *root* (`%25ZZ`) is syntactically fine: the key is a plain
    // `x`, and the root merely spells a valid octet.
    const percentRoot = 'https://a/alice/%25ZZ/';
    const iri = chatResource.buildIri(percentRoot, { id: 'x' });
    const decoded = decodeSourceBoundRoomId(encodeSourceBoundRoomId(iri));
    expect(decoded).toMatchObject({ status: 'source-bound', canonicalChatIri: iri });
    expect(validateCanonicalChatIri(iri, percentRoot)).toEqual({ key: 'x' });

    // An ordinary encoded key (space / Unicode) is the supported positive; it round-trips exactly.
    const encodedKeyIri = chatResource.buildIri(POD_A, { id: 'ключ 😀' });
    const keyDecoded = decodeSourceBoundRoomId(encodeSourceBoundRoomId(encodedKeyIri));
    expect(keyDecoded).toMatchObject({ status: 'source-bound', canonicalChatIri: encodedKeyIri });
    expect(validateCanonicalChatIri(encodedKeyIri, POD_A)).toEqual({ key: 'ключ 😀' });
  });

  it('round-trips a legal Chat under a registered root that itself contains the layout segment', () => {
    // The public parser was fixed to use the LAST layout occurrence for absolute HTTP(S) refs, so a
    // nested registered root that repeats `/.data/chat/` resolves to the correct key.
    const nestedRoot = 'https://a/alice/.data/chat/tenant/';
    const iri = chatResource.buildIri(nestedRoot, { id: 'nested-key' });
    const decoded = decodeSourceBoundRoomId(encodeSourceBoundRoomId(iri));
    expect(decoded).toMatchObject({ status: 'source-bound', canonicalChatIri: iri, host: 'a' });
    expect(validateCanonicalChatIri(iri, nestedRoot)).toEqual({ key: 'nested-key' });
    expect(registeredPodForChatIri(iri, [ nestedRoot ])).toBe(nestedRoot);
  });
});

describe('source-bound room identity strictness', () => {
  const iri = chatIri(POD_A, 'strict');

  function encodeRaw(decodedIri: string, host = HOST_A): string {
    return `${SOURCE_BOUND_ROOM_PREFIX}${Buffer.from(decodedIri, 'utf8').toString('base64url')}:${host}`;
  }

  it('rejects a malformed !c1_ id rather than falling back to legacy', () => {
    for (const bad of [
      '!c1_', // no encoded component or host
      '!c1_:host.example', // empty encoded component
      '!c1_abc', // no host separator
      '!c1_@@@:host.example', // not base64url
      '!c1_abc:', // empty host
    ]) {
      expect(() => decodeSourceBoundRoomId(bad), bad).toThrow();
    }
  });

  it('rejects padding, trailing-bit, and invalid-UTF-8 distortions', () => {
    const base64 = Buffer.from(iri, 'utf8').toString('base64url');
    // An embedded padding character is not base64url.
    expect(() => decodeSourceBoundRoomId(`${SOURCE_BOUND_ROOM_PREFIX}${base64}=:${HOST_A}`)).toThrow();
    // A single extra trailing character changes the bytes; the re-encode guard catches it.
    expect(() => decodeSourceBoundRoomId(`${SOURCE_BOUND_ROOM_PREFIX}${base64}A:${HOST_A}`)).toThrow();
    // Invalid UTF-8: a lone 0xFF byte cannot decode.
    const invalidUtf8 = Buffer.from([ 0xff, 0xfe, 0xfd ]).toString('base64url');
    expect(() => decodeSourceBoundRoomId(`${SOURCE_BOUND_ROOM_PREFIX}${invalidUtf8}:${HOST_A}`)).toThrow();
  });

  it('rejects a host suffix that does not exactly match the encoded IRI host', () => {
    const roomId = encodeSourceBoundRoomId(iri);
    const tampered = `${roomId.slice(0, roomId.lastIndexOf(':') + 1)}evil.example`;
    expect(() => decodeSourceBoundRoomId(tampered)).toThrow();
  });

  it('rejects a query, credentials, non-HTTP scheme, or non-canonical form', () => {
    // The query must be before the fragment to be a real query, not part of the fragment.
    const document = iri.split('#')[0];
    expect(() => decodeSourceBoundRoomId(encodeRaw(`${document}?x=1`))).toThrow();
    expect(() => decodeSourceBoundRoomId(encodeRaw(iri.replace('https://', 'https://user:pass@')))).toThrow();
    expect(() => decodeSourceBoundRoomId(encodeRaw(iri.replace('https://', 'ftp://')))).toThrow();
    // A non-canonical spelling (uppercase host) must not round-trip as canonical.
    expect(() => decodeSourceBoundRoomId(encodeRaw(iri.replace('pod-a.example', 'POD-A.EXAMPLE'), 'POD-A.EXAMPLE'))).toThrow();
  });

  it('rejects a non-Chat path or an unexpected fragment', () => {
    expect(validateCanonicalChatIri('https://pod-a.example/alice/.data/other/x/index.ttl#this', POD_A)).toBeNull();
    expect(validateCanonicalChatIri('https://pod-a.example/alice/.data/chat/x/index.ttl#other', POD_A)).toBeNull();
    expect(validateCanonicalChatIri('https://pod-a.example/alice/.data/chat/x/index.ttl', POD_A)).toBeNull();
  });

  it('rejects an overlong room id explicitly', () => {
    const longKey = 'k'.repeat(300);
    const longIri = chatIri(POD_A, longKey);
    expect(() => encodeSourceBoundRoomId(longIri)).toThrow(/255/);
    // The decode side applies the same limit and never truncates.
    const overlong = `${SOURCE_BOUND_ROOM_PREFIX}${Buffer.from(longIri, 'utf8').toString('base64url')}:${HOST_A}`;
    expect(Buffer.byteLength(overlong, 'utf8')).toBeGreaterThan(MATRIX_ROOM_ID_MAX_BYTES);
    expect(() => decodeSourceBoundRoomId(overlong)).toThrow(/255/);
  });

  it('decodes without any SQL lookup so an index wipe cannot change the canonical origin', () => {
    const roomId = encodeSourceBoundRoomId(iri);
    // The decode path touches no database: calling it repeatedly yields the identical origin.
    const first = decodeSourceBoundRoomId(roomId);
    const second = decodeSourceBoundRoomId(roomId);
    expect(second).toEqual(first);
  });
});

describe('registered Pod selection', () => {
  it('picks the longest registered Pod prefix that is a real origin/root-segment match', () => {
    const iri = chatIri(POD_A, 'nested');
    // Two candidates share a host; only the exact registered root validates.
    const longer = 'https://pod-a.example/alice/tenant/';
    expect(registeredPodForChatIri(iri, [ POD_A, longer ])).toBe(POD_A);
    expect(registeredPodForChatIri(iri, [ longer ])).toBeNull();
  });

  it('rejects a same-host different root segment boundary', () => {
    const iri = chatIri(POD_A, 'boundary');
    // `alice-other/` must not be treated as a prefix of `alice/`.
    expect(validateCanonicalChatIri(iri, 'https://pod-a.example/alice-other/')).toBeNull();
    expect(validateCanonicalChatIri(iri, 'https://pod-a.example/')).toBeNull();
  });

  it('never treats a full WebID candidate as a registered Pod root', () => {
    const iri = chatIri(POD_A, 'webid-candidate');
    const webIdCandidate = 'https://pod-a.example/alice/profile/card#me';
    // A WebID is not a Pod root: it must be rejected as a candidate, and the real root wins.
    expect(validateCanonicalChatIri(iri, webIdCandidate)).toBeNull();
    expect(registeredPodForChatIri(iri, [ webIdCandidate, POD_A ])).toBe(POD_A);
    expect(registeredPodForChatIri(iri, [ webIdCandidate ])).toBeNull();
  });

  it('rejects non-canonical, empty-query, or non-trailing-slash root candidates without throwing', () => {
    const iri = chatIri(POD_A, 'candidate-form');
    for (const bad of [
      'https://pod-a.example/alice', // no trailing slash
      'https://pod-a.example/alice/?x=1',
      'https://pod-a.example/alice/#frag',
      'https://user:pass@pod-a.example/alice/',
      'https://POD-A.EXAMPLE/alice/',
      'https://pod-a.example:443/alice/', // default port normalisation surprise
      'not a url',
    ]) {
      expect(validateCanonicalChatIri(iri, bad), bad).toBeNull();
    }
    // A malformed optional candidate must not make the locator throw when a valid root is present.
    expect(registeredPodForChatIri(iri, [ 'not a url', POD_A ])).toBe(POD_A);
  });

  it('requires the root candidate to end at a path-segment boundary', () => {
    const iri = chatIri(POD_A, 'segment');
    expect(validateCanonicalChatIri(iri, 'https://pod-a.example/alice')).toBeNull();
    expect(validateCanonicalChatIri(iri, 'https://pod-a.example/alice/')).toEqual({ key: 'segment' });
  });
});
