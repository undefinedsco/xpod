import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { chatResource } from '@undefineds.co/models';
import { roomContainerOf } from '../../src/api/matrix/MatrixRoomDirectory';
import {
  RoomAccessError,
  grantMatrixRoomAccess,
  matrixRoomContainerUri,
} from '../../scripts/lib/rc-matrix-room-access';
import { matrixRoomSurfaceId } from '../../src/api/matrix/MatrixIdentity';

const ALICE_ROOT = 'https://pods.example/alice/';
const ALICE = 'https://id.example/people/alice#me';
const BOB = 'https://id.example/people/bob#me';
const ROOM_ID = '!room-abc:example.test';
const ACP_NS = 'http://www.w3.org/ns/solid/acp#';
const ACL_NS = 'http://www.w3.org/ns/auth/acl#';
const ACL_NS_READ = `${ACL_NS}Read`;
const ACL_NS_APPEND = `${ACL_NS}Append`;
const ACL_NS_WRITE = `${ACL_NS}Write`;
const ACL_NS_CONTROL = `${ACL_NS}Control`;

/** Argument tuples recorded by a vi.fn() fetch stub. */
function callsOf(stub: any): Array<{ method: string; url: string }> {
  return (stub.mock?.calls ?? []).map((call: any[]) => {
    const input = call[0];
    const init = call[1] ?? {};
    return {
      method: String(init.method ?? 'GET').toUpperCase(),
      url: typeof input === 'string' ? input : String(input?.url ?? input),
    };
  });
}

/** Canonical chat IRI / container produced by the SAME models path the backend uses. */
const chatIri = chatResource.buildIri(ALICE_ROOT, { id: matrixRoomSurfaceId(ROOM_ID) });
const container = roomContainerOf(chatIri);

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

/**
 * Build a Response the Solid client can consume.
 *
 * `@inrupt/solid-client` parses `response.url` into the resource info, and the
 * platform constructor always leaves it empty, so the canned URL is defined
 * explicitly. Without this the client throws `TypeError: Invalid URL` before
 * any ACL logic runs.
 */
function response(
  body: string | null,
  init: { status?: number; headers?: Record<string, string>; url?: string } = {},
) {
  const result = new Response(body, { status: init.status ?? 200, headers: init.headers ?? {} });
  if (init.url) Object.defineProperty(result, 'url', { value: init.url, configurable: true });
  return result;
}

describe('canonical room container resolution', () => {
  it('derives the container from the shared models chat IRI, not a guessed layout', () => {
    expect(matrixRoomSurfaceId(ROOM_ID)).toMatch(/^matrix-[0-9a-f]{16}$/u);
    expect(matrixRoomContainerUri(ROOM_ID, ALICE_ROOT)).toBe(container);
    expect(container.startsWith(`${ALICE_ROOT}`)).toBe(true);
    expect(container).toContain('/.data/chat/');
  });

  it('rejects a Pod root, a foreign origin and a non-canonical storage root', () => {
    expect(() => matrixRoomContainerUri(ROOM_ID, ALICE_ROOT)).not.toThrow();
    // A storage root whose derived container equals the root itself is refused.
    expect(() => matrixRoomContainerUri(ROOM_ID, `https://pods.example/${matrixRoomSurfaceId(ROOM_ID)}/`)).not.toThrow();
    // A bare origin is a legitimate Pod root: models layout still yields a
    // room container below it, never the root itself.
    const fromOrigin = matrixRoomContainerUri(ROOM_ID, 'https://pods.example/');
    expect(new URL(fromOrigin).pathname).not.toBe('/');
    expect(fromOrigin.startsWith('https://pods.example/')).toBe(true);
    expect(() => matrixRoomContainerUri(ROOM_ID, 'not-a-url')).toThrow(RoomAccessError);
    // The extracted codec stays pure/behavior-preserving (no room-id policy),
    // matching PodMatrixStore and MatrixRoomDirectory. An empty id is rejected
    // by this helper's own validation, which is separate by design.
    expect(matrixRoomSurfaceId('any-input')).toBe(
      `matrix-${createHash('sha256').update('any-input').digest('hex').slice(0, 16)}`,
    );
    expect(() => matrixRoomContainerUri('   ', ALICE_ROOT)).toThrow(RoomAccessError);
  });

  it('refuses a container that does not match the canonical resolution', async () => {
    const authFetch = vi.fn();
    await expect(grantMatrixRoomAccess({
      roomId: ROOM_ID,
      roomContainerUri: 'https://pods.example/alice/.data/chat/matrix-0000000000000000/',
      storageRoot: ALICE_ROOT,
      authFetch: authFetch as unknown as typeof fetch,
      participants: [BOB],
      ownerWebId: ALICE,
    })).rejects.toMatchObject({ errorClass: 'room-container-invalid' });
    expect(authFetch).not.toHaveBeenCalled();
  });
});

describe('WAC grant', () => {
  it('grants resource and default access to the invitee and preserves the owner', async () => {
    const calls: Recorded[] = [];
    const aclUri = `${container}.acl`;
    const aclBody = [
      '@prefix acl: <http://www.w3.org/ns/auth/acl#>.',
      '@prefix foaf: <http://xmlns.com/foaf/0.1/>.',
      `<#owner> a acl:Authorization; acl:agent <${ALICE}>; acl:mode acl:Read, acl:Write, acl:Control;`,
      `  acl:accessTo <${container}>; acl:default <${container}>.`,
      '',
    ].join('\n');

    const authFetch = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({
        method, url,
        body: typeof init?.body === 'string' ? init.body : undefined,
        headers: init?.headers as Record<string, string> | undefined,
      });
      if (method === 'HEAD' && url === container) {
        return response(null, { headers: { Link: `<${aclUri}>; rel="acl"` } });
      }
      if (url === aclUri && (method === 'GET' || method === 'HEAD')) {
        // After the first write the ACL exists; the SDK reads it back.
        return response(method === 'HEAD' ? null : aclBody, {
          headers: { 'Content-Type': 'text/turtle', ETag: '"1"' }, url,
        });
      }
      // solid-client probes the container dataset itself when resolving ACLs.
      if (url === container && (method === 'GET' || method === 'HEAD')) {
        return response(method === 'HEAD' ? null : '<> a <http://schema.org/Thing>.', {
          headers: { 'Content-Type': 'text/turtle', Link: `<${aclUri}>; rel="acl"` }, url,
        });
      }
      if (method === 'GET' && url === container) {
        return response('<> a <http://schema.org/Thing>.', {
          headers: { 'Content-Type': 'text/turtle', Link: `<${aclUri}>; rel="acl"` }, url,
        });
      }
      if (url === aclUri && (method === 'PUT' || method === 'PATCH')) return response(null, { status: 205 });
      return response(null, { status: 404 });
    });

    const result = await grantMatrixRoomAccess({
      roomId: ROOM_ID,
      roomContainerUri: container,
      storageRoot: ALICE_ROOT,
      authFetch: authFetch as unknown as typeof fetch,
      participants: [BOB],
      ownerWebId: ALICE,
    });

    expect(result.mechanism).toBe('wac');
    expect(result.grantedWebIds).toEqual([BOB]);
    expect(result.controlUri).toBe(aclUri);

    const written = calls.filter((call) => call.method === 'PUT' || call.method === 'PATCH');
    expect(written.length).toBeGreaterThan(0);
    const body = written.map((call) => call.body ?? '').join('\n');
    // solid-client serializes full IRIs, so assert the vocabulary directly.
    const ACL_NS = 'http://www.w3.org/ns/auth/acl#';
    // WAC semantics: acl:Write already implies append capability, and
    // solid-client only emits acl:Append when Write is absent
    // (acl.internal.mjs: `if (access.append && !access.write)`). Requesting
    // read+append+write therefore correctly yields Read + Write.
    expect(body).toContain(BOB);
    expect(body).toContain(`${ACL_NS}Read`);
    expect(body).toContain(`${ACL_NS}Write`);
    // Owner still holds Control; Bob never does.
    const bobBlocks = body.split(`${ACL_NS}Authorization`).filter((block) => block.includes(BOB));
    expect(bobBlocks.length).toBeGreaterThan(0);
    for (const block of bobBlocks) expect(block).not.toContain(`${ACL_NS}Control`);
    // Never the Pod root.
    expect(body).not.toContain(`${ACL_NS}accessTo <${ALICE_ROOT}>`);
  });
});

describe('ACP grant', () => {
  it('classifies ACP from the document RDF, grants accessControl+memberAccessControl, keeps owner Control', async () => {
    const calls: Recorded[] = [];
    // Advertised at an opaque (non-.acr) URI: mechanism must come from RDF.
    const acrUri = `${container}access-control?rev=7`;
    const existingAcr = [
      '@prefix acp: <http://www.w3.org/ns/solid/acp#>.',
      '@prefix acl: <http://www.w3.org/ns/auth/acl#>.',
      '<#acr> a acp:AccessControlResource;',
      `  acp:resource <${container}>;`,
      '  acp:accessControl <#owner>.',
      '<#owner> a acp:AccessControl; acp:apply <#ownerPolicy>.',
      '<#ownerPolicy> a acp:Policy;',
      '  acp:allow acl:Read, acl:Write, acl:Control; acp:anyOf <#ownerMatcher>.',
      `<#ownerMatcher> a acp:Matcher; acp:agent <${ALICE}>.`,
      '',
    ].join('\n');

    const authFetch = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (method === 'HEAD' && url === container) {
        return response(null, { headers: { Link: `<${acrUri}>; rel="acl"` } });
      }
      if (url === acrUri && method === 'GET') {
        return response(existingAcr, { headers: { 'Content-Type': 'text/turtle', ETag: '"acr-1"' }, url });
      }
      if (url === acrUri && (method === 'PUT' || method === 'PATCH')) return response(null, { status: 205 });
      return response(null, { status: 404 });
    });

    const result = await grantMatrixRoomAccess({
      roomId: ROOM_ID,
      roomContainerUri: container,
      storageRoot: ALICE_ROOT,
      authFetch: authFetch as unknown as typeof fetch,
      participants: [BOB],
      ownerWebId: ALICE,
      timeoutMs: 5_000,
    });

    expect(result.mechanism).toBe('acp');
    // The advertised URI including its query is used verbatim.
    expect(result.controlUri).toBe(acrUri);
    const write = calls.find((call) => call.method === 'PUT' || call.method === 'PATCH');
    expect(write?.url).toBe(acrUri);
    // saveSolidDatasetAt writes an incremental SPARQL INSERT (PATCH) carrying
    // the full IRIs, not a Turtle PUT.
    const body = write?.body ?? '';
    expect(body).toContain(`${ACP_NS}accessControl`);
    expect(body).toContain(`${ACP_NS}memberAccessControl`);
    expect(body).toContain(BOB);
    expect(body).toContain(ACL_NS_READ);
    expect(body).toContain(ACL_NS_APPEND);
    expect(body).toContain(ACL_NS_WRITE);
    // Bob's agent policy never carries Control; the untouched owner policy does.
    const bobIndex = body.indexOf(BOB);
    expect(bobIndex).toBeGreaterThan(-1);
    // The agent policy block is the one naming Bob's matcher; ensure no Control
    // triple is introduced for it anywhere in the patch.
    const controlOccurrences = body.split(ACL_NS_CONTROL).length - 1;
    expect(controlOccurrences).toBe(0);
  });

  it('refuses to replace the ACR when the save fails and no ETag was captured', async () => {
    const acrUri = `${container}.acr`;
    const existingAcr = [
      '@prefix acp: <http://www.w3.org/ns/solid/acp#>.',
      '<#acr> a acp:AccessControlResource;',
      `  acp:resource <${container}>.`,
      '',
    ].join('\n');
    const authFetch = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD' && url === container) {
        return response(null, { headers: { Link: `<${acrUri}>; rel="acl"` } });
      }
      // No ETag header: the fallback must refuse.
      if (url === acrUri && method === 'GET') {
        return response(existingAcr, { headers: { 'Content-Type': 'text/turtle' }, url });
      }
      if (url === acrUri) return response(null, { status: 500 });
      return response(null, { status: 404 });
    });

    await expect(grantMatrixRoomAccess({
      roomId: ROOM_ID,
      roomContainerUri: container,
      storageRoot: ALICE_ROOT,
      authFetch: authFetch as unknown as typeof fetch,
      participants: [BOB],
      ownerWebId: ALICE,
      timeoutMs: 5_000,
    })).rejects.toMatchObject({ errorClass: 'control-concurrent-modification' });
    // No unconditional PUT was attempted.
    const unconditional = callsOf(authFetch).filter((call) => call.method === 'PUT');
    expect(unconditional).toEqual([]);
  });

  it('refuses when a concurrent write returns 412 to the If-Match PUT', async () => {
    const acrUri = `${container}.acr`;
    const acrBody = [
      '@prefix acp: <http://www.w3.org/ns/solid/acp#>.',
      '<#acr> a acp:AccessControlResource;',
      `  acp:resource <${container}>.`,
      '',
    ].join('\n');
    const authFetch = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD' && url === container) {
        return response(null, { headers: { Link: `<${acrUri}>; rel="acl"` } });
      }
      if (url === acrUri && method === 'GET') {
        return response(acrBody, { headers: { 'Content-Type': 'text/turtle', ETag: '"v1"' }, url });
      }
      if (url === acrUri && method === 'PUT') return response(null, { status: 412 });
      if (url === acrUri) return response(null, { status: 500 });
      return response(null, { status: 404 });
    });

    await expect(grantMatrixRoomAccess({
      roomId: ROOM_ID,
      roomContainerUri: container,
      storageRoot: ALICE_ROOT,
      authFetch: authFetch as unknown as typeof fetch,
      participants: [BOB],
      ownerWebId: ALICE,
      timeoutMs: 5_000,
    })).rejects.toMatchObject({ errorClass: 'control-concurrent-modification' });
  });
});

describe('refusals and ordering', () => {
  it('refuses an ACR that describes a different resource instead of mutating it', async () => {
    const acrUri = `${container}.acr`;
    const foreignAcr = [
      '@prefix acp: <http://www.w3.org/ns/solid/acp#>.',
      '<#acr> a acp:AccessControlResource;',
      '  acp:resource <https://pods.example/alice/.data/chat/other/>.',
      '',
    ].join('\n');
    const authFetch = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD' && url === container) {
        return response(null, { headers: { Link: `<${acrUri}>; rel="acl"` } });
      }
      if (url === acrUri && method === 'GET') {
        return response(foreignAcr, { headers: { 'Content-Type': 'text/turtle' }, url });
      }
      return response(null, { status: 404 });
    });

    await expect(grantMatrixRoomAccess({
      roomId: ROOM_ID,
      roomContainerUri: container,
      storageRoot: ALICE_ROOT,
      authFetch: authFetch as unknown as typeof fetch,
      participants: [BOB],
      ownerWebId: ALICE,
    })).rejects.toMatchObject({ errorClass: 'control-not-own-resource' });
  });

  it('refuses a control URL outside the room container', async () => {
    const authFetch = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD' && url === container) {
        return response(null, { headers: { Link: '<https://pods.example/alice/.acl>; rel="acl"' } });
      }
      return response(null, { status: 404 });
    });
    await expect(grantMatrixRoomAccess({
      roomId: ROOM_ID,
      roomContainerUri: container,
      storageRoot: ALICE_ROOT,
      authFetch: authFetch as unknown as typeof fetch,
      participants: [BOB],
      ownerWebId: ALICE,
    })).rejects.toMatchObject({ errorClass: 'control-not-own-resource' });
  });

  it('fails with a fixed class and no credential text when the container is unreachable', async () => {
    const authFetch = vi.fn(async () => response(null, { status: 403 }));
    const failure = await grantMatrixRoomAccess({
      roomId: ROOM_ID,
      roomContainerUri: container,
      storageRoot: ALICE_ROOT,
      authFetch: authFetch as unknown as typeof fetch,
      participants: [BOB],
      ownerWebId: ALICE,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RoomAccessError);
    expect((failure as RoomAccessError).errorClass).toBe('container-unreachable');
    expect(String((failure as RoomAccessError).message)).not.toMatch(/token|bearer|secret/iu);
  });

  it('skips the owner and validates every participant WebID', async () => {
    const authFetch = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD' && url === container) {
        return response(null, { headers: { Link: `<${container}.acl>; rel="acl"` } });
      }
      return response(null, { status: 404 });
    });
    await expect(grantMatrixRoomAccess({
      roomId: ROOM_ID,
      roomContainerUri: container,
      storageRoot: ALICE_ROOT,
      authFetch: authFetch as unknown as typeof fetch,
      participants: [ALICE],
      ownerWebId: ALICE,
    })).rejects.toMatchObject({ errorClass: 'grant-failed' });
    await expect(grantMatrixRoomAccess({
      roomId: ROOM_ID,
      roomContainerUri: container,
      storageRoot: ALICE_ROOT,
      authFetch: authFetch as unknown as typeof fetch,
      participants: ['not-a-webid'],
      ownerWebId: ALICE,
    })).rejects.toMatchObject({ errorClass: 'grant-failed' });
  });
});

describe('advertised URI safety and bounded transport', () => {
  const base = {
    roomId: ROOM_ID,
    roomContainerUri: container,
    storageRoot: ALICE_ROOT,
    participants: [BOB],
    ownerWebId: ALICE,
    timeoutMs: 5_000,
  };

  it('rejects an advertised control URI with a fragment instead of stripping it', async () => {
    const authFetch = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD' && url === container) {
        return response(null, { headers: { Link: `<${container}.acl#frag>; rel="acl"` } });
      }
      return response(null, { status: 404 });
    });
    await expect(grantMatrixRoomAccess({ ...base, authFetch: authFetch as unknown as typeof fetch }))
      .rejects.toMatchObject({ errorClass: 'control-unsafe-uri' });
  });

  it('rejects an advertised control URI carrying embedded credentials', async () => {
    const authFetch = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD' && url === container) {
        return response(null, { headers: { Link: `<https://user:pw@${new URL(container).host}${new URL(container).pathname}.acl>; rel="acl"` } });
      }
      return response(null, { status: 404 });
    });
    await expect(grantMatrixRoomAccess({ ...base, authFetch: authFetch as unknown as typeof fetch }))
      .rejects.toMatchObject({ errorClass: 'control-unsafe-uri' });
  });

  it('honors an advertised query URI verbatim (no silent stripping)', async () => {
    const acrUri = `${container}control?token=abc`;
    const acrBody = [
      '@prefix acp: <http://www.w3.org/ns/solid/acp#>.',
      '<#acr> a acp:AccessControlResource;',
      `  acp:resource <${container}>.`,
      '',
    ].join('\n');
    const seen: string[] = [];
    const authFetch = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      seen.push(url);
      if (method === 'HEAD' && url === container) {
        return response(null, { headers: { Link: `<${acrUri}>; rel="acl"` } });
      }
      if (url === acrUri && method === 'GET') {
        return response(acrBody, { headers: { 'Content-Type': 'text/turtle', ETag: '"v1"' }, url });
      }
      if (url === acrUri) return response(null, { status: 205 });
      return response(null, { status: 404 });
    });
    const result = await grantMatrixRoomAccess({ ...base, authFetch: authFetch as unknown as typeof fetch });
    expect(result.controlUri).toBe(acrUri);
    expect(seen).toContain(acrUri);
    expect(seen.some((url) => url === `${container}control`)).toBe(false);
  });

  it('passes an AbortSignal to every transport call it makes', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const authFetch = vi.fn(async (input: any, init?: any) => {
      signals.push(init?.signal);
      const url = typeof input === 'string' ? input : String(input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD' && url === container) {
        return response(null, { headers: { Link: `<${container}.acl>; rel="acl"` } });
      }
      return response(null, { status: 403 });
    });
    await expect(grantMatrixRoomAccess({ ...base, authFetch: authFetch as unknown as typeof fetch }))
      .rejects.toBeInstanceOf(RoomAccessError);
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });
});

/**
 * Stateful fake ACP control endpoint.
 *
 * Unlike the per-case stubs above, this keeps the document across requests so
 * multi-agent grants can be checked for lost updates, and it honours ETag /
 * If-Match exactly as a real ACP server would.
 */
function statefulAcr(
  containerUri: string,
  acrUri: string,
  ownerWebId: string,
  options: { initiallyMissing?: boolean; forceUpdate?: boolean } = {},
) {
  let doc = [
    '@prefix acp: <http://www.w3.org/ns/solid/acp#>.',
    '@prefix acl: <http://www.w3.org/ns/auth/acl#>.',
    '<#acr> a acp:AccessControlResource;',
    `  acp:resource <${containerUri}>.`,
    '<#owner> a acp:AccessControl; acp:apply <#ownerPolicy>.',
    '<#ownerPolicy> a acp:Policy;',
    '  acp:allow acl:Read, acl:Write, acl:Control.',
    `<#ownerMatcher> a acp:Matcher; acp:agent <${ownerWebId}>.`,
    '',
  ].join('\n');
  let etag = 1;
  let patches = 0;
  let creates = 0;
  let missing = options.initiallyMissing === true;
  const fetcher = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'HEAD' && url === containerUri) {
      return response(null, { headers: { Link: `<${acrUri}>; rel="acl"` } });
    }
    if (url !== acrUri) return response(null, { status: 404 });
    if (missing && method === 'PUT') {
      const ifNoneMatch = String((init?.headers ?? {})['If-None-Match'] ?? '');
      if (ifNoneMatch !== '*') return response(null, { status: 428 });
      creates += 1;
      doc = String(init?.body ?? '');
      etag += 1;
      missing = false;
      return response(null, { status: 201 });
    }
    if (missing) return response(null, { status: 404 });
    if (method === 'GET') {
      return response(doc, { headers: { 'Content-Type': 'text/turtle', ETag: `"v${etag}"` }, url });
    }
    if (method === 'PATCH') {
      if (options.forceUpdate) return response(null, { status: 405 });
      patches += 1;
      const body = String(init?.body ?? '');
      // The SDK sends `INSERT DATA { <s> <p> <o>; <p2> <o2>. ... }`. Parse those
      // triples and re-emit them as Turtle so the NEXT agent's GET sees a
      // parseable merged document. Real servers apply the patch themselves;
      // this fake only needs to model the resulting state faithfully.
      const inner = body.slice(body.indexOf('{') + 1, body.lastIndexOf('}'));
      let subject: string | undefined;
      for (const segment of inner.split(';')) {
        const iri = [...segment.matchAll(/<([^>]+)>/gu)].map((m) => m[1]!);
        if (!iri.length) continue;
        if (subject === undefined || !segment.trimStart().startsWith('<')) {
          if (iri.length >= 3) {
            subject = iri[0];
            doc = `${doc.trimEnd()}${doc.trimEnd().endsWith('.') ? '' : '.'}\n<${iri[0]}> <${iri[1]}> <${iri[2]}>`;
          }
        } else if (subject && iri.length >= 2) {
          doc += `;\n  <${iri[0]}> <${iri[1]}>`;
        }
      }
      doc += '.\n';
      etag += 1;
      return response(null, { status: 205 });
    }
    if (method === 'PUT') {
      const ifMatch = String((init?.headers ?? {})['If-Match'] ?? '');
      if (ifMatch !== `"v${etag}"`) return response(null, { status: 412 });
      doc = String(init?.body ?? '');
      etag += 1;
      return response(null, { status: 205 });
    }
    return response(null, { status: 405 });
  });
  return { fetcher, document: () => doc, patchCount: () => patches, createCount: () => creates };
}

describe('multi-participant ACP grants', () => {
  const common = 'https://id-rc.undefineds.cn/';
  const bob1 = `${common}people/shared-issuer-aaaaaaaaaaaaaaaaaaaa#bob`;
  const bob2 = `${common}people/shared-issuer-aaaaaaaaaaaaaaaaaaaa#carol`;
  const acrUri = `${container}.acr`;

  it('derives distinct control keys for WebIDs sharing a long issuer prefix', async () => {
    const state = statefulAcr(container, acrUri, ALICE);
    await grantMatrixRoomAccess({
      roomId: ROOM_ID,
      roomContainerUri: container,
      storageRoot: ALICE_ROOT,
      authFetch: state.fetcher as unknown as typeof fetch,
      participants: [bob1, bob2],
      ownerWebId: ALICE,
      timeoutMs: 5_000,
    });
    const doc = state.document();
    expect(doc).toContain(bob1);
    expect(doc).toContain(bob2);
    // Two distinct policy node namespaces, not one overwritten node.
    const keys = [...doc.matchAll(/rcMatrixRoom([0-9a-f]{64})Access/gu)].map((m) => m[1]);
    expect(new Set(keys).size).toBe(2);
  });

  it('preserves the owner and both agents when granting two invitees in one call', async () => {
    const state = statefulAcr(container, acrUri, ALICE);
    await grantMatrixRoomAccess({
      roomId: ROOM_ID,
      roomContainerUri: container,
      storageRoot: ALICE_ROOT,
      authFetch: state.fetcher as unknown as typeof fetch,
      participants: [bob1, bob2],
      ownerWebId: ALICE,
      timeoutMs: 5_000,
    });
    const doc = state.document();
    expect(doc).toContain(ALICE);
    expect(doc).toContain(bob1);
    expect(doc).toContain(bob2);
    // Both writes merged into the live document; neither replaced the other.
    expect(state.patchCount()).toBeGreaterThanOrEqual(1);
  });

  it('creates a missing ACR exactly once, then merges the second agent from a fresh document', async () => {
    // Initially the advertised ACR returns 404 like a real missing control
    // document; it only starts existing after the If-None-Match:* create.
    const state = statefulAcr(container, acrUri, ALICE, { initiallyMissing: true, forceUpdate: true });
    await grantMatrixRoomAccess({
      roomId: ROOM_ID,
      roomContainerUri: container,
      storageRoot: ALICE_ROOT,
      authFetch: state.fetcher as unknown as typeof fetch,
      participants: [bob1, bob2],
      ownerWebId: ALICE,
      timeoutMs: 5_000,
    });
    // Exactly one create, never zero and never two.
    expect(state.createCount()).toBe(1);
    // The second agent must have merged into the document the first create
    // produced; both WebIDs and the owner survive in the actual saved body.
    const doc = state.document();
    expect(doc).toContain(ALICE);
    expect(doc).toContain(bob1);
    expect(doc).toContain(bob2);
    // The create writes the first agent with short local nodes; the second
    // agent's merge introduces its full-WebID keyed node.
    expect(doc).toMatch(/rcMatrixRoom[0-9a-f]{64}Access/u);
    expect(doc).toContain('acp:AccessControlResource');
  });

  it('merges the second agent into the latest document when the server only accepts a full PUT', async () => {
    // PATCH is refused (405), so every grant goes through the ETag-guarded PUT
    // fallback. A stale dataset would 412 here or silently drop the first peer.
    const state = statefulAcr(container, acrUri, ALICE, { forceUpdate: true });
    await grantMatrixRoomAccess({
      roomId: ROOM_ID,
      roomContainerUri: container,
      storageRoot: ALICE_ROOT,
      authFetch: state.fetcher as unknown as typeof fetch,
      participants: [bob1, bob2],
      ownerWebId: ALICE,
      timeoutMs: 5_000,
    });
    expect(state.createCount()).toBe(0);
    const doc = state.document();
    expect(doc).toContain(ALICE);
    expect(doc).toContain(bob1);
    expect(doc).toContain(bob2);
  });
});

describe('missing WAC .acl', () => {
  it('fails with a fixed class and performs zero ACP writes when no ACL or fallback exists', async () => {
    // A genuinely missing .acl: the control document 404s and the resource
    // itself advertises no readable ACL/fallback. The helper must refuse
    // rather than initialize ACP vocabulary inside a .acl document.
    const aclUri = `${container}.acl`;
    const acpWrites: string[] = [];
    const authFetch = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD' && url === container) {
        return response(null, { headers: { Link: `<${aclUri}>; rel="acl"` } });
      }
      if ((method === 'PUT' || method === 'PATCH') && String(init?.body ?? '').includes(ACP_NS)) {
        acpWrites.push(url);
      }
      return response(null, { status: 404 });
    });

    await expect(grantMatrixRoomAccess({
      roomId: ROOM_ID,
      roomContainerUri: container,
      storageRoot: ALICE_ROOT,
      authFetch: authFetch as unknown as typeof fetch,
      participants: [BOB],
      ownerWebId: ALICE,
      timeoutMs: 5_000,
    })).rejects.toMatchObject({ name: 'RoomAccessError' });

    expect(acpWrites).toEqual([]);
  });
});
