import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ApiServer } from '../../../src/api/ApiServer';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import type {
  NetworkDesiredConfiguration,
  NetworkDiagnosticCheckResult,
} from '../../../src/api/handlers/NetworkSettingsHandler';
import {
  createCertificateCapability,
  createDnsStatusReader,
  createPublicAddressReader,
  createTunnelStatusReader,
  redactSecretText,
  registerNetworkSettingsRoutes,
} from '../../../src/api/handlers/NetworkSettingsHandler';

interface TestResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(name: string, value: string): void;
  end(payload?: string): void;
}

type RouteHandler = (request: AuthenticatedRequest, response: TestResponse, params?: unknown) => Promise<void> | void;

function createServer(): { server: ApiServer; routes: Record<string, RouteHandler> } {
  const routes: Record<string, RouteHandler> = {};
  return {
    routes,
    server: {
      get: vi.fn((path: string, handler: RouteHandler) => { routes[`GET ${path}`] = handler; }),
      post: vi.fn((path: string, handler: RouteHandler) => { routes[`POST ${path}`] = handler; }),
      put: vi.fn((path: string, handler: RouteHandler) => { routes[`PUT ${path}`] = handler; }),
    } as unknown as ApiServer,
  };
}

function request(auth: AuthenticatedRequest['auth']): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.method = 'GET';
  req.url = '/api/network/settings/status';
  req.headers = {};
  req.auth = auth;
  req.end();
  return req;
}

function loopbackRequest(auth?: AuthenticatedRequest['auth']): AuthenticatedRequest {
  const req = request(auth);
  Object.defineProperty(req, 'socket', { configurable: true, value: { remoteAddress: '127.0.0.1' } });
  return req;
}

function requestWithBody(auth: AuthenticatedRequest['auth'], body: unknown): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.method = 'PUT';
  req.url = '/api/network/settings/configuration';
  req.headers = { 'content-type': 'application/json' };
  req.auth = auth;
  req.write(JSON.stringify(body));
  req.end();
  return req;
}

function deploymentReadAuth(): AuthenticatedRequest['auth'] {
  return { type: 'service', serviceType: 'local', serviceId: 'local-owner', scopes: ['network:read'] };
}

function deploymentWriteAuth(): AuthenticatedRequest['auth'] {
  return { type: 'service', serviceType: 'cloud', serviceId: 'cloud-admin', scopes: ['network:write'] };
}

function response(): TestResponse {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end: vi.fn(function(this: any, payload?: string) {
      this.body = payload;
    }),
  };
}

describe('NetworkSettingsHandler', () => {
  it('allows an unauthenticated loopback host to read and write local network settings', async () => {
    const { server, routes } = createServer();
    const update = vi.fn(async () => ({
      domainDns: { domain: '', ddnsEnabled: false, provider: '', recordTtl: 300, credentialConfigured: false },
      https: { enabled: false, acmeEmail: '', domains: [], renewBeforeDays: 30 },
      tunnelProfiles: { activeProfileId: '', profiles: [] },
      p2p: { enabled: false, signalService: '', fallbackPolicy: 'when-direct-unavailable' as const },
    }));
    registerNetworkSettingsRoutes(server, {
      endpoint: 'http://127.0.0.1:3000/',
      configurationStore: { read: vi.fn(async () => update()), update },
    });

    const readRes = response();
    await routes['GET /api/network/settings/status'](loopbackRequest(), readRes);
    expect(readRes.statusCode).toBe(200);

    const writeReq = requestWithBody(undefined, { p2p: { enabled: true } });
    Object.defineProperty(writeReq, 'socket', { configurable: true, value: { remoteAddress: '::1' } });
    const writeRes = response();
    await routes['PUT /api/network/settings/configuration'](writeReq, writeRes);
    expect(writeRes.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith({ p2p: { enabled: true } });
  });
  it('requires deployment authentication and returns capability-shaped status without deployment', async () => {
    const { server, routes } = createServer();
    registerNetworkSettingsRoutes(server, {
      endpoint: 'https://xpod.example/',
      localAddresses: () => ['http://127.0.0.1:3000/'],
      lanAddresses: () => ['http://192.168.1.24:3000/'],
      publicAddresses: () => ['https://xpod.example/'],
      tlsStatusReader: { read: vi.fn(async () => ({ supported: true, status: 'valid', expiresAt: '2026-10-31T00:00:00.000Z' })) },
      dnsStatusReader: { read: vi.fn(async () => ({ supported: true, status: 'synced' })) },
      tunnelStatusReader: { read: vi.fn(async () => ({ supported: true, status: 'active' })) },
      certificateRenewer: { renew: vi.fn(async () => undefined) },
    });

    const unauthenticated = response();
    await routes['GET /api/network/settings/status'](request(undefined), unauthenticated, {});
    expect(unauthenticated.statusCode).toBe(401);

    const res = response();
    await routes['GET /api/network/settings/status'](request(deploymentReadAuth()), res, {});

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      endpoint: 'https://xpod.example/',
      addresses: {
        local: ['http://127.0.0.1:3000/'],
        lan: ['http://192.168.1.24:3000/'],
        public: ['https://xpod.example/'],
      },
      tls: { supported: true, status: 'valid', expiresAt: '2026-10-31T00:00:00.000Z' },
      dns: { supported: true, status: 'synced' },
      tunnel: { supported: true, status: 'active' },
      actions: { diagnose: true, renewCertificate: true },
    });
    expect(res.body).not.toContain('deployment');
  });

  it('reports unsupported capabilities and empty addresses instead of inventing network data', async () => {
    const { server, routes } = createServer();
    registerNetworkSettingsRoutes(server, {
      endpoint: 'http://127.0.0.1:3000/',
    });
    const res = response();

    await routes['GET /api/network/settings/status'](request(deploymentReadAuth()), res, {});

    expect(JSON.parse(res.body)).toEqual({
      endpoint: 'http://127.0.0.1:3000/',
      addresses: { local: [], lan: [], public: [] },
      tls: { supported: false, status: 'unsupported' },
      dns: { supported: false, status: 'unsupported' },
      tunnel: { supported: false, status: 'unsupported' },
      actions: { diagnose: true, renewCertificate: false },
    });
  });

  it('returns structured diagnose checks and redacts secrets from thrown errors', async () => {
    const { server, routes } = createServer();
    registerNetworkSettingsRoutes(server, {
      endpoint: 'https://xpod.example/',
      diagnostics: [
        {
          id: 'dns',
          label: 'DNS',
          run: vi.fn(async () => {
            throw new Error('token=super-secret failed for postgres://user:pass@localhost/xpod at /Users/alice/.xpod/key.pem');
          }),
        },
        {
          id: 'endpoint',
          label: 'Endpoint',
          run: vi.fn(async () => ({ status: 'ok' as const, detail: 'https://xpod.example/ responded' })),
        },
      ],
    });
    const res = response();

    await routes['POST /api/network/settings/diagnose'](request(deploymentReadAuth()), res, {});

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.checks).toMatchObject([
      { id: 'dns', label: 'DNS', status: 'error', detail: '[redacted]' },
      { id: 'endpoint', label: 'Endpoint', status: 'ok', detail: 'https://xpod.example/ responded' },
    ]);
    expect(body.checks.every((check: NetworkDiagnosticCheckResult) => typeof check.durationMs === 'number' && typeof check.checkedAt === 'string')).toBe(true);
    expect(JSON.stringify(body)).not.toContain('super-secret');
    expect(JSON.stringify(body)).not.toContain('postgres://');
    expect(JSON.stringify(body)).not.toContain('/Users/alice');
  });

  it('redacts credential classes without erasing normal hosts or status text', () => {
    const cases = [
      'Authorization: Bearer eyJhbGciOiJsecret.payload',
      'DPoP: eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3Arand0In0.payload.signature',
      'dpop: eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3Arand0In0.payload.signature',
      'authorization=DPoP dpop-token-secret',
      'Cookie: css-account=secret-cookie; session=abc',
      'Set-Cookie: css-account=secret-cookie; HttpOnly',
      'https://pod.example/callback?code=oauth-code-secret&state=abc',
      'oauth callback failed with code=oauth-code-secret',
      'clientSecret=solid-client-secret',
      'https://pod.example/callback#access_token=oauth-access-token&token_type=Bearer',
      'refresh_token=oauth-refresh-token',
      'id_token=header.payload.signature',
      'token_type=Bearer',
      'gateway key xpod_gw_v1_cloud.secret.payload',
      'invocation key xpod_inv_v1.kid.secret',
      '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
      '{"kty":"EC","d":"private-jwk-secret","x":"public"}',
      'file:///Users/alice/.xpod/key.pem',
      '/Users/alice/.xpod/key.pem',
      'C:\\Users\\alice\\.xpod\\key.pem',
      'D:/xpod/secrets/tls.key',
      '\\\\server\\share\\xpod\\tls.key',
      'postgres://user:pass@localhost/xpod',
      'redis://:secret@127.0.0.1:6379/0',
      'mongodb://user:pass@localhost/xpod',
    ];

    for (const value of cases) {
      expect(redactSecretText(value)).toBe('[redacted]');
    }
    expect(redactSecretText('https://xpod.example responded with status=ok')).toBe('https://xpod.example responded with status=ok');
    expect(redactSecretText('DNS synced for local-managed-node.undefineds.site')).toBe('DNS synced for local-managed-node.undefineds.site');
    expect(redactSecretText('HTTP status code=200')).toBe('HTTP status code=200');
    expect(redactSecretText('diagnostic code=ENOTFOUND')).toBe('diagnostic code=ENOTFOUND');
    expect(redactSecretText('content_type=text/turtle')).toBe('content_type=text/turtle');
    expect(redactSecretText('status_token_type_count=1')).toBe('status_token_type_count=1');
  });

  it('reflects DNS/tunnel provider capability and public endpoints through narrow adapters', async () => {
    const dnsProvider = { upsertRecord: vi.fn(), deleteRecord: vi.fn() };
    const dnsCoordinator = { synchronize: vi.fn() };
    const tunnelProvider = {
      getStatus: vi.fn(() => ({ running: true, connected: true, endpoint: 'https://runtime-tunnel.example/' })),
      getEndpoint: vi.fn(() => 'https://configured-tunnel.example/'),
    };
    const ddnsManager = {
      getStatus: vi.fn(() => ({
        allocated: true,
        fqdn: 'local-managed-node.undefineds.site',
        mode: 'tunnel',
        tunnelProvider: 'cloudflare',
      })),
    };
    const { server, routes } = createServer();
    registerNetworkSettingsRoutes(server, {
      endpoint: 'https://xpod.example/',
      dnsStatusReader: createDnsStatusReader({ dnsProvider, dnsCoordinator }),
      tunnelStatusReader: createTunnelStatusReader(tunnelProvider),
      publicAddresses: createPublicAddressReader({
        configuredUrls: ['https://configured.example/'],
        ddnsManager,
        tunnelProvider,
      }),
    });
    const res = response();

    await routes['GET /api/network/settings/status'](request(deploymentReadAuth()), res, {});

    expect(JSON.parse(res.body)).toMatchObject({
      dns: { supported: true, status: 'configured' },
      tunnel: { supported: true, status: 'active' },
      addresses: {
        public: [
          'https://configured.example/',
          'https://local-managed-node.undefineds.site/',
          'https://configured-tunnel.example/',
          'https://runtime-tunnel.example/',
        ],
      },
    });
    expect(res.body).not.toContain('deployment');
  });

  it('adapts a certificate runtime surface into TLS status and renewal actions', async () => {
    const certificateManager = {
      readCertificateStatus: vi.fn(async () => ({
        status: 'valid',
        domains: ['xpod.example', 'www.xpod.example'],
        issuer: 'Example ACME CA',
        validFrom: '2026-08-01T00:00:00.000Z',
        expiresAt: '2026-10-31T00:00:00.000Z',
        renewalStatus: 'scheduled',
      })),
      renewCertificate: vi.fn(async () => undefined),
    };
    const capability = createCertificateCapability(certificateManager);
    const { server, routes } = createServer();
    registerNetworkSettingsRoutes(server, {
      endpoint: 'https://xpod.example/',
      tlsStatusReader: capability?.tlsStatusReader,
      certificateRenewer: capability?.certificateRenewer,
    });

    const statusRes = response();
    await routes['GET /api/network/settings/status'](request(deploymentReadAuth()), statusRes, {});
    expect(JSON.parse(statusRes.body)).toMatchObject({
      tls: {
        supported: true,
        status: 'valid',
        domains: ['xpod.example', 'www.xpod.example'],
        issuer: 'Example ACME CA',
        validFrom: '2026-08-01T00:00:00.000Z',
        expiresAt: '2026-10-31T00:00:00.000Z',
        renewalStatus: 'scheduled',
      },
      actions: { renewCertificate: true },
    });

    const renewRes = response();
    await routes['POST /api/network/settings/certificate/renew'](request(deploymentWriteAuth()), renewRes, {});
    expect(renewRes.statusCode).toBe(200);
    expect(certificateManager.renewCertificate).toHaveBeenCalledTimes(1);
  });

  it('requires explicit deployment read/write authorization for network settings actions', async () => {
    const { server, routes } = createServer();
    const renew = vi.fn(async () => undefined);
    registerNetworkSettingsRoutes(server, {
      endpoint: 'https://xpod.example/',
      certificateRenewer: { renew },
    });

    const solidRes = response();
    await routes['GET /api/network/settings/status'](request({ type: 'solid', webId: 'https://pod.example/eve#me' }), solidRes);
    expect(solidRes.statusCode).toBe(403);

    const readOnlyAuth = { type: 'service' as const, serviceType: 'local' as const, serviceId: 'local-owner', scopes: ['network:read'] };
    const readRes = response();
    await routes['POST /api/network/settings/diagnose'](request(readOnlyAuth), readRes);
    expect(readRes.statusCode).toBe(200);

    const readOnlyRenewRes = response();
    await routes['POST /api/network/settings/certificate/renew'](request(readOnlyAuth), readOnlyRenewRes);
    expect(readOnlyRenewRes.statusCode).toBe(403);
    expect(renew).not.toHaveBeenCalled();

    const manageOnlyReadRes = response();
    await routes['GET /api/network/settings/status'](request({
      type: 'service',
      serviceType: 'local',
      serviceId: 'local-owner',
      scopes: ['account:manage'],
    }), manageOnlyReadRes);
    expect(manageOnlyReadRes.statusCode).toBe(403);

    const manageOnlyRenewRes = response();
    await routes['POST /api/network/settings/certificate/renew'](request({
      type: 'service',
      serviceType: 'cloud',
      serviceId: 'cloud-admin',
      scopes: ['account:manage'],
    }), manageOnlyRenewRes);
    expect(manageOnlyRenewRes.statusCode).toBe(403);
    expect(renew).not.toHaveBeenCalled();

    const writeRes = response();
    await routes['POST /api/network/settings/certificate/renew'](request({
      type: 'service',
      serviceType: 'cloud',
      serviceId: 'cloud-admin',
      scopes: ['network:write'],
    }), writeRes);
    expect(writeRes.statusCode).toBe(200);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('returns unavailable and conflict renewal errors as structured non-success responses', async () => {
    const { server, routes } = createServer();
    registerNetworkSettingsRoutes(server, {
      endpoint: 'https://xpod.example/',
      certificateRenewer: {
        isAvailable: vi.fn(async () => false),
        renew: vi.fn(async () => undefined),
      },
    });
    const auth = { type: 'service' as const, serviceType: 'cloud' as const, serviceId: 'cloud-admin', scopes: ['network:write'] };

    const statusRes = response();
    await routes['GET /api/network/settings/status'](request(auth), statusRes);
    expect(JSON.parse(statusRes.body).actions.renewCertificate).toBe(false);

    const unavailableRes = response();
    await routes['POST /api/network/settings/certificate/renew'](request(auth), unavailableRes);
    expect(unavailableRes.statusCode).toBe(503);
    expect(JSON.parse(unavailableRes.body)).toEqual({
      error: 'Certificate renewal is unavailable',
      code: 'certificate_renewal_unavailable',
    });

    const conflict = Object.assign(new Error('Certificate renewal is already running'), {
      statusCode: 409,
      code: 'certificate_renewal_conflict',
    });
    const conflictServer = createServer();
    registerNetworkSettingsRoutes(conflictServer.server, {
      endpoint: 'https://xpod.example/',
      certificateRenewer: {
        isAvailable: vi.fn(async () => true),
        renew: vi.fn(async () => { throw conflict; }),
      },
    });
    const conflictRes = response();
    await conflictServer.routes['POST /api/network/settings/certificate/renew'](request(auth), conflictRes);
    expect(conflictRes.statusCode).toBe(409);
    expect(JSON.parse(conflictRes.body)).toEqual({
      error: 'Certificate renewal is already running',
      code: 'certificate_renewal_conflict',
    });
  });

  it('separates observed state from saved configuration and validates writes', async () => {
    const { server, routes } = createServer();
    const configuration: NetworkDesiredConfiguration = {
      domainDns: { domain: 'xpod.example', ddnsEnabled: true, provider: 'cloudflare', recordTtl: 300, credentialConfigured: true },
      https: { enabled: true, acmeEmail: 'alice@example.com', domains: ['xpod.example'], renewBeforeDays: 30 },
      tunnelProfiles: { activeProfileId: 'home', profiles: [{ id: 'home', provider: 'cloudflare', label: 'Home', credentialConfigured: true }] },
      p2p: { enabled: false, signalService: '', fallbackPolicy: 'when-direct-unavailable' },
    };
    const store = { read: vi.fn(async () => configuration), update: vi.fn(async () => configuration) };
    registerNetworkSettingsRoutes(server, { endpoint: 'https://xpod.example/', configurationStore: store });

    const read = response();
    await routes['GET /api/network/settings/status'](request(deploymentReadAuth()), read);
    expect(JSON.parse(read.body).configuration).toEqual(configuration);
    expect(JSON.parse(read.body).configuration).not.toHaveProperty('credential');

    const write = response();
    await routes['PUT /api/network/settings/configuration'](requestWithBody(deploymentWriteAuth(), { domainDns: { recordTtl: 600 } }), write);
    expect(write.statusCode).toBe(200);
    expect(store.update).toHaveBeenCalledWith({ domainDns: { recordTtl: 600 } });
    expect(JSON.parse(write.body).applyState).toBe('restart-required');

    const invalid = response();
    await routes['PUT /api/network/settings/configuration'](requestWithBody(deploymentWriteAuth(), { domainDns: { recordTtl: 0 } }), invalid);
    expect(invalid.statusCode).toBe(400);
  });
});
