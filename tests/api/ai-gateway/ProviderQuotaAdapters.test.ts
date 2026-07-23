import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { registerAiGatewayManagementRoutes } from '../../../src/api/handlers/AiGatewayManagementHandler';
import { WebCryptoCredentialVault } from '../../../src/api/ai-gateway/credentials/WebCryptoCredentialVault';
import type { KeyWrapContext, KeyWrapper, WrappedDataKey } from '../../../src/api/ai-gateway/credentials/KeyWrapper';
import type { CredentialVault, ProviderSecret } from '../../../src/api/ai-gateway/credentials/CredentialVault';
import {
  AnthropicQuotaAdapter,
  BailianQuotaAdapter,
  DeepSeekQuotaAdapter,
  InMemoryQuotaSnapshotRepository,
  KimiQuotaAdapter,
  OpenAiQuotaAdapter,
  PodQuotaSnapshotRepository,
  ProviderQuotaService,
  type NormalizedQuotaSnapshot,
  type ProviderQuotaAdapter,
  type QuotaCredentialRecord,
} from '../../../src/api/ai-gateway/quota';
import { quotaSnapshotId, quotaSnapshotResource } from '@undefineds.co/models';
import { InMemoryGatewayAccessKeyRepository } from './InMemoryGatewayAccessKeyRepository';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import type { ApiServer } from '../../../src/api/ApiServer';

const WEB_ID = 'https://id.example/alice/profile/card#me';
const OTHER_WEB_ID = 'https://id.example/bob/profile/card#me';
const CREDENTIAL_IRI = 'https://id.example/alice/.data/settings/credentials.ttl#cloud-kimi';

class TestKeyWrapper implements KeyWrapper {
  public async wrapDek(context: KeyWrapContext, dek: Uint8Array): Promise<WrappedDataKey> {
    return {
      algorithm: 'test',
      keyId: `${context.webId}|${context.credentialIri}|${context.provider}`,
      keyVersion: 'v1',
      wrappedDek: Buffer.from(dek).toString('base64url'),
    };
  }

  public async unwrapDek(_context: KeyWrapContext, wrapped: WrappedDataKey): Promise<Uint8Array> {
    return new Uint8Array(Buffer.from(wrapped.wrappedDek, 'base64url'));
  }
}

function jsonFetch(
  handler: (url: string, init: RequestInit | undefined) => {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
  },
): typeof fetch {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const result = handler(url, init);
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: result.headers,
    });
  }) as unknown as typeof fetch;
}

function createVault(): WebCryptoCredentialVault {
  return new WebCryptoCredentialVault({ keyWrapper: new TestKeyWrapper() });
}

async function credential(provider: string, secret: ProviderSecret = { type: 'apiKey', apiKey: 'provider-secret' }): Promise<QuotaCredentialRecord> {
  const vault = createVault();
  const credentialIri = CREDENTIAL_IRI.replace('kimi', provider);
  return {
    id: `${provider}-credential`,
    credentialIri,
    webId: WEB_ID,
    provider,
    deployment: 'cloud',
    authMode: 'apiKey',
    encryptedSecret: await vault.seal({ webId: WEB_ID }, credentialIri, provider, secret),
    status: 'active',
  };
}

describe('ProviderQuotaAdapters', () => {
  it('normalizes Kimi official API-key balance without inventing a percentage', async () => {
    const fetch = jsonFetch((url, init) => {
      expect(url).toBe('https://api.moonshot.ai/v1/users/me/balance');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer provider-secret');
      return {
        body: {
          data: {
            available_balance: '12.50',
            voucher_balance: '2.50',
            cash_balance: '10.00',
          },
        },
      };
    });

    const snapshot = await new KimiQuotaAdapter({ fetch }).fetch({
      credential: await credential('kimi'),
      secret: { type: 'apiKey', apiKey: 'provider-secret' },
      now: new Date('2026-07-23T00:00:00.000Z'),
    });

    expect(snapshot).toMatchObject({
      status: 'available',
      source: 'kimi:/v1/users/me/balance',
      observedAt: '2026-07-23T00:00:00.000Z',
      windows: [
        { name: 'available_balance', remaining: 12.5, remainingExact: '12.50' },
        { name: 'voucher_balance', remaining: 2.5, remainingExact: '2.50' },
        { name: 'cash_balance', remaining: 10, remainingExact: '10.00' },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain('percent');
  });

  it('keeps Kimi quota on the official global endpoint until provider config owns regional variants', async () => {
    const fetch = jsonFetch((url) => {
      expect(url).toBe('https://api.moonshot.ai/v1/users/me/balance');
      return { body: { data: { available_balance: '1.00' } } };
    });
    const kimiCredential = {
      ...await credential('kimi'),
      baseUrl: 'https://api.moonshot.cn/v1',
    };

    await expect(new KimiQuotaAdapter({ fetch }).fetch({
      credential: kimiCredential,
      secret: { type: 'apiKey', apiKey: 'provider-secret' },
      now: new Date('2026-07-23T00:00:00.000Z'),
    })).resolves.toMatchObject({
      status: 'available',
      windows: [{ name: 'available_balance', remaining: 1, remainingExact: '1.00' }],
    });
  });

  it('preserves Kimi official decimal strings as authoritative quota amounts', async () => {
    const fetch = jsonFetch(() => ({
      body: {
        data: {
          available_balance: '9007199254740993.01',
          voucher_balance: '0.1',
        },
      },
    }));

    const snapshot = await new KimiQuotaAdapter({ fetch }).fetch({
      credential: await credential('kimi'),
      secret: { type: 'apiKey', apiKey: 'provider-secret' },
      now: new Date('2026-07-23T00:00:00.000Z'),
    });

    expect(snapshot.windows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'available_balance',
        remainingExact: '9007199254740993.01',
      }),
      expect.objectContaining({
        name: 'voucher_balance',
        remaining: 0.1,
        remainingExact: '0.1',
        displayApprox: true,
      }),
    ]));
    expect(snapshot.windows.find((window) => window.name === 'available_balance')).not.toHaveProperty('remaining');
  });

  it('normalizes DeepSeek official user balance endpoint fields', async () => {
    const fetch = jsonFetch((url, init) => {
      expect(url).toBe('https://api.deepseek.com/user/balance');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer deepseek-secret');
      return {
        body: {
          is_available: true,
          balance_infos: [
            {
              currency: 'USD',
              total_balance: '3.75',
              granted_balance: '1.25',
              topped_up_balance: '2.50',
            },
          ],
        },
      };
    });

    const snapshot = await new DeepSeekQuotaAdapter({ fetch }).fetch({
      credential: await credential('deepseek', { type: 'apiKey', apiKey: 'deepseek-secret' }),
      secret: { type: 'apiKey', apiKey: 'deepseek-secret' },
      now: new Date('2026-07-23T00:00:00.000Z'),
    });

    expect(snapshot).toMatchObject({
      status: 'available',
      source: 'deepseek:/user/balance',
      windows: [
        { name: 'USD.total_balance', remaining: 3.75, remainingExact: '3.75', currency: 'USD' },
        { name: 'USD.granted_balance', remaining: 1.25, remainingExact: '1.25', currency: 'USD' },
        { name: 'USD.topped_up_balance', remaining: 2.5, remainingExact: '2.50', currency: 'USD' },
      ],
      metadata: {
        isAvailable: true,
      },
    });
  });

  it('always calls the exact DeepSeek balance endpoint and never sends Bearer to credential baseUrl', async () => {
    const fetch = jsonFetch((url, init) => {
      expect(url).toBe('https://api.deepseek.com/user/balance');
      expect(url).not.toContain('attacker.example');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer deepseek-secret');
      return {
        body: {
          is_available: true,
          balance_infos: [{ currency: 'USD', total_balance: '0.1' }],
        },
      };
    });
    const deepSeekCredential = {
      ...await credential('deepseek', { type: 'apiKey', apiKey: 'deepseek-secret' }),
      baseUrl: 'https://attacker.example/v1',
      metadata: { balanceUrl: 'https://attacker.example/user/balance' },
    } as QuotaCredentialRecord;

    const snapshot = await new DeepSeekQuotaAdapter({ fetch }).fetch({
      credential: deepSeekCredential,
      secret: { type: 'apiKey', apiKey: 'deepseek-secret' },
      now: new Date('2026-07-23T00:00:00.000Z'),
    });

    expect(snapshot.windows).toEqual([
      expect.objectContaining({
        name: 'USD.total_balance',
        remaining: 0.1,
        remainingExact: '0.1',
        displayApprox: true,
      }),
    ]);
  });

  it('returns unsupported for providers without credential-scoped official quota API', async () => {
    const now = new Date('2026-07-23T00:00:00.000Z');
    await expect(new OpenAiQuotaAdapter().fetch({
      credential: await credential('openai'),
      secret: { type: 'apiKey', apiKey: 'openai-secret' },
      now,
    })).resolves.toMatchObject({
      status: 'unsupported',
      source: 'openai:no-credential-quota-api',
      windows: [],
    });
    await expect(new AnthropicQuotaAdapter().fetch({
      credential: await credential('anthropic'),
      secret: { type: 'apiKey', apiKey: 'anthropic-secret' },
      now,
    })).resolves.toMatchObject({
      status: 'unsupported',
      source: 'anthropic:no-credential-quota-api',
      windows: [],
    });
    await expect(new BailianQuotaAdapter().fetch({
      credential: await credential('bailian'),
      secret: { type: 'apiKey', apiKey: 'bailian-secret' },
      now,
    })).resolves.toMatchObject({
      status: 'unsupported',
      source: 'bailian:console-only',
      windows: [],
    });
  });

  it('records 429 as cooldown metadata without fabricating remaining quota', async () => {
    const fetch = jsonFetch(() => ({
      status: 429,
      headers: { 'retry-after': '30' },
      body: { error: { message: 'slow down and secret provider-secret' } },
    }));

    const snapshot = await new KimiQuotaAdapter({ fetch }).fetch({
      credential: await credential('kimi'),
      secret: { type: 'apiKey', apiKey: 'provider-secret' },
      now: new Date('2026-07-23T00:00:00.000Z'),
    });

    expect(snapshot).toMatchObject({
      status: 'error',
      source: 'kimi:/v1/users/me/balance',
      windows: [],
      metadata: {
        cooldown: {
          reason: 'rate_limited',
          retryAfterSeconds: 30,
        },
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('provider-secret');
  });

  it('caches available, unsupported and error snapshots in the Pod-scoped repository', async () => {
    const repository = new InMemoryQuotaSnapshotRepository();
    const vault = createVault();
    const kimiCredential = await credential('kimi');
    const service = new ProviderQuotaService({
      repository,
      vault,
      adapters: [
        new KimiQuotaAdapter({
          fetch: jsonFetch(() => ({
            body: {
              data: { available_balance: '8.00' },
            },
          })),
        }),
        new OpenAiQuotaAdapter(),
      ],
      credentials: [kimiCredential, await credential('openai')],
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    const first = await service.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialIri: kimiCredential.credentialIri,
      refresh: true,
    });
    const cached = await service.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialIri: kimiCredential.credentialIri,
      refresh: false,
    });
    const unsupported = await service.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'openai',
      refresh: true,
    });

    expect(first.status).toBe('available');
    expect(cached).toMatchObject({ status: 'available', stale: false });
    expect(unsupported.status).toBe('unsupported');
    expect(repository.rows).toHaveLength(2);
    expect(repository.rows.map((row) => row.status).sort()).toEqual(['available', 'unsupported']);
  });

  it('marks stale cached snapshots and never leaks decrypted secrets into cache rows', async () => {
    const repository = new InMemoryQuotaSnapshotRepository();
    const vault = createVault();
    const kimiCredential = await credential('kimi', { type: 'apiKey', apiKey: 'secret-never-cache' });
    const service = new ProviderQuotaService({
      repository,
      vault,
      adapters: [
        new KimiQuotaAdapter({
          fetch: jsonFetch(() => ({ status: 500, body: { error: 'secret-never-cache failed' } })),
        }),
      ],
      credentials: [kimiCredential],
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    await service.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      refresh: true,
    });
    const stale = await service.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      refresh: false,
      now: new Date('2026-07-23T01:00:00.000Z'),
    });

    expect(stale).toMatchObject({ status: 'error', stale: true });
    expect(JSON.stringify(repository.rows)).not.toContain('secret-never-cache');
  });

  it('caches sanitized provider quota fetch failures without leaking network or parse details', async () => {
    const networkRepository = new InMemoryQuotaSnapshotRepository();
    const networkCredential = await credential('kimi', { type: 'apiKey', apiKey: 'secret-never-cache' });
    const networkService = new ProviderQuotaService({
      repository: networkRepository,
      vault: createVault(),
      adapters: [
        new KimiQuotaAdapter({
          fetch: vi.fn(async () => {
            throw new TypeError('getaddrinfo ENOTFOUND attacker.example secret-never-cache raw-body');
          }) as unknown as typeof fetch,
        }),
      ],
      credentials: [networkCredential],
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    await expect(networkService.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      refresh: true,
    })).resolves.toMatchObject({
      status: 'error',
      source: 'kimi:/v1/users/me/balance',
      metadata: { reason: 'provider_quota_unavailable' },
    });
    expect(networkRepository.rows).toHaveLength(1);
    expect(JSON.stringify(networkRepository.rows)).not.toMatch(/secret-never-cache|attacker\.example|raw-body|ENOTFOUND/i);

    const jsonRepository = new InMemoryQuotaSnapshotRepository();
    const jsonCredential = await credential('deepseek', { type: 'apiKey', apiKey: 'deepseek-secret' });
    const jsonService = new ProviderQuotaService({
      repository: jsonRepository,
      vault: createVault(),
      adapters: [
        new DeepSeekQuotaAdapter({
          fetch: vi.fn(async () => new Response('not-json', { status: 200 })) as unknown as typeof fetch,
        }),
      ],
      credentials: [jsonCredential],
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    await expect(jsonService.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'deepseek',
      refresh: true,
    })).resolves.toMatchObject({
      status: 'error',
      source: 'deepseek:/user/balance',
      metadata: { reason: 'provider_quota_unavailable' },
    });
    expect(jsonRepository.rows).toHaveLength(1);
    expect(JSON.stringify(jsonRepository.rows)).not.toMatch(/not-json|SyntaxError|Unexpected/i);
  });

  it('propagates aborted quota refreshes and does not cache cancellation snapshots', async () => {
    const repository = new InMemoryQuotaSnapshotRepository();
    const kimiCredential = await credential('kimi');
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    const service = new ProviderQuotaService({
      repository,
      vault: createVault(),
      adapters: [
        new KimiQuotaAdapter({
          fetch: vi.fn(async () => {
            throw abortError;
          }) as unknown as typeof fetch,
        }),
      ],
      credentials: [kimiCredential],
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    await expect(service.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      refresh: true,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(repository.rows).toHaveLength(0);
  });

  it('deduplicates concurrent refreshes by identity deployment provider and credential only while in flight', async () => {
    const repository = new InMemoryQuotaSnapshotRepository();
    const firstCredential = await credential('kimi');
    const secondCredential: QuotaCredentialRecord = {
      ...await credential('kimi'),
      id: 'kimi-credential-two',
      credentialIri: 'https://id.example/alice/.data/settings/credentials.ttl#cloud-kimi-two',
    };
    let releaseFetch: (() => void) | undefined;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const vault: CredentialVault = {
      seal: vi.fn(),
      rewrap: vi.fn(),
      open: vi.fn(async () => ({ type: 'apiKey', apiKey: 'provider-secret' })),
    } as unknown as CredentialVault;
    const adapter: ProviderQuotaAdapter = {
      provider: 'kimi',
      fetch: vi.fn(async (input): Promise<NormalizedQuotaSnapshot> => {
        await fetchGate;
        return {
          credential: input.credential.credentialIri,
          status: 'available',
          windows: [{ name: 'available_balance', remaining: 1, remainingExact: '1.00' }],
          observedAt: input.now.toISOString(),
          expiresAt: new Date(input.now.getTime() + 5 * 60_000).toISOString(),
          source: 'kimi:/v1/users/me/balance',
        };
      }),
    };
    const service = new ProviderQuotaService({
      repository,
      vault,
      adapters: [adapter],
      credentials: [firstCredential, secondCredential],
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    const sameScopeA = service.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialIri: firstCredential.credentialIri,
      refresh: true,
    });
    const sameScopeB = service.status({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialIri: firstCredential.credentialIri,
      refresh: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(adapter.fetch).toHaveBeenCalledTimes(1);
    expect(vault.open).toHaveBeenCalledTimes(1);
    releaseFetch?.();
    await expect(Promise.all([sameScopeA, sameScopeB])).resolves.toHaveLength(2);
    expect(repository.rows.filter((row) => row.credential === firstCredential.credentialIri)).toHaveLength(1);

    const [differentScopeA, differentScopeB] = await Promise.all([
      service.status({
        webId: WEB_ID,
        deployment: 'cloud',
        provider: 'kimi',
        credentialIri: firstCredential.credentialIri,
        refresh: true,
      }),
      service.status({
        webId: WEB_ID,
        deployment: 'cloud',
        provider: 'kimi',
        credentialIri: secondCredential.credentialIri,
        refresh: true,
      }),
    ]);

    expect(differentScopeA.credential).toBe(firstCredential.credentialIri);
    expect(differentScopeB.credential).toBe(secondCredential.credentialIri);
    expect(vault.open).toHaveBeenCalledTimes(3);
    expect(adapter.fetch).toHaveBeenCalledTimes(3);
  });

  it('isolates quota snapshots by current WebID, deployment, provider and credential', async () => {
    const repository = new InMemoryQuotaSnapshotRepository();
    const aliceKimi = await credential('kimi');
    const bobCredentialIri = 'https://id.example/bob/.data/settings/credentials.ttl#cloud-kimi';
    const bobKimi: QuotaCredentialRecord = {
      ...aliceKimi,
      id: 'bob-kimi',
      webId: OTHER_WEB_ID,
      credentialIri: bobCredentialIri,
      encryptedSecret: await createVault().seal(
        { webId: OTHER_WEB_ID },
        bobCredentialIri,
        'kimi',
        { type: 'apiKey', apiKey: 'provider-secret' },
      ),
    };
    const service = new ProviderQuotaService({
      repository,
      vault: createVault(),
      adapters: [
        new KimiQuotaAdapter({
          fetch: jsonFetch(() => ({ body: { data: { available_balance: '1.00' } } })),
        }),
      ],
      credentials: [aliceKimi, bobKimi],
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    await service.status({ webId: WEB_ID, deployment: 'cloud', provider: 'kimi', refresh: true });
    await service.status({ webId: OTHER_WEB_ID, deployment: 'cloud', provider: 'kimi', refresh: true });

    expect(repository.rows.map((row) => row.credential).sort()).toEqual([
      aliceKimi.credentialIri,
      bobKimi.credentialIri,
    ].sort());
    await expect(service.status({
      webId: WEB_ID,
      deployment: 'local',
      provider: 'kimi',
      refresh: false,
    })).rejects.toThrow('quota_credential_not_found');
  });

  it('uses shared persisted scope helpers for Pod quota CRUD without decoding ids', async () => {
    const now = new Date('2026-07-23T00:00:00.000Z');
    const rows = new Map<string, any>();
    const credentialIri = CREDENTIAL_IRI;
    const scopedId = quotaSnapshotId({
      owner: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credential: credentialIri,
    });
    rows.set('legacy-newer', {
      id: 'ai/gateway/quota.ttl#legacy-newer',
      credential: credentialIri,
      status: 'available',
      windows: JSON.stringify([{ name: 'legacy', remaining: 999 }]),
      observedAt: new Date('2026-07-23T00:03:00.000Z'),
      expiresAt: new Date('2026-07-23T01:00:00.000Z'),
      source: 'kimi:/v1/users/me/balance',
    });
    rows.set(scopedId, {
      id: scopedId,
      owner: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credential: credentialIri,
      status: 'unsupported',
      windows: JSON.stringify([]),
      observedAt: now,
      expiresAt: new Date('2026-07-23T00:05:00.000Z'),
      source: 'kimi:/v1/users/me/balance',
    });
    const calls: Array<[string, unknown, unknown?, unknown?]> = [];
    const repository = new PodQuotaSnapshotRepository({
      internalPodAccess: { getTrustedFetch: vi.fn(async () => fetch) },
      dbFactory: async () => ({
        init: vi.fn(),
        select: () => ({
          from: (resource: unknown) => ({
            where: (condition: unknown) => {
              calls.push(['where', resource, condition]);
              return { execute: async () => [...rows.values()].map((row) => structuredClone(row)) };
            },
          }),
        }),
        findById: async (resource: unknown, id: string) => {
          calls.push(['findById', resource, id]);
          return structuredClone(rows.get(id));
        },
        findByIri: async () => null,
        updateById: async (resource: unknown, id: string, patch: any) => {
          calls.push(['updateById', resource, id, patch]);
          const row = rows.get(id);
          if (!row) return null;
          Object.assign(row, patch);
          return structuredClone(row);
        },
        updateByIri: async () => null,
        insert: (resource: unknown) => ({
          values: (value: any) => {
            calls.push(['values', resource, value]);
            return {
              execute: async () => {
                rows.set(value.id, structuredClone(value));
                return [structuredClone(value)];
              },
            };
          },
        }),
      } as any),
    });

    await expect(repository.findFresh({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialIri,
      now,
    })).resolves.toMatchObject({
      id: scopedId,
      status: 'unsupported',
    });

    await repository.upsert({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      snapshot: {
        credential: credentialIri,
        status: 'error',
        windows: [],
        observedAt: now.toISOString(),
        expiresAt: new Date('2026-07-23T00:05:00.000Z').toISOString(),
        source: 'kimi:/v1/users/me/balance',
      },
    });

    expect(rows.get(scopedId)).toMatchObject({
      id: scopedId,
      owner: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credential: credentialIri,
      status: 'error',
    });
    expect(calls).toEqual(expect.arrayContaining([
      ['findById', quotaSnapshotResource, scopedId],
      ['updateById', quotaSnapshotResource, scopedId, expect.objectContaining({
        owner: WEB_ID,
        deployment: 'cloud',
        provider: 'kimi',
        credential: credentialIri,
      })],
    ]));
  });
});

function createServer(): { server: ApiServer; routes: Record<string, Function> } {
  const routes: Record<string, Function> = {};
  return {
    routes,
    server: {
      post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
      get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
      delete: vi.fn((path: string, handler: Function) => { routes[`DELETE ${path}`] = handler; }),
    } as unknown as ApiServer,
  };
}

function request(auth: AuthenticatedRequest['auth'], body?: unknown, url = '/api/ai/gateway/providers/kimi/quota/status'): AuthenticatedRequest {
  const req = new PassThrough() as unknown as AuthenticatedRequest;
  req.method = body === undefined ? 'GET' : 'POST';
  req.url = url;
  req.headers = {};
  req.auth = auth;
  if (body !== undefined) {
    req.end(JSON.stringify(body));
  } else {
    req.end();
  }
  return req;
}

function response(): any {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end: vi.fn(function(this: any, payload?: string) {
      this.body = payload;
    }),
  };
}

describe('AiGatewayManagementHandler quota routes', () => {
  it('exposes quota status and refresh only to the current Solid identity', async () => {
    const kimiCredential = await credential('kimi');
    const quotaService = {
      status: vi.fn(async () => ({
        status: 'available',
        source: 'kimi:/v1/users/me/balance',
        observedAt: '2026-07-23T00:00:00.000Z',
        expiresAt: '2026-07-23T00:05:00.000Z',
        windows: [{ name: 'available_balance', remaining: 1 }],
        stale: false,
      })),
    };
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      quotaService: quotaService as never,
    });

    const status = response();
    await routes['GET /api/ai/gateway/providers/:provider/quota/status'](request(
      { type: 'solid', webId: WEB_ID },
      undefined,
      `/api/ai/gateway/providers/kimi/quota/status?credentialIri=${encodeURIComponent(kimiCredential.credentialIri)}`,
    ), status, { provider: 'kimi' });

    expect(status.statusCode).toBe(200);
    expect(JSON.parse(status.body)).toMatchObject({ status: 'available' });
    expect(quotaService.status).toHaveBeenCalledWith(expect.objectContaining({
      webId: WEB_ID,
      deployment: 'cloud',
      provider: 'kimi',
      credentialIri: kimiCredential.credentialIri,
      refresh: false,
    }));

    const refresh = response();
    await routes['POST /api/ai/gateway/providers/:provider/quota/refresh'](request(
      { type: 'solid', webId: WEB_ID },
      { credentialIri: kimiCredential.credentialIri },
      '/api/ai/gateway/providers/kimi/quota/refresh',
    ), refresh, { provider: 'kimi' });
    expect(refresh.statusCode).toBe(200);
    expect(quotaService.status).toHaveBeenLastCalledWith(expect.objectContaining({
      refresh: true,
    }));
  });

  it('rejects gateway-key principals from provider quota management routes', async () => {
    const { server, routes } = createServer();
    registerAiGatewayManagementRoutes(server, {
      repository: new InMemoryGatewayAccessKeyRepository(),
      deployment: 'cloud',
      quotaService: { status: vi.fn() } as never,
    });
    const res = response();

    await routes['GET /api/ai/gateway/providers/:provider/quota/status'](request({
      type: 'solid',
      webId: WEB_ID,
      viaGatewayApiKey: true,
    } as any), res, { provider: 'kimi' });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'Gateway API keys cannot manage provider quota state' });
  });
});
