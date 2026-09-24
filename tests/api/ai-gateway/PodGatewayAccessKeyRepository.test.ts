import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../src/api/auth/AuthContext';
import {
  credentialResource,
  gatewayAccessKeyDescriptor,
  gatewayAccessKeyResource,
  UDFS,
  type CredentialRow,
  type GatewayAccessKeyRow,
} from '@undefineds.co/models';
import { AesGatewayKeyLocatorCodec } from '../../../src/api/ai-gateway/auth/GatewayKeyLocatorCodec';
import {
  PodGatewayAccessKeyRepository,
  clientCredentialProviderId,
  type PodGatewayAccessKeyRepositoryOptions,
} from '../../../src/api/ai-gateway/auth/PodGatewayAccessKeyRepository';
import { createGatewayApiKey } from '../../../src/api/ai-gateway/auth/GatewayApiKey';
import {
  GatewayApiKeyAuthenticator,
  type GatewayAccessKeyRecord,
  type GatewayAccessKeyRepository,
} from '../../../src/api/ai-gateway/auth/GatewayApiKeyAuthenticator';
import { OwnerPodAccess } from '../../../src/api/ai-gateway/pod/OwnerPodAccess';
import type {
  PodInterfaceCredential,
  PodInterfaceKeyStore,
} from '../../../src/api/ai-gateway/pod/PodInterfaceKeyStore';
import '../../../src/runtime/configure-drizzle-solid';
import { createTestSolidSessions } from '../../helpers/solidSessions';

type GatewayAccessKeyTestDb = Awaited<ReturnType<NonNullable<PodGatewayAccessKeyRepositoryOptions['dbFactory']>>>;

type CredentialRowFixture = Partial<CredentialRow> & { id: string };

const OWNER = 'https://id.example/alice/profile/card#me';
const OTHER_OWNER = 'https://id.example/bob/profile/card#me';
const CLOUD_POD = 'https://alice.nodes.example/';
const LOCAL_POD = 'http://127.0.0.1:3000/alice/';
const LOCATOR_SECRET = 'test-locator-secret';
/** The credential document an issued CSS credential is recorded in. */
const CREDENTIAL_DOCUMENT = 'settings/credentials.ttl';
/** The legacy Gateway key document, kept for rows issued before client credentials. */
const LEGACY_KEY_DOCUMENT = 'ai/gateway/access-keys.ttl';
/** The deleted plaintext mirror; nothing may contact it any more. */
const COMPANION_PATH = 'access-key-secrets.json';

describe('PodGatewayAccessKeyRepository', () => {
  it('records an issued CSS credential as a credentialResource row without persisting the wrapper', async () => {
    const { repository, auth, state, requestedUrls } = fixture();
    const record = issuedCredential(repository);

    const created = await repository.create(record, { auth });

    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].resource).toBe(credentialResource);
    expect(state.inserts[0].values).toMatchObject({
      id: credentialResource.buildId({ id: record.id }),
      provider: clientCredentialProviderId(),
      authMode: 'apiKey',
      service: 'xpod-gateway',
      status: 'active',
      label: 'Codex',
      clientCredentialId: 'client-id',
      createdAt: record.createdAt,
      appliedTo: 'codex',
      appliedOn: 'desktop',
      appliedAt: record.appliedAt,
    });
    // `apiKey` stays the empty credential column: the wrapper is never stored.
    expect(Object.keys(state.inserts[0].values)).not.toContain('apiKey');
    expect(JSON.stringify(state.inserts.map((insert) => insert.values))).not.toContain('client-secret');
    expect(JSON.stringify(state.inserts.map((insert) => insert.values))).not.toContain('sk-');
    expect(created).toMatchObject({
      kind: 'client-credentials', owner: OWNER, clientCredentialId: 'client-id', secretHash: '', scopes: [],
    });

    expect(await repository.findById(record.id, { auth })).toMatchObject({
      kind: 'client-credentials', owner: OWNER, clientCredentialId: 'client-id', name: 'Codex',
      appliedTo: 'codex', appliedOn: 'desktop',
    });
    const listed = await repository.listByOwner(OWNER, { auth });
    expect(listed.map((item) => item.id)).toEqual([record.id]);
    expect(listed[0].plaintext).toBeUndefined();
    expect(state.listResources).toContain(credentialResource);

    const lastUsedAt = new Date('2026-09-09T01:00:00.000Z');
    await repository.touchLastUsed(record.id, lastUsedAt, { auth });
    expect(state.updates).toEqual([{
      resource: credentialResource,
      id: credentialResource.buildId({ id: record.id }),
      patch: { lastUsedAt },
    }]);

    await expect(repository.revealPlaintext(record.id, { auth })).resolves.toBeUndefined();
    await expect(repository.setEnabled(record.id, false, new Date(), { auth }))
      .rejects.toThrow('client_credentials_suspension_unsupported');
    await expect(repository.revoke(record.id, new Date(), { auth }))
      .rejects.toThrow('client_credentials_revocation_requires_account');

    await expect(repository.delete(record.id, { auth })).resolves.toBe(true);
    expect(state.deletes).toEqual([{ resource: credentialResource, id: credentialResource.buildId({ id: record.id }) }]);
    expect(await repository.findById(record.id, { auth })).toBeUndefined();
    expect(await repository.listByOwner(OWNER, { auth })).toEqual([]);
    // Listing, revealing and removing never fall back to the deleted plaintext mirror.
    expect(requestedUrls).toEqual([]);
  });

  it('requires a CSS client credential id before writing a credential row', async () => {
    const { repository, auth, state } = fixture();
    const record = issuedCredential(repository, { clientCredentialId: undefined });

    await expect(repository.create(record, { auth })).rejects.toThrow('client_credentials_registration_incomplete');
    expect(state.inserts).toEqual([]);
  });

  it('rejects a credential locator that belongs to another owner or deployment', async () => {
    const { repository, auth, state } = fixture();
    const codec = new AesGatewayKeyLocatorCodec(LOCATOR_SECRET);
    const foreignOwner = codec.encode({ owner: OTHER_OWNER, deployment: 'cloud', keyId: 'gakv1.cloud.foreign' });
    const foreignDeployment = codec.encode({ owner: OWNER, deployment: 'local', keyId: 'gakv1.local.foreign' });

    await expect(repository.create(issuedCredential(repository, { id: foreignOwner }), { auth }))
      .rejects.toThrow('client_credentials_registration_owner_mismatch');
    await expect(repository.create(issuedCredential(repository, { id: foreignDeployment }), { auth }))
      .rejects.toThrow('client_credentials_registration_owner_mismatch');
    expect(state.inserts).toEqual([]);
  });

  it('keeps previously issued credentials when a later credential write fails', async () => {
    const { repository, auth, state } = fixture();
    const first = issuedCredential(repository, { clientCredentialId: 'client-first', name: 'First' });
    await repository.create(first, { auth });

    state.failNextInsert = new Error('pod_write_failed');
    const second = issuedCredential(repository, { clientCredentialId: 'client-second', name: 'Second' });
    await expect(repository.create(second, { auth })).rejects.toThrow('pod_write_failed');

    const listed = await repository.listByOwner(OWNER, { auth });
    expect(listed.map((item) => item.id)).toEqual([first.id]);
    expect(listed[0].clientCredentialId).toBe('client-first');
    // A failed insert must not rewrite or remove the rows that already exist.
    expect(state.updates).toEqual([]);
    expect(state.deletes).toEqual([]);
  });

  it('writes issued credentials additively into the Pod credential document and never the plaintext mirror', async () => {
    const { repository, auth, writes } = realOrmFixture();

    const first = issuedCredential(repository);
    await repository.create(first, { auth });
    const beforeSecond = writes.length;
    const second = issuedCredential(repository);
    await repository.create(second, { auth });

    expect(writes.length).toBeGreaterThan(beforeSecond);
    const issuedWrites = writes.slice(beforeSecond);
    const documentUrl = `${CLOUD_POD}${CREDENTIAL_DOCUMENT}`;
    expect(issuedWrites.every((item) => item.url.split('?')[0] === documentUrl)).toBe(true);
    const body = issuedWrites.map((item) => item.body).join('\n');
    // Additive per-credential insert: it never rewrites the row issued a moment ago.
    expect(body).toMatch(/INSERT DATA/iu);
    expect(body).not.toMatch(/DELETE/iu);
    expect(body).not.toContain(first.id);
    expect(body).toContain(`<${documentUrl}#${second.id}>`);
    expect(body).toContain('#clientCredentialId');
    expect(body).toContain('"client-id"');
    expect(body).toContain('#label');
    expect(body).toContain('"Codex"');
    expect(body).toContain('#service');
    expect(body).toContain('"xpod-gateway"');
    expect(body).toContain('#authMode');
    expect(body).toContain('"apiKey"');
    // The credential is scoped to the derived Xpod gateway provider document.
    expect(body).toContain(`<${CLOUD_POD}settings/providers/xpod-gateway.ttl#this>`);
    expect(body).not.toContain('client-secret');
    expect(writes.every((item) => !item.url.includes(COMPANION_PATH))).toBe(true);
  });

  it('never authenticates an issued CSS credential through the legacy key verifier', async () => {
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
  ])('keeps the real ORM on the resolved Pod %s credential and legacy key endpoints', async (podUrl) => {
    const owner = OWNER;
    const legacyEndpoint = `${podUrl}.data/${LEGACY_KEY_DOCUMENT}/-/sparql`;
    const credentialEndpoint = `${podUrl.replace(/\/$/u, '')}/settings/-/sparql`;
    const requested: string[] = [];
    const hostedFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      if (url.split('?')[0] !== legacyEndpoint && url.split('?')[0] !== credentialEndpoint) {
        throw new Error(`Unexpected hosted resource: ${url}`);
      }
      return emptySparqlResponse();
    });
    const repository = new PodGatewayAccessKeyRepository({
      locatorCodec: new AesGatewayKeyLocatorCodec(LOCATOR_SECRET),
      podAccess: { getPodFetch: async () => hostedFetch as unknown as typeof fetch },
      podBaseUrlResolver: async () => podUrl,
    });

    await expect(repository.listByOwner(owner, {
      auth: { type: 'solid', webId: owner, tokenType: 'DPoP' },
    })).resolves.toEqual([]);
    const paths = requested.map((url) => url.split('?')[0]);
    expect(paths).toContain(legacyEndpoint);
    expect(paths).toContain(credentialEndpoint);
    expect(paths.every((path) => path === legacyEndpoint || path === credentialEndpoint)).toBe(true);
    expect(requested.every((url) => !url.includes(COMPANION_PATH))).toBe(true);
    // Credential rows are listed only for the derived Xpod gateway provider.
    const credentialQuery = requested
      .map((url) => new URL(url))
      .find((url) => `${url.origin}${url.pathname}` === credentialEndpoint)
      ?.searchParams.get('query') ?? '';
    expect(credentialQuery).toContain(`<${podUrl.replace(/\/$/u, '')}/settings/providers/xpod-gateway.ttl#this>`);
  });

  it('uses owner-bound Pod access for an interactive DPoP caller', async () => {
    const owner = OWNER;
    const podUrl = CLOUD_POD;
    const auth: AuthContext = { type: 'solid', webId: owner, tokenType: 'DPoP', accessToken: 'request-bound-token', dpopProof: 'request-bound-proof' };
    const podFetch = vi.fn(async () => new Response('', { status: 404 }));
    const getPodFetch = vi.fn(async () => podFetch as unknown as typeof fetch);
    const dbFactory = vi.fn(
      async (_input: NonNullable<Parameters<NonNullable<PodGatewayAccessKeyRepositoryOptions['dbFactory']>>[0]>) =>
        fakeDb(emptyState()),
    );
    const repository = new PodGatewayAccessKeyRepository({
      locatorCodec: new AesGatewayKeyLocatorCodec(LOCATOR_SECRET),
      podAccess: { getPodFetch },
      podBaseUrlResolver: async () => podUrl,
      dbFactory,
    });

    await expect(repository.listByOwner(owner, { auth })).resolves.toEqual([]);
    expect(getPodFetch).toHaveBeenCalledTimes(1);
    // The caller travels as one context object; the Pod base URL rides along so the
    // provider can address the resolved Pod rather than the WebID origin.
    expect(getPodFetch).toHaveBeenCalledWith(owner, { auth, podBaseUrl: podUrl });
    expect(dbFactory).toHaveBeenCalledWith(expect.objectContaining({ owner, auth, podUrl, fetch: expect.any(Function) }));
    const input = dbFactory.mock.calls[0][0] as {
      credentialListResource?: unknown;
    };
    // A caller-supplied factory receives the schema resources; the default
    // factory derives the per-Pod SPARQL endpoint (covered above).
    expect(input.credentialListResource).toBe(credentialResource);
  });

  it('does not fall back to replaying a DPoP proof when no Pod interface key is available', async () => {
    const owner = OWNER;
    const dpopAuth: AuthContext = {
      type: 'solid', webId: owner, tokenType: 'DPoP', accessToken: 'token', dpopProof: 'proof',
    };
    const dbFactory = vi.fn(async () => fakeDb(emptyState()));

    // No Pod access installed at all: the repository still refuses to turn the caller's
    // own DPoP-bound proof into a Pod request, and says why.
    const unconfigured = new PodGatewayAccessKeyRepository({
      locatorCodec: new AesGatewayKeyLocatorCodec(LOCATOR_SECRET),
      podBaseUrlResolver: async () => CLOUD_POD,
      dbFactory,
    });
    await expect(unconfigured.listByOwner(owner, { auth: dpopAuth }))
      .rejects.toThrow('caller_dpop_replay_unsupported');

    // With owner Pod access installed the proof is still never replayed: the provider
    // looks for the owner's granted interface key, and this owner granted none.
    const reads: string[] = [];
    const upstream = vi.fn(async () => new Response(null, { status: 404 }));
    const configured = new PodGatewayAccessKeyRepository({
      locatorCodec: new AesGatewayKeyLocatorCodec(LOCATOR_SECRET),
      podAccess: ownerPodAccess(upstream as unknown as typeof fetch, async (ownerWebId) => {
        reads.push(ownerWebId);
        return undefined;
      }),
      podBaseUrlResolver: async () => CLOUD_POD,
      dbFactory,
    });
    await expect(configured.listByOwner(owner, { auth: dpopAuth }))
      .rejects.toThrow('caller_dpop_replay_unsupported');

    expect(reads).toEqual([owner]);
    expect(upstream).not.toHaveBeenCalled();
    expect(dbFactory).not.toHaveBeenCalled();
  });

  it('reports a missing Pod interface key for a same-owner Bearer session without DPoP evidence', async () => {
    const keyReads: string[] = [];
    const upstream = vi.fn(async () => new Response(null, { status: 404 }));
    const dbFactory = vi.fn(async () => fakeDb(emptyState()));
    const repository = new PodGatewayAccessKeyRepository({
      locatorCodec: new AesGatewayKeyLocatorCodec(LOCATOR_SECRET),
      podAccess: ownerPodAccess(upstream as unknown as typeof fetch, async (ownerWebId) => {
        keyReads.push(ownerWebId);
        return undefined;
      }),
      podBaseUrlResolver: async () => CLOUD_POD,
      dbFactory,
    });

    // A gateway API key principal carries no Pod credential of its own, so the owner's
    // granted interface key is the only way in - and this owner granted none.
    await expect(repository.listByOwner(OWNER, {
      auth: {
        type: 'solid',
        webId: OWNER,
        viaGatewayApiKey: true,
        gatewayRuntimeAccess: true,
        gatewayKeyId: 'gak_bearer',
        tokenType: 'Bearer',
      },
    })).rejects.toThrow('pod_interface_key_missing');

    expect(keyReads).toEqual([OWNER]);
    expect(upstream).not.toHaveBeenCalled();
    expect(dbFactory).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: 'solid', webId: OTHER_OWNER, tokenType: 'DPoP' }, 'caller_owner_mismatch', []],
    [{ type: 'node', nodeId: 'node-alice', accountId: 'alice' }, 'caller_pod_access_unavailable', [OWNER]],
    [undefined, 'caller_pod_access_unavailable', [OWNER]],
  ] as Array<[AuthContext | undefined, string, string[]]>)(
    'rejects a different owner or non-Solid caller before reaching the Pod: %s',
    async (auth, expectedError, expectedKeyReads) => {
      const reads: string[] = [];
      const upstream = vi.fn(async () => new Response(null, { status: 404 }));
      const podAccess = ownerPodAccess(upstream as unknown as typeof fetch, async (ownerWebId) => {
        reads.push(ownerWebId);
        return undefined;
      });
      const getPodFetch = vi.spyOn(podAccess, 'getPodFetch');
      const dbFactory = vi.fn(async () => fakeDb(emptyState()));
      const repository = new PodGatewayAccessKeyRepository({
        locatorCodec: new AesGatewayKeyLocatorCodec(LOCATOR_SECRET),
        podAccess,
        podBaseUrlResolver: async () => CLOUD_POD,
        dbFactory,
      });

      await expect(repository.listByOwner(OWNER, { auth })).rejects.toThrow(expectedError);
      // A caller authenticated as somebody else never borrows this owner's granted key;
      // a caller with no Solid identity is unattached work, which may look for that key.
      expect(reads).toEqual(expectedKeyReads);
      expect(getPodFetch).toHaveBeenCalledWith(
        OWNER,
        auth ? { auth, podBaseUrl: CLOUD_POD } : { podBaseUrl: CLOUD_POD },
      );
      expect(upstream).not.toHaveBeenCalled();
      expect(dbFactory).not.toHaveBeenCalled();
    },
  );

  it('stores the credential row in the resolved local Pod, not the WebID origin', async () => {
    const owner = 'https://id.undefineds.co/alice/profile/card#me';
    const podUrl = LOCAL_POD;
    const dbInputs: Array<{ owner: string; podUrl: string }> = [];
    const state = emptyState();
    const trustedFetch = vi.fn(async () => new Response(null, { status: 404 }));
    const repository = new PodGatewayAccessKeyRepository({
      locatorCodec: new AesGatewayKeyLocatorCodec(LOCATOR_SECRET),
      podAccess: {
        getPodFetch: vi.fn(async (_owner, context) => {
          expect(context?.podBaseUrl).toBe(podUrl);
          return trustedFetch as unknown as typeof fetch;
        }),
      },
      podBaseUrlResolver: vi.fn(async () => podUrl),
      dbFactory: async (input) => {
        dbInputs.push({ owner: input.owner, podUrl: input.podUrl });
        return fakeDb(state);
      },
    });

    const created = await repository.create(issuedCredential(repository, { owner }), {
      auth: { type: 'solid', webId: owner, tokenType: 'DPoP' },
    });

    expect(created.owner).toBe(owner);
    expect(dbInputs).toEqual([{ owner, podUrl }]);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].resource).toBe(credentialResource);
    expect(JSON.stringify(state.inserts.map((insert) => insert.values))).not.toContain('sk-');
    // Nothing is read from or written to the deleted plaintext mirror.
    expect(trustedFetch).not.toHaveBeenCalled();
  });

  it('stores a legacy shared key row without its plaintext', async () => {
    const { repository, auth, state } = fixture();
    const keyId = repository.createKeyId(OWNER, 'cloud');
    const issued = await createGatewayApiKey({ deployment: 'cloud', keyId });

    const created = await repository.create({
      id: issued.record.id,
      owner: OWNER,
      secretHash: issued.record.secretHash,
      deployment: 'cloud',
      scopes: ['models:read'],
      createdAt: new Date('2026-09-09T00:00:00.000Z'),
      name: 'Legacy key',
      plaintext: issued.plaintext,
    }, { auth });

    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].resource).toBe(gatewayAccessKeyResource);
    expect(state.inserts[0].values).toMatchObject({
      id: gatewayAccessKeyResource.buildId({ id: issued.record.id }),
      owner: OWNER,
      deployment: 'cloud',
      scopes: ['models:read'],
      name: 'Legacy key',
    });
    expect(Object.keys(state.inserts[0].values)).not.toContain('plaintext');
    expect(Object.keys(state.inserts[0].values)).not.toContain('apiKey');
    expect(JSON.stringify(state.inserts.map((insert) => insert.values))).not.toContain(issued.plaintext);
    // The caller still receives the wrapper it just created; it is simply not kept.
    expect(created.plaintext).toBe(issued.plaintext);
    expect(created.id).toBe(issued.record.id);
  });

  it('has nothing to reveal for an issued credential', async () => {
    const { repository, auth, requestedUrls } = fixture();
    const record = issuedCredential(repository);
    await repository.create(record, { auth });

    await expect(repository.revealPlaintext(record.id, { auth })).resolves.toBeUndefined();
    await expect(repository.revealPlaintext(record.id, {
      gatewayKeyVerification: { reason: 'gateway-key-verifier' },
    })).resolves.toBeUndefined();
    // Revealing never reaches the Pod: there is no stored copy to read.
    expect(requestedUrls).toEqual([]);
  });

  it('permanently revokes a deleted key without re-exposing it through physical-delete caching', async () => {
    const codec = new AesGatewayKeyLocatorCodec(LOCATOR_SECRET);
    const keyId = codec.encode({ owner: OWNER, deployment: 'local', keyId: 'gak_delete-security-boundary' });
    const { repository, auth, state } = fixture({ podUrl: LOCAL_POD, codec });

    await expect(repository.delete(keyId, { auth })).resolves.toBe(true);

    expect(state.updates).toEqual([{
      resource: gatewayAccessKeyResource,
      id: gatewayAccessKeyResource.buildId({ id: keyId }),
      patch: { revokedAt: expect.any(Date) },
    }]);
    expect(state.deletes).toEqual([]);
  });

  it('normalizes encoded storage IRIs from list results and keeps them owner-scoped', async () => {
    const codec = new AesGatewayKeyLocatorCodec(LOCATOR_SECRET);
    const keyId = codec.encode({ owner: OWNER, deployment: 'cloud', keyId: 'gak_canonical-credential-row' });
    const foreignKeyId = codec.encode({ owner: OTHER_OWNER, deployment: 'cloud', keyId: 'gak_foreign-credential-row' });
    const { repository, auth, state } = fixture({ codec });
    state.credentialRows.push({
      id: encodeURIComponent(credentialResource.buildId({ id: keyId })),
      provider: clientCredentialProviderId(),
      clientCredentialId: 'client-canonical',
      label: 'Canonical credential',
      status: 'active',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
    } as CredentialRowFixture);
    state.credentialRows.push({
      id: credentialResource.buildId({ id: foreignKeyId }),
      provider: clientCredentialProviderId(),
      clientCredentialId: 'client-foreign',
      label: 'Foreign credential',
      status: 'active',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
    } as CredentialRowFixture);

    const listed = await repository.listByOwner(OWNER, { auth });

    expect(listed.map((item) => item.id)).toEqual([keyId]);
    expect(listed[0]).toMatchObject({
      kind: 'client-credentials',
      owner: OWNER,
      clientCredentialId: 'client-canonical',
      name: 'Canonical credential',
      status: 'active',
    });
    expect(listed[0].plaintext).toBeUndefined();
  });

  it('skips credential rows that do not identify a CSS credential', async () => {
    const codec = new AesGatewayKeyLocatorCodec(LOCATOR_SECRET);
    const { repository, auth, state } = fixture({ codec });
    state.credentialRows.push({
      id: credentialResource.buildId({ id: codec.encode({ owner: OWNER, deployment: 'cloud', keyId: 'gak_missing-client' }) }),
      provider: clientCredentialProviderId(),
      label: 'Missing client id',
      createdAt: new Date('2026-08-28T00:00:00.000Z'),
    } as CredentialRowFixture);
    state.credentialRows.push({
      id: credentialResource.buildId({ id: codec.encode({ owner: OWNER, deployment: 'cloud', keyId: 'gak_missing-created' }) }),
      provider: clientCredentialProviderId(),
      clientCredentialId: 'client-missing-created',
    } as CredentialRowFixture);

    await expect(repository.listByOwner(OWNER, { auth })).resolves.toEqual([]);
  });
});

interface FixtureState {
  inserts: Array<{ resource: unknown; values: Record<string, unknown> }>;
  credentialRows: CredentialRowFixture[];
  legacyRows: GatewayAccessKeyRow[];
  updates: Array<{ resource: unknown; id: string; patch: Record<string, unknown> }>;
  deletes: Array<{ resource: unknown; id: string }>;
  listResources: unknown[];
  failNextInsert?: Error;
}

interface FixtureOptions {
  podUrl?: string;
  codec?: AesGatewayKeyLocatorCodec;
  owner?: string;
}

function fixture(options: FixtureOptions = {}) {
  const podUrl = options.podUrl ?? CLOUD_POD;
  const owner = options.owner ?? OWNER;
  const codec = options.codec ?? new AesGatewayKeyLocatorCodec(LOCATOR_SECRET);
  const state = emptyState();
  const requestedUrls: string[] = [];
  const trustedFetch = vi.fn(async (input: RequestInfo | URL) => {
    requestedUrls.push(input instanceof Request ? input.url : String(input));
    return new Response(null, { status: 404 });
  });
  const repository = new PodGatewayAccessKeyRepository({
    locatorCodec: codec,
    podAccess: { getPodFetch: async () => trustedFetch as unknown as typeof fetch },
    podBaseUrlResolver: async () => podUrl,
    dbFactory: async () => fakeDb(state),
  });
  const auth: AuthContext = { type: 'solid', webId: owner, tokenType: 'DPoP' };
  return { repository, auth, state, requestedUrls, podUrl };
}

function realOrmFixture() {
  const owner = OWNER;
  const podUrl = CLOUD_POD;
  const writes: Array<{ url: string; method: string; body: string }> = [];
  const hostedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/-/sparql')) {
      return emptySparqlResponse();
    }
    writes.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : String(init?.body ?? ''),
    });
    return new Response(null, { status: 204 });
  });
  const repository = new PodGatewayAccessKeyRepository({
    locatorCodec: new AesGatewayKeyLocatorCodec(LOCATOR_SECRET),
    podAccess: { getPodFetch: async () => hostedFetch as unknown as typeof fetch },
    podBaseUrlResolver: async () => podUrl,
  });
  const auth: AuthContext = { type: 'solid', webId: owner, tokenType: 'DPoP' };
  return { repository, auth, writes, podUrl };
}

/**
 * The production owner-Pod access provider, with only the key store stubbed out.
 *
 * `read` is the owner's granted interface key; the rest of the class decides which
 * caller may use it, so tests exercise the real refusal rules.
 */
function ownerPodAccess(
  upstream: typeof fetch,
  read: (owner: string) => Promise<PodInterfaceCredential | undefined> = async () => undefined,
): OwnerPodAccess {
  return new OwnerPodAccess({
    keys: { read } as unknown as PodInterfaceKeyStore,
    sessions: createTestSolidSessions({
      tokenEndpoint: 'https://pod.example/.oidc/token',
      fetch: upstream,
    }),
    fetch: upstream,
  });
}

function issuedCredential(
  repository: PodGatewayAccessKeyRepository,
  overrides: Partial<GatewayAccessKeyRecord> = {},
): GatewayAccessKeyRecord {
  const owner = overrides.owner ?? OWNER;
  return {
    id: repository.createKeyId(owner, 'cloud'),
    owner,
    kind: 'client-credentials',
    clientCredentialId: 'client-id',
    name: 'Codex',
    createdAt: new Date('2026-09-09T00:00:00.000Z'),
    deployment: 'cloud',
    scopes: [],
    secretHash: '',
    appliedTo: 'codex',
    appliedOn: 'desktop',
    appliedAt: new Date('2026-09-09T00:05:00.000Z'),
    plaintext: `sk-${Buffer.from('client-id:client-secret').toString('base64')}`,
    ...overrides,
  };
}

function emptyState(): FixtureState {
  return {
    inserts: [],
    credentialRows: [],
    legacyRows: [],
    updates: [],
    deletes: [],
    listResources: [],
  };
}

function fakeDb(state: FixtureState): GatewayAccessKeyTestDb {
  const rowsFor = (resource: unknown): Array<{ id: string }> =>
    resource === credentialResource ? state.credentialRows : state.legacyRows;
  return {
    init: vi.fn(async () => {}),
    insert: vi.fn((resource: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        execute: vi.fn(async () => {
          if (state.failNextInsert) {
            const failure = state.failNextInsert;
            state.failNextInsert = undefined;
            throw failure;
          }
          state.inserts.push({ resource, values });
          if (resource === credentialResource) {
            state.credentialRows.push(values as CredentialRowFixture);
          }
          return [values];
        }),
      }),
    })),
    select: vi.fn(() => ({
      from: (resource: unknown) => ({
        where: () => ({
          execute: vi.fn(async () => {
            state.listResources.push(resource);
            return rowsFor(resource) as unknown as GatewayAccessKeyRow[];
          }),
        }),
      }),
    })),
    findById: async <TRow>(resource: unknown, id: string) => {
      const row = rowsFor(resource).find((candidate) => decodeId(String(candidate.id)) === decodeId(id));
      return (row ?? null) as TRow | null;
    },
    findByIri: async <TRow>() => null as TRow | null,
    updateById: async <TRow>(resource: unknown, id: string, patch: unknown) => {
      state.updates.push({ resource, id, patch: patch as Record<string, unknown> });
      return { id, ...(patch as Record<string, unknown>) } as TRow;
    },
    deleteById: vi.fn(async (resource: unknown, id: string) => {
      state.deletes.push({ resource, id });
      if (resource === credentialResource) {
        state.credentialRows = state.credentialRows.filter(
          (candidate) => decodeId(String(candidate.id)) !== decodeId(id),
        );
      }
      return true;
    }),
  };
}

function emptySparqlResponse(): Response {
  return new Response(JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }), {
    headers: { 'Content-Type': 'application/sparql-results+json' },
  });
}

function decodeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
