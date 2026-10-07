import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BadRequestHttpError, ForbiddenHttpError, UnsupportedMediaTypeHttpError } from '@solid/community-server';
import { AgentReadObservation } from '../../src/authorization/AgentReadObservation';
import { SubgraphSparqlHttpHandler } from '../../src/http/SubgraphSparqlHttpHandler';
import {
  AUTHORIZATION_OBSERVATION_MEDIA_TYPE,
  AUTHORIZATION_PROFILE_DECLARATION_MEDIA_TYPE,
  AUTHORIZATION_PROFILE_NEGOTIATION_MEDIA_TYPE,
} from '../../src/storage/rdf/AuthorizationObservation';

const STUB = {} as never;

function realCapability(profile: 'wac-ground-v1' | 'acp-ground-v1'): AgentReadObservation {
  return new AgentReadObservation(STUB, STUB, STUB, STUB, STUB, STUB, STUB, STUB, STUB, profile);
}

function fakeCapability(profile: string, behavior: () => string): { profile: string; negotiate: () => Promise<string>; handle: () => Promise<string> } {
  return {
    profile,
    negotiate: async() => behavior(),
    handle: async() => behavior(),
  };
}

function makeRequest(body: string, media: string, method = 'POST', url = 'http://localhost/room/-/sparql') {
  const request = Readable.from([ Buffer.from(body, 'utf8') ]) as unknown as {
    method: string; url: string; headers: Record<string, string>; [key: string]: unknown;
  };
  request.method = method;
  request.url = url;
  request.headers = { host: 'localhost', 'content-type': media, accept: '*/*' };
  return request as never;
}

function makeResponse(): { statusCode: number; headers: Record<string, string>; setHeader: (k: string, v: string) => void; body: () => string } {
  const chunks: Buffer[] = [];
  const response = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }) as unknown as {
    statusCode: number; headers: Record<string, string>; setHeader: (k: string, v: string) => void; body: () => string;
  };
  response.statusCode = 200;
  response.headers = {};
  response.setHeader = (key: string, value: string) => { response.headers[key.toLowerCase()] = value; };
  response.body = () => Buffer.concat(chunks).toString('utf8');
  return response;
}

function makeHandler(guardedPolicyProfile: string | undefined, observation: unknown): SubgraphSparqlHttpHandler {
  return new SubgraphSparqlHttpHandler(
    STUB, STUB, STUB, STUB,
    guardedPolicyProfile === undefined ? {} : { guardedPolicyProfile },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    observation as never,
  );
}

const DECLARATION = JSON.stringify({
  version: 1, profile: 'a2-profile-declaration-v1', guardedPolicyProfile: 'wac-ground-v1',
  requesterWebId: 'https://owner.example/#me', targetWebId: 'https://agent.example/#me',
  sourceIri: 'http://localhost/room/doc#m', sourceDigest: 'c'.repeat(64), contextDigest: 'a'.repeat(64),
  challenge: 'b'.repeat(32),
});

describe('A2N capability profile binding', () => {
  it('defaults to the ACP guarded profile and binds an explicit maintained profile', () => {
    expect(realCapability('acp-ground-v1').profile).toBe('acp-ground-v1');
    expect(realCapability('wac-ground-v1').profile).toBe('wac-ground-v1');
  });

  it('refuses an unsupported profile label at construction', () => {
    expect(() => new AgentReadObservation(STUB, STUB, STUB, STUB, STUB, STUB, STUB, STUB, STUB, 'unsupported' as never)).toThrow();
  });

  it('keeps the A1 public observation media ACP-only (415 for a WAC-bound capability)', async() => {
    const request = makeRequest('{}', AUTHORIZATION_OBSERVATION_MEDIA_TYPE);
    const sidecar = { basePath: '/room/', baseUrl: 'http://localhost/room/', isContainer: true };
    await expect(realCapability('wac-ground-v1').handle(request as never, sidecar, '{}', STUB)).rejects.toBeInstanceOf(UnsupportedMediaTypeHttpError);
  });
});

describe('A2N negotiation handler dispatch', () => {
  it('routes the negotiation media to the qualified capability and returns the closed declaration', async() => {
    const handler = makeHandler('wac-ground-v1', fakeCapability('wac-ground-v1', () => DECLARATION));
    const response = makeResponse();
    await handler.handle({ request: makeRequest('{}', AUTHORIZATION_PROFILE_NEGOTIATION_MEDIA_TYPE), response: response as never });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain(AUTHORIZATION_PROFILE_DECLARATION_MEDIA_TYPE);
    expect(response.body()).toBe(DECLARATION);
  });

  it('qualifies an ACP-bound capability too', async() => {
    const handler = makeHandler('acp-ground-v1', fakeCapability('acp-ground-v1', () => DECLARATION));
    const response = makeResponse();
    await handler.handle({ request: makeRequest('{}', AUTHORIZATION_PROFILE_NEGOTIATION_MEDIA_TYPE), response: response as never });
    expect(response.statusCode).toBe(200);
  });

  it('fails closed 415 when no capability is installed (never a WAC signal)', async() => {
    const handler = makeHandler('wac-ground-v1', undefined);
    const response = makeResponse();
    await handler.handle({ request: makeRequest('{}', AUTHORIZATION_PROFILE_NEGOTIATION_MEDIA_TYPE), response: response as never });
    expect(response.statusCode).toBe(415);
    expect(response.body()).not.toContain('a2-profile-declaration-v1');
  });

  it('fails closed 415 when the capability profile does not match the runtime profile', async() => {
    const handler = makeHandler('wac-ground-v1', fakeCapability('acp-ground-v1', () => DECLARATION));
    const response = makeResponse();
    await handler.handle({ request: makeRequest('{}', AUTHORIZATION_PROFILE_NEGOTIATION_MEDIA_TYPE), response: response as never });
    expect(response.statusCode).toBe(415);
  });

  it('propagates malformed 400 and unsupported 415 refusals without a declaration body', async() => {
    const bad = makeHandler('wac-ground-v1', fakeCapability('wac-ground-v1', () => { throw new BadRequestHttpError('bad'); }));
    const badResponse = makeResponse();
    await bad.handle({ request: makeRequest('{}', AUTHORIZATION_PROFILE_NEGOTIATION_MEDIA_TYPE), response: badResponse as never });
    expect(badResponse.statusCode).toBe(400);
    expect(badResponse.body()).not.toContain('a2-profile-declaration-v1');

    const forbidden = makeHandler('wac-ground-v1', fakeCapability('wac-ground-v1', () => { throw new ForbiddenHttpError('no webid'); }));
    const forbiddenResponse = makeResponse();
    await forbidden.handle({ request: makeRequest('{}', AUTHORIZATION_PROFILE_NEGOTIATION_MEDIA_TYPE), response: forbiddenResponse as never });
    expect(forbiddenResponse.statusCode).toBe(403);
  });

  it('rejects a non-POST negotiation with 405', async() => {
    const handler = makeHandler('wac-ground-v1', fakeCapability('wac-ground-v1', () => DECLARATION));
    const response = makeResponse();
    await handler.handle({ request: makeRequest('', AUTHORIZATION_PROFILE_NEGOTIATION_MEDIA_TYPE, 'GET'), response: response as never });
    expect(response.statusCode).toBe(405);
  });

  it('keeps the A1 observation media on the handle path', async() => {
    const handler = makeHandler('acp-ground-v1', fakeCapability('acp-ground-v1', () => JSON.stringify({ ok: true })));
    const response = makeResponse();
    await handler.handle({ request: makeRequest('{}', AUTHORIZATION_OBSERVATION_MEDIA_TYPE), response: response as never });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain(AUTHORIZATION_OBSERVATION_MEDIA_TYPE);
  });
});
