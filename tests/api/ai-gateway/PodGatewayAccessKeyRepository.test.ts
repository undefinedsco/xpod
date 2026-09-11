import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../src/api/auth/AuthContext';
import {
  gatewayAccessKeyDescriptor,
  gatewayAccessKeyResource,
  UDFS,
  type GatewayAccessKeyRow,
} from '@undefineds.co/models';
import { AesGatewayKeyLocatorCodec } from '../../../src/api/ai-gateway/auth/GatewayKeyLocatorCodec';
import {
  PodGatewayAccessKeyRepository,
  type PodGatewayAccessKeyRepositoryOptions,
} from '../../../src/api/ai-gateway/auth/PodGatewayAccessKeyRepository';
import { createGatewayApiKey } from '../../../src/api/ai-gateway/auth/GatewayApiKey';
import { GatewayApiKeyAuthenticator, type GatewayAccessKeyRepository } from '../../../src/api/ai-gateway/auth/GatewayApiKeyAuthenticator';
import '../../../src/runtime/configure-drizzle-solid';

type GatewayAccessKeyTestDb = Awaited<ReturnType<NonNullable<PodGatewayAccessKeyRepositoryOptions['dbFactory']>>>;

describe('PodGatewayAccessKeyRepository', () => {
  it('persists CSS credentials only in the companion and supports list, reveal and removal', async () => {
    const { repository, auth, inserted, requests } = cssCompanionFixture();
    const record = cssRecord(repository, auth.webId);
    await repository.create(record, { auth });
    expect(inserted).toEqual([]);
    expect(await repository.findById(record.id, { auth })).toMatchObject({
      kind: 'client-credentials', owner: auth.webId, credentialResource: record.credentialResource,
      secretHash: '', scopes: [],
    });
    const listed = await repository.listByOwner(auth.webId, { auth });
    expect(listed).toHaveLength(1);
    expect(listed[0].plaintext).toBeUndefined();
    expect(await repository.revealPlaintext(record.id, { auth })).toBe(record.plaintext);
    await expect(repository.setEnabled(record.id, false, new Date(), { auth })).rejects.toThrow('client_credentials_suspension_unsupported');
    expect(await repository.delete(record.id, { auth })).toBe(true);
    expect(await repository.listByOwner(auth.webId, { auth })).toEqual([]);
    expect(await repository.findById(record.id, { auth })).toBeUndefined();
    expect(requests.filter((item) => item.method === 'PUT').every((item) =>
      item.headers.has('if-match') || item.headers.get('if-none-match') === '*')).toBe(true);
  });

  it('retries conflicting companion writes without losing concurrently registered credentials', async () => {
    const { repository, auth } = cssCompanionFixture();
    const first = cssRecord(repository, auth.webId);
    const second = cssRecord(repository, auth.webId);
    await Promise.all([repository.create(first, { auth }), repository.create(second, { auth })]);
    const listed = await repository.listByOwner(auth.webId, { auth });
    expect(listed.map((item) => item.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('does not overwrite a companion that could not be read', async () => {
    const owner = 'https://id.example/alice/profile/card#me';
    const trustedFetch = vi.fn(async () => new Response(null, { status: 500 }));
    const repository = new PodGatewayAccessKeyRepository({
      locatorCodec: new AesGatewayKeyLocatorCodec('test-locator-secret'),
      internalPodAccess: { getTrustedFetch: async () => trustedFetch as typeof fetch },
      podBaseUrlResolver: async () => 'https://alice.nodes.example/',
      dbFactory: async () => fakeGatewayDb({ inserted: [] }),
    });
    await expect(repository.create(cssRecord(repository, owner), {
      auth: { type: 'solid', webId: owner, tokenType: 'DPoP' },
    })).rejects.toThrow('gateway_key_secret_read_failed');
    expect(trustedFetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed when an existing companion does not provide a strong ETag', async () => {
    const owner = 'https://id.example/alice/profile/card#me';
    const trustedFetch = vi.fn(async () => new Response(JSON.stringify({ version: 1, keys: {} }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    const repository = new PodGatewayAccessKeyRepository({
      locatorCodec: new AesGatewayKeyLocatorCodec('test-locator-secret'),
      internalPodAccess: { getTrustedFetch: async () => trustedFetch as typeof fetch },
      podBaseUrlResolver: async () => 'https://alice.nodes.example/',
      dbFactory: async () => fakeGatewayDb({ inserted: [] }),
    });
    await expect(repository.create(cssRecord(repository, owner), {
      auth: { type: 'solid', webId: owner, tokenType: 'DPoP' },
    })).rejects.toThrow('gateway_key_secret_etag_required');
    expect(trustedFetch).toHaveBeenCalledTimes(1);
  });

  it('never authenticates a CSS companion record using the legacy key verifier', async () => {
    const issued = await createGatewayApiKey({ deployment: 'cloud' });
    const repository = {
      findById: async () => ({ kind: 'client-credentials', secretHash: issued.record.secretHash }),
      touchLastUsed: vi.fn(),
    } as unknown as GatewayAccessKeyRepository;
    const authenticator = new GatewayApiKeyAuthenticator({ repository, deployment: 'cloud' });
    const result = await authenticator.authenticate({
      headers: { authorization: `Bearer ${issued.plaintext}` },
    } as import('node:http').IncomingMessage);
    expect(result.success).toBe(false);
    expect(repository.touchLastUsed).not.toHaveBeenCalled();
  });

  it('installs the shared model contract required for reversible key suspension', () => {
    const column = gatewayAccessKeyResource.columns.disabledAt;
    expect(column).toBeDefined();
    expect(column.getPredicate()).toBe(UDFS.disabledAt);
    expect(gatewayAccessKeyDescriptor.fields.disabledAt).toMatchObject({
      type: 'timestamp',
      predicate: UDFS.disabledAt,
    });
    expect(gatewayAccessKeyDescriptor.writableFields).toContain('disabledAt');
  });

  it.each([
    'https://alice.nodes.example/',
    'https://pods.example/alice/',
    'https://pods.example/team/alice/',
  ])('keeps the real ORM on the resolved Pod %s and the key document query endpoint', async (podUrl) => {
    const owner = 'https://id.example/alice/profile/card#me';
    const endpoint = `${podUrl}.data/ai/gateway/access-keys.ttl/-/sparql`;
    const companion = `${podUrl}.data/ai/gateway/access-key-secrets.json`;
    const requested: string[] = [];
    const hostedFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      if (url === companion) return new Response(null, { status: 404 });
      if (url.split('?')[0] !== endpoint) {
        throw new Error(`Unexpected hosted resource: ${url}`);
      }
      return new Response(JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }), {
        headers: { 'Content-Type': 'application/sparql-results+json' },
      });
    });
    const repository = new PodGatewayAccessKeyRepository({
      locatorCodec: new AesGatewayKeyLocatorCodec('test-locator-secret'),
      internalPodAccess: { getTrustedFetch: async () => hostedFetch as unknown as typeof fetch },
      podBaseUrlResolver: async () => podUrl,
    });

    await expect(repository.listByOwner(owner, {
      auth: { type: 'solid', webId: owner, tokenType: 'DPoP' },
    })).resolves.toEqual([]);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every(url => url.split('?')[0] === endpoint || url === companion)).toBe(true);
  });

  it('uses the owner-bound hosted route for an interactive DPoP caller', async () => {
    const owner = 'https://id.example/alice/profile/card#me';
    const podUrl = 'https://alice.nodes.example/';
    const auth: AuthContext = { type: 'solid', webId: owner, tokenType: 'DPoP', accessToken: 'request-bound-token', dpopProof: 'request-bound-proof' };
    const hostedFetch = vi.fn(async () => new Response('', { status: 404 }));
    const getTrustedFetch = vi.fn(async () => hostedFetch as unknown as typeof fetch);
    const dbFactory = vi.fn(async () => fakeGatewayDb({ inserted: [] }));
    const repository = new PodGatewayAccessKeyRepository({
      locatorCodec: new AesGatewayKeyLocatorCodec('test-locator-secret'),
      internalPodAccess: { getTrustedFetch },
      podBaseUrlResolver: async () => podUrl,
      dbFactory,
    });

    await expect(repository.listByOwner(owner, { auth })).resolves.toEqual([]);
    expect(getTrustedFetch).toHaveBeenCalledTimes(1);
    expect(getTrustedFetch).toHaveBeenCalledWith(owner, auth, { podBaseUrl: podUrl });
    expect(dbFactory).toHaveBeenCalledWith(expect.objectContaining({ owner, auth, podUrl, fetch: expect.any(Function) }));
  });

  it('does not fall back to replaying a DPoP proof when hosted access is unavailable', async () => {
    const owner = 'https://id.example/alice/profile/card#me';
    const dbFactory = vi.fn(async () => fakeGatewayDb({ inserted: [] }));
    const repository = new PodGatewayAccessKeyRepository({
      locatorCodec: new AesGatewayKeyLocatorCodec('test-locator-secret'),
      podBaseUrlResolver: async () => 'https://alice.nodes.example/',
      dbFactory,
    });
    await expect(repository.listByOwner(owner, {
      auth: { type: 'solid', webId: owner, tokenType: 'DPoP', accessToken: 'token', dpopProof: 'proof' },
    })).rejects.toThrow('caller_dpop_replay_unsupported');
    expect(dbFactory).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'solid', webId: 'https://id.example/bob/profile/card#me', tokenType: 'DPoP' },
    { type: 'node', nodeId: 'node-alice', accountId: 'alice' },
    undefined,
  ] as Array<AuthContext | undefined>)('rejects a different owner or non-Solid caller before requesting hosted access: %s', async (auth) => {
    const getTrustedFetch = vi.fn(async () => fetch);
    const repository = new PodGatewayAccessKeyRepository({
      locatorCodec: new AesGatewayKeyLocatorCodec('test-locator-secret'),
      internalPodAccess: { getTrustedFetch },
      podBaseUrlResolver: async () => 'https://alice.nodes.example/',
      dbFactory: async () => fakeGatewayDb({ inserted: [] }),
    });
    await expect(repository.listByOwner('https://id.example/alice/profile/card#me', { auth })).rejects.toThrow();
    expect(getTrustedFetch).not.toHaveBeenCalled();
  });

  it('stores shared key rows and recoverable plaintext in the resolved local Pod, not the WebID origin', async () => {
    const owner = 'https://id.undefineds.co/alice/profile/card#me';
    const localPod = 'http://127.0.0.1:3000/alice/';
    const dbInputs: Array<{ owner: string; podUrl: string }> = [];
    const inserted: unknown[] = [];
    const fetchedUrls: string[] = [];
    const putBodies: string[] = [];
    const trustedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      fetchedUrls.push(url);
      if (init?.method === 'PUT') {
        putBodies.push(String(init.body));
        return new Response(null, { status: 204 });
      }
      return new Response('', { status: 404 });
    });

    const repository = new PodGatewayAccessKeyRepository({
      locatorCodec: new AesGatewayKeyLocatorCodec('test-locator-secret'),
      internalPodAccess: {
        getTrustedFetch: vi.fn(async (_owner, _auth, context) => {
          expect(context?.podBaseUrl).toBe(localPod);
          return trustedFetch as unknown as typeof fetch;
        }),
      },
      podBaseUrlResolver: vi.fn(async () => localPod),
      dbFactory: async (input) => {
        dbInputs.push({ owner: input.owner, podUrl: input.podUrl });
        return fakeGatewayDb({ inserted });
      },
    });

    const keyId = repository.createKeyId!(owner, 'local');
    const issued = await createGatewayApiKey({ deployment: 'local', keyId });
    const record = await repository.create({
      id: issued.record.id,
      owner,
      secretHash: issued.record.secretHash,
      deployment: 'local',
      scopes: ['models:read', 'inference:write'],
      createdAt: new Date('2026-08-25T00:00:00.000Z'),
      name: 'Acceptance key',
      plaintext: issued.plaintext,
    }, {
      internalPodAccess: { reason: 'gateway-key-verifier' },
    });

    expect(record.owner).toBe(owner);
    expect(dbInputs).toEqual([{ owner, podUrl: localPod }]);
    expect(inserted).toHaveLength(1);
    expect(fetchedUrls).toContain('http://127.0.0.1:3000/alice/.data/ai/gateway/access-key-secrets.json');
    expect(JSON.parse(putBodies.at(-1)!)).toMatchObject({
      version: 1,
      keys: {
        [keyId]: {
          plaintext: issued.plaintext,
        },
      },
    });
  });

  it('reveals plaintext from the Xpod companion resource', async () => {
    const owner = 'https://id.undefineds.co/alice/profile/card#me';
    const localPod = 'http://127.0.0.1:3000/alice/';
    const repository = new PodGatewayAccessKeyRepository({
      locatorCodec: new AesGatewayKeyLocatorCodec('test-locator-secret'),
      internalPodAccess: {
        getTrustedFetch: vi.fn(async () => (async () => new Response(JSON.stringify({
          version: 1,
          keys: {
            [keyId]: {
              plaintext: 'xpod_gw_v1_local_example_secret',
              createdAt: '2026-08-25T00:00:00.000Z',
            },
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch),
      },
      podBaseUrlResolver: vi.fn(async () => localPod),
      dbFactory: async (input) => {
        expect(input.podUrl).toBe(localPod);
        return fakeGatewayDb({ inserted: [] });
      },
    });
    const keyId = repository.createKeyId!(owner, 'local');

    await expect(repository.revealPlaintext(keyId, {
      internalPodAccess: { reason: 'gateway-key-verifier' },
    })).resolves.toBe('xpod_gw_v1_local_example_secret');
  });

  it('permanently revokes a deleted key without re-exposing it through physical-delete caching', async () => {
    const owner = 'https://id.undefineds.co/alice/profile/card#me';
    const localPod = 'http://127.0.0.1:3000/alice/';
    const codec = new AesGatewayKeyLocatorCodec('test-locator-secret');
    const keyId = codec.encode({
      owner,
      deployment: 'local',
      keyId: 'gak_delete-security-boundary',
    });
    const baseDb = fakeGatewayDb({ inserted: [] });
    const updateById = vi.fn();
    const updateByIdDb = async <TRow>(
      resource: typeof gatewayAccessKeyResource,
      id: string,
      patch: unknown,
    ): Promise<TRow | null> => {
      updateById(resource, id, patch);
      return baseDb.updateById<TRow>(resource, id, patch);
    };
    const deleteById = vi.fn(async () => true);
    const trustedFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({
        version: 1,
        keys: {
          [keyId]: {
            plaintext: 'xpod_gw_v1_local_delete_secret',
            createdAt: '2026-08-29T00:00:00.000Z',
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: '"legacy-secret-v1"' },
      });
    });
    const repository = new PodGatewayAccessKeyRepository({
      locatorCodec: codec,
      internalPodAccess: {
        getTrustedFetch: vi.fn(async () => trustedFetch as unknown as typeof fetch),
      },
      podBaseUrlResolver: vi.fn(async () => localPod),
      dbFactory: async () => ({
        ...baseDb,
        updateById: updateByIdDb,
        deleteById,
      }),
    });

    await expect(repository.delete(keyId, {
      auth: { type: 'solid', webId: owner, tokenType: 'DPoP' },
    })).resolves.toBe(true);

    expect(updateById).toHaveBeenCalledWith(
      gatewayAccessKeyResource,
      gatewayAccessKeyResource.buildId({ id: keyId }),
      { revokedAt: expect.any(Date) },
    );
    expect(deleteById).not.toHaveBeenCalled();
  });

  it('normalizes encoded storage IRIs from list results before reveal', async () => {
    const owner = 'https://id.undefineds.co/alice/profile/card#me';
    const localPod = 'http://127.0.0.1:3000/alice/';
    const codec = new AesGatewayKeyLocatorCodec('test-locator-secret');
    const keyId = codec.encode({
      owner,
      deployment: 'local',
      keyId: 'gak_canonical-storage-row',
    });
    const storageId = gatewayAccessKeyResource.buildId({ id: keyId });
    const row = {
      id: encodeURIComponent(storageId),
      owner,
      secretHash: 'hash',
      deployment: 'local',
      scopes: ['models:read', 'inference:write'],
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
      name: 'Canonical row key',
    } as GatewayAccessKeyRow;
    const trustedFetch = vi.fn(async () => new Response(JSON.stringify({
      version: 1,
      keys: {
        [keyId]: {
          plaintext: 'xpod_gw_v1_local_canonical_secret',
          createdAt: '2026-08-28T00:00:00.000Z',
        },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const repository = new PodGatewayAccessKeyRepository({
      locatorCodec: codec,
      internalPodAccess: {
        getTrustedFetch: vi.fn(async () => trustedFetch as unknown as typeof fetch),
      },
      podBaseUrlResolver: vi.fn(async () => localPod),
      dbFactory: async () => ({
        ...fakeGatewayDb({ inserted: [] }),
        select: vi.fn(() => ({
          from: () => ({
            where: () => ({
              execute: vi.fn(async () => [row]),
            }),
          }),
        })),
      }),
    });

    const [listed] = await repository.listByOwner(owner, {
      auth: { type: 'solid', webId: owner, tokenType: 'DPoP' },
    });

    expect(listed.id).toBe(keyId);
    await expect(repository.revealPlaintext(listed.id, {
      auth: { type: 'solid', webId: owner, tokenType: 'DPoP' },
    })).resolves.toBe('xpod_gw_v1_local_canonical_secret');
  });
});

function cssRecord(repository: PodGatewayAccessKeyRepository, owner: string) {
  return {
    id: repository.createKeyId(owner, 'cloud'), owner, kind: 'client-credentials' as const,
    plaintext: `sk-${Buffer.from('client-id:secret').toString('base64')}`,
    credentialResource: 'https://id.example/.account/account/alice/client-credentials/credential-1',
    name: 'Codex', createdAt: new Date('2026-09-09T00:00:00Z'),
    secretHash: '', scopes: [], deployment: 'cloud' as const,
  };
}

function cssCompanionFixture() {
  const auth = { type: 'solid' as const, webId: 'https://id.example/alice/profile/card#me', tokenType: 'DPoP' as const };
  const inserted: unknown[] = [];
  const requests: Array<{ method: string; headers: Headers }> = [];
  let stored: string | undefined;
  let revision = 0;
  const trustedFetch: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    requests.push({ method, headers });
    if (method === 'PUT') {
      const conditionMatches = stored === undefined
        ? headers.get('if-none-match') === '*'
        : headers.get('if-match') === `"${revision}"`;
      if (!conditionMatches) return new Response(null, { status: 412 });
      stored = String(init?.body);
      revision++;
      return new Response(null, { status: 204 });
    }
    return stored === undefined ? new Response(null, { status: 404 }) : new Response(stored, {
      headers: { 'Content-Type': 'application/json', ETag: `"${revision}"` },
    });
  };
  const repository = new PodGatewayAccessKeyRepository({
    locatorCodec: new AesGatewayKeyLocatorCodec('test-locator-secret'),
    internalPodAccess: { getTrustedFetch: async () => trustedFetch },
    podBaseUrlResolver: async () => 'https://alice.nodes.example/',
    dbFactory: async () => fakeGatewayDb({ inserted }),
  });
  return { repository, auth, inserted, requests };
}

function fakeGatewayDb(state: { inserted: unknown[] }): GatewayAccessKeyTestDb {
  return {
    init: vi.fn(async () => {}),
    insert: vi.fn(() => ({
      values: (value: unknown) => ({
        execute: vi.fn(async () => {
          state.inserted.push(value);
          return [value];
        }),
      }),
    })),
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          execute: vi.fn(async () => [] as GatewayAccessKeyRow[]),
        }),
      }),
    })),
    findById: async <TRow>() => null as TRow | null,
    findByIri: async <TRow>() => null as TRow | null,
    updateById: async <TRow>(_resource: typeof gatewayAccessKeyResource, id: string, patch: unknown) => ({
      id,
      owner: 'https://id.undefineds.co/alice/profile/card#me',
      secretHash: 'hash',
      deployment: 'local',
      scopes: [],
      createdAt: new Date(),
      ...(patch as Record<string, unknown>),
    } as TRow),
    deleteById: vi.fn(async () => true),
  };
}
