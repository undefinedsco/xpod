import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/api/ai-gateway/providers/ProviderRegistry', () => ({
  normalizeProviderId: (id: string) => id,
}));
vi.mock('../../../src/api/ai-gateway/connect', () => ({}));
vi.mock('../../../src/api/ai-gateway/service-access/AiConnectionsServiceAccess', () => ({}));

import { registerAiGatewayManagementRoutes } from '../../../src/api/handlers/AiGatewayManagementHandler';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';

const WEB_ID = 'https://id.example/fresh/profile/card#me';
const BUILTIN = { id: 'xpod-builtin', label: 'Xpod', modelIds: ['linx', 'linx-lite'] };

function setup(options: Record<string, unknown>) {
  const routes: Record<string, Function> = {};
  const server = { get: (p: string, h: Function) => { routes[`GET ${p}`] = h; }, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() };
  registerAiGatewayManagementRoutes(server as never, { deployment: 'cloud', ...options } as never);
  return routes['GET /api/ai/providers'];
}

function req(): AuthenticatedRequest {
  const r = new PassThrough() as PassThrough & AuthenticatedRequest;
  r.method = 'GET';
  r.url = '/api/ai/providers';
  r.headers = {};
  r.auth = { type: 'solid', webId: WEB_ID, tokenType: 'DPoP', accessToken: 't', dpopProof: 'p' } as never;
  r.end();
  return r;
}

function res(): any {
  const headers: Record<string, string> = {};
  return {
    statusCode: 0,
    headers,
    get builtinHeader() { return headers['X-Xpod-Builtin-Providers']; },
    getHeader: (name: string) => headers[name],
    jsonBody() { return JSON.parse(this.body); },
    setHeader: (name: string, value: string) => { headers[name] = value; },
    end: vi.fn(function (this: any, payload?: string) { this.body = payload; }),
  };
}

describe('GET /api/ai/providers deployment built-in', () => {
  it('returns the read-only built-in for a DPoP session whose Pod access fails', async () => {
    const connectService = { listProviderCredentialPools: vi.fn(async () => { throw new Error('caller_dpop_replay_unsupported'); }) };
    const out = res();
    out.setHeader('Access-Control-Expose-Headers', 'Link, DPoP-Nonce');
    await setup({ connectService, deploymentBuiltin: BUILTIN })(req(), out, {});
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).data).toEqual([expect.objectContaining({
      id: 'xpod-builtin', builtin: true, readOnly: true, credentials: [],
      selectedModels: [
        expect.objectContaining({ id: 'linx', provider: 'xpod-builtin' }),
        expect.objectContaining({ id: 'linx-lite', provider: 'xpod-builtin' }),
      ],
    })]);
    expect(out.jsonBody().data[0].selectedModels[0].displayName).toBe('linx');
    expect(out.builtinHeader).toBe('xpod-builtin');
    expect(out.getHeader('Access-Control-Expose-Headers')).toContain('X-Xpod-Builtin-Providers');
    expect(out.getHeader('Access-Control-Expose-Headers')).toContain('Link');
    expect(out.getHeader('Access-Control-Expose-Headers')).toContain('DPoP-Nonce');
  });

  it('serves the built-in when the Pod read fails at the network layer', async () => {
    const connectService = {
      listProviderCredentialPools: vi.fn(async () => {
        throw Object.assign(new TypeError('fetch failed https://pod.example/alice/?token=SENTINEL'), { code: 'ECONNREFUSED' });
      }),
    };
    const out = res();
    await setup({ connectService, deploymentBuiltin: BUILTIN })(req(), out, {});
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).data.map((p: any) => p.id)).toEqual(['xpod-builtin']);
    expect(out.body).not.toContain('SENTINEL');
  });

  it('keeps provider mutations failing normally when the Pod is unreachable', async () => {
    const routes: Record<string, Function> = {};
    const server = {
      get: (p: string, h: Function) => { routes[`GET ${p}`] = h; },
      post: (p: string, h: Function) => { routes[`POST ${p}`] = h; },
      put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    };
    const connectService = {
      listProviderCredentialPools: vi.fn(async () => { throw new TypeError('fetch failed'); }),
      createApiKeyCredential: vi.fn(async () => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }); }),
    };
    registerAiGatewayManagementRoutes(server as never, { deployment: 'cloud', connectService, deploymentBuiltin: BUILTIN } as never);
    const out = res();
    const post = new PassThrough() as PassThrough & AuthenticatedRequest;
    post.method = 'POST';
    post.url = '/api/ai/providers/kimi/credentials/api-key';
    post.headers = { 'content-type': 'application/json' };
    post.auth = { type: 'solid', webId: WEB_ID, tokenType: 'DPoP', accessToken: 't', dpopProof: 'p' } as never;
    post.end(JSON.stringify({ apiKey: 'sk-test' }));
    await routes['POST /api/ai/providers/:provider/credentials/api-key'](post, out, { provider: 'kimi' });
    expect(out.statusCode).toBe(500);
  });

  it('puts the built-in before the Pod-backed pools when Pod access works', async () => {
    const connectService = { listProviderCredentialPools: vi.fn(async () => [{ id: 'kimi', name: 'Kimi', status: 'available', credentials: [] }]) };
    const out = res();
    await setup({ connectService, deploymentBuiltin: BUILTIN })(req(), out, {});
    expect(JSON.parse(out.body).data.map((p: any) => p.id)).toEqual(['xpod-builtin', 'kimi']);
    expect(out.builtinHeader).toBe('xpod-builtin');
  });

  it('still reports Pod access failure when no built-in is configured', async () => {
    const connectService = { listProviderCredentialPools: vi.fn(async () => { throw new Error('caller_dpop_replay_unsupported'); }) };
    const out = res();
    await setup({ connectService })(req(), out, {});
    expect(out.statusCode).toBe(403);
    expect(out.builtinHeader).toBeUndefined();
  });
});
