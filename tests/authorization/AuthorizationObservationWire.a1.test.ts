import { describe, expect, it } from 'vitest';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import {
  AUTHORIZATION_OBSERVATION_PROFILE,
  parseAuthorizationObservationRequest,
  physicalDocumentIriOf,
  serializeAuthorizationObservationResponse,
} from '../../src/storage/rdf/AuthorizationObservation';
import { digestGroundSource } from '../../src/storage/rdf/GuardedPolicySnapshot';

const { namedNode, literal, quad, defaultGraph } = DataFactory;
const CONTEXT = 'a'.repeat(64);
const CHALLENGE = 'b'.repeat(32);
const DIGEST = 'c'.repeat(64);

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    profile: AUTHORIZATION_OBSERVATION_PROFILE,
    sourceIri: 'http://localhost/room/doc#msg',
    expectedSourceDigest: DIGEST,
    targetWebId: 'https://agent.example/profile#me',
    contextDigest: CONTEXT,
    challenge: CHALLENGE,
    ...overrides,
  };
}

describe('A1 authorization observation closed wire', () => {
  it('parses the exact closed record and keeps the full source fragment', () => {
    const parsed = parseAuthorizationObservationRequest(request());
    expect(parsed.profile).toBe(AUTHORIZATION_OBSERVATION_PROFILE);
    expect(parsed.sourceIri).toBe('http://localhost/room/doc#msg');
    expect(physicalDocumentIriOf(parsed.sourceIri)).toBe('http://localhost/room/doc');
  });

  it('refuses extra keys, wrong version and malformed digests', () => {
    expect(() => parseAuthorizationObservationRequest(request({ extra: true }))).toThrow();
    expect(() => parseAuthorizationObservationRequest(request({ version: 2 }))).toThrow();
    expect(() => parseAuthorizationObservationRequest(request({ expectedSourceDigest: 'xyz' }))).toThrow();
    expect(() => parseAuthorizationObservationRequest(request({ challenge: 'A'.repeat(32) }))).toThrow();
  });

  it('refuses credential-bearing or non-canonical IRIs', () => {
    expect(() => parseAuthorizationObservationRequest(request({ sourceIri: 'http://user:pass@localhost/room#m' }))).toThrow();
    expect(() => parseAuthorizationObservationRequest(request({ targetWebId: 'not a url' }))).toThrow();
  });

  it('keeps a full WebID identity query and fragment byte-for-byte, distinct from its query-free spelling', () => {
    const target = 'https://agent.example/profile/bob-card?account=bob#me';
    const plain = 'https://agent.example/profile/bob-card#me';
    expect(parseAuthorizationObservationRequest(request({ targetWebId: target })).targetWebId).toBe(target);
    expect(parseAuthorizationObservationRequest(request({ targetWebId: plain })).targetWebId).toBe(plain);
    expect(target).not.toBe(plain);
  });

  it('keeps source/document routing strict while admitting identity queries', () => {
    expect(() => parseAuthorizationObservationRequest(request({ sourceIri: 'http://localhost/room/doc?q=1#msg' }))).toThrow();
    expect(parseAuthorizationObservationRequest(request({ sourceIri: 'http://localhost/room/doc#msg' })).sourceIri)
      .toBe('http://localhost/room/doc#msg');
  });

  it('still refuses credential-bearing, escaped and non-canonical identity WebIDs', () => {
    expect(() => parseAuthorizationObservationRequest(request({ targetWebId: 'https://user:pass@agent.example/profile?x=1#me' }))).toThrow();
    expect(() => parseAuthorizationObservationRequest(request({ targetWebId: 'https://agent.example/profile%2fescape?x=1#me' }))).toThrow();
    expect(() => parseAuthorizationObservationRequest(request({ targetWebId: 'HTTPS://agent.example/profile?x=1#me' }))).toThrow();
  });

  it('serializes exactly the response keys in order', () => {
    const payload = serializeAuthorizationObservationResponse({
      version: 1,
      profile: AUTHORIZATION_OBSERVATION_PROFILE,
      requesterWebId: 'https://owner.example/#me',
      targetWebId: 'https://agent.example/#me',
      sourceIri: 'http://localhost/room/doc#msg',
      sourceDigest: DIGEST,
      contextDigest: CONTEXT,
      challenge: CHALLENGE,
      guard: { profile: 'acp-ground-v1', scope: 'http://localhost/room/', resources: [], ancestors: [], policies: [] },
      read: [ { iri: 'http://localhost/room/', allowed: true } ],
    });
    expect(Object.keys(JSON.parse(payload))).toEqual([
      'version', 'profile', 'requesterWebId', 'targetWebId', 'sourceIri', 'sourceDigest', 'contextDigest', 'challenge', 'guard', 'read',
    ]);
  });
});

describe('A1 ground source digest', () => {
  const physical = 'http://localhost/room/doc';
  const full = `${physical}#msg`;
  const a = quad(namedNode(`${full}#s`), namedNode('http://ex/p'), literal('1'), defaultGraph()) as Quad;
  const b = quad(namedNode(`${full}#s`), namedNode('http://ex/p'), literal('two', 'en'), defaultGraph()) as Quad;

  it('is stable across quad order and duplicates, and fragment-sensitive', () => {
    const base = digestGroundSource(full, physical, [ a, b ]);
    expect(digestGroundSource(full, physical, [ b, a, a ])).toBe(base);
    expect(digestGroundSource(`${physical}#other`, physical, [ a, b ])).not.toBe(base);
  });

  it('binds literal lexical form and preserves language identity', () => {
    const changedLexical = quad(namedNode(`${full}#s`), namedNode('http://ex/p'), literal('01'), defaultGraph()) as Quad;
    expect(digestGroundSource(full, physical, [ a, changedLexical ])).not.toBe(digestGroundSource(full, physical, [ a, b ]));
  });

  it('refuses a foreign named graph', () => {
    const foreign = quad(namedNode(`${full}#s`), namedNode('http://ex/p'), literal('1'), namedNode('http://localhost/other')) as Quad;
    expect(() => digestGroundSource(full, physical, [ foreign ])).toThrow();
  });
});
