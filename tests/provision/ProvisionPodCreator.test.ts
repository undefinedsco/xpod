import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { ProvisionPodCreator } from '../../src/provision/ProvisionPodCreator';
import { ProvisionCodeCodec } from '../../src/provision/ProvisionCodeCodec';
import { createProvisionReceipt, deriveProvisionReceiptSecret } from '../../src/provision/ProvisionReceiptCodec';
import { XPOD_REMOTE_PROVISIONED } from '../../src/provision/ProvisionPodStore';

const mockFetch = vi.fn();
const realFetch = globalThis.fetch;

describe('ProvisionPodCreator', () => {
  const baseUrl = 'https://cloud.example.com/';
  const spUrl = 'https://sp.example.com';
  const serviceToken = 'st-secret';
  const nodeId = 'node-1';
  const codec = new ProvisionCodeCodec(baseUrl);

  let creator: ProvisionPodCreator;
  let mockIdentifierGenerator: any;
  let mockWebIdStore: any;
  let mockPodStore: any;
  let mockEdgeNodeRepository: any;
  let mockResourceStore: any;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = mockFetch as typeof fetch;
    mockIdentifierGenerator = {
      generate: vi.fn((name: string) => ({ path: `${baseUrl}${name}/` })),
      extractPod: vi.fn((identifier: { path: string }) => identifier),
    };
    mockWebIdStore = {
      create: vi.fn().mockResolvedValue('webid-link-1'),
      isLinked: vi.fn().mockResolvedValue(false),
      findLinks: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(undefined),
    };
    mockPodStore = { create: vi.fn().mockResolvedValue('pod-id-1') };
    mockResourceStore = {
      getRepresentation: vi.fn().mockResolvedValue({
        data: Readable.from(`<${baseUrl}alice/profile/card#me> <http://www.w3.org/ns/solid/terms#storage> <${spUrl}/alice/> .\n`),
      }),
      setRepresentation: vi.fn().mockResolvedValue(undefined),
    };
    mockEdgeNodeRepository = {
      getSpNode: vi.fn().mockResolvedValue({
        nodeId,
        publicUrl: spUrl,
        serviceTokenHash: deriveProvisionReceiptSecret(serviceToken),
      }),
    };
    creator = makeCreator();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
  });

  function makeCreator(overrides: Record<string, unknown> = {}): ProvisionPodCreator {
    return new ProvisionPodCreator({
      baseUrl,
      provisionBaseUrl: baseUrl,
      identifierGenerator: mockIdentifierGenerator,
      relativeWebIdPath: 'profile/card#me',
      webIdStore: mockWebIdStore,
      podStore: mockPodStore,
      identityDbUrl: 'sqlite::memory:',
      edgeNodeRepository: mockEdgeNodeRepository,
      resourceStore: mockResourceStore,
      ...overrides,
    } as any);
  }

  function makeProvisionCode(options: {
    spDomain?: string;
    spUrl?: string;
    nodeId?: string;
    token?: string;
    expiresAt?: number;
  } = {}): string {
    const expiresAt = options.expiresAt ?? Math.floor(Date.now() / 1000) + 3600;
    return codec.encode({
      spUrl: options.spUrl ?? spUrl,
      serviceAccessToken: options.token ?? serviceToken,
      serviceAccessTokenExp: expiresAt,
      nodeId: options.nodeId ?? nodeId,
      ...(options.spDomain ? { spDomain: options.spDomain } : {}),
      exp: expiresAt,
    });
  }

  function makeReceipt(options: {
    podName?: string;
    webId?: string;
    podUrl?: string;
    secret?: string;
    expiresAt?: number;
  } = {}): string {
    return createProvisionReceipt({
      secret: options.secret ?? deriveProvisionReceiptSecret(serviceToken),
      podName: options.podName ?? 'alice',
      webId: options.webId ?? `${spUrl}/alice/profile/card#me`,
      podUrl: options.podUrl ?? `${spUrl}/alice/`,
      expiresAt: options.expiresAt,
    });
  }

  describe('with provisionCode for another storage provider', () => {
    it('links a pre-created Local Pod from a valid receipt without network I/O', async () => {
      const handleWebId = vi.spyOn(creator as any, 'handleWebId').mockResolvedValue('webid-link-1');
      const createPod = vi.spyOn(creator as any, 'createPod').mockResolvedValue('pod-id-1');
      const provisionCode = makeProvisionCode();
      const provisionReceipt = makeReceipt();

      const result = await creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: { provisionCode, provisionReceipt },
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(handleWebId).toHaveBeenCalledWith(
        true,
        `${spUrl}/alice/profile/card#me`,
        'account-1',
        expect.objectContaining({ storage: `${spUrl}/alice/`, [XPOD_REMOTE_PROVISIONED]: true }),
      );
      expect(createPod).toHaveBeenCalledWith(
        'account-1',
        expect.objectContaining({ storage: `${spUrl}/alice/`, [XPOD_REMOTE_PROVISIONED]: true }),
        false,
        'webid-link-1',
      );
      const persisted = createPod.mock.calls[0][1];
      expect(persisted).not.toHaveProperty('provisionCode');
      expect(persisted).not.toHaveProperty('provisionReceipt');
      expect(result).toEqual({
        podUrl: `${spUrl}/alice/`,
        webId: `${spUrl}/alice/profile/card#me`,
        podId: 'pod-id-1',
        webIdLink: 'webid-link-1',
      });
    });

    it('rejects a missing receipt before writing Account state', async () => {
      const handleWebId = vi.spyOn(creator as any, 'handleWebId');
      const createPod = vi.spyOn(creator as any, 'createPod');

      await expect(creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: { provisionCode: makeProvisionCode() },
      })).rejects.toThrow('Local Pod must be prepared before it can be linked.');

      expect(mockFetch).not.toHaveBeenCalled();
      expect(handleWebId).not.toHaveBeenCalled();
      expect(createPod).not.toHaveBeenCalled();
    });

    it.each([
      ['pod name', () => makeReceipt({ podName: 'mallory' })],
      ['WebID', () => makeReceipt({ webId: `${spUrl}/mallory/profile/card#me` })],
      ['storage URL', () => makeReceipt({ podUrl: 'https://other.example/alice/' })],
      ['signature', () => makeReceipt({ secret: deriveProvisionReceiptSecret('wrong-token') })],
      ['expiration', () => makeReceipt({ expiresAt: Math.floor(Date.now() / 1000) - 1 })],
    ])('rejects a receipt with mismatched %s', async (_label, buildReceipt) => {
      await expect(creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: { provisionCode: makeProvisionCode(), provisionReceipt: buildReceipt() },
      })).rejects.toThrow('Local Pod preparation could not be verified.');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects a receipt forged with only the browser-visible service access token', async () => {
      await expect(creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: {
          provisionCode: makeProvisionCode(),
          provisionReceipt: makeReceipt({ secret: serviceToken }),
        },
      })).rejects.toThrow('Local Pod preparation could not be verified.');
      expect(mockEdgeNodeRepository.getSpNode).toHaveBeenCalledWith(nodeId);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects remote provisioning when the SP service-token hash is unavailable', async () => {
      mockEdgeNodeRepository.getSpNode.mockResolvedValue(undefined);

      await expect(creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: { provisionCode: makeProvisionCode(), provisionReceipt: makeReceipt() },
      })).rejects.toThrow('Local Pod preparation could not be verified.');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('accepts the canonical SP WebID when the receipt binds it', async () => {
      const webId = `${spUrl}/alice/profile/card#me`;
      vi.spyOn(creator as any, 'createPod').mockResolvedValue('pod-id-1');

      const result = await creator.handle({
        name: 'alice',
        accountId: 'account-1',
        webId,
        settings: { provisionCode: makeProvisionCode(), provisionReceipt: makeReceipt({ webId }) },
      });

      expect(result.webId).toBe(webId);
      expect(mockWebIdStore.create).toHaveBeenCalledWith(webId, 'account-1');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects a WebID outside the provisioned Pod profile even when the receipt contains it', async () => {
      const webId = 'https://other.example/profile#me';
      const createPod = vi.spyOn(creator as any, 'createPod');

      await expect(creator.handle({
        name: 'alice',
        accountId: 'account-1',
        webId,
        settings: { provisionCode: makeProvisionCode(), provisionReceipt: makeReceipt({ webId }) },
      })).rejects.toThrow('Local Pod preparation could not be verified.');

      expect(mockEdgeNodeRepository.getSpNode).toHaveBeenCalledWith(nodeId);
      expect(createPod).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('uses the managed spDomain as the canonical storage address', async () => {
      const spDomain = 'abc123.undefineds.site';
      vi.spyOn(creator as any, 'handleWebId').mockResolvedValue('webid-link-1');
      const createPod = vi.spyOn(creator as any, 'createPod').mockResolvedValue('pod-id-1');

      const result = await creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: {
          provisionCode: makeProvisionCode({ spDomain }),
          provisionReceipt: makeReceipt({
            podUrl: `https://${spDomain}/alice/`,
            webId: `https://${spDomain}/alice/profile/card#me`,
          }),
        },
      });

      expect(result.podUrl).toBe(`https://${spDomain}/alice/`);
      expect(result.webId).toBe(`https://${spDomain}/alice/profile/card#me`);
      expect(createPod).toHaveBeenCalledWith(
        'account-1',
        expect.objectContaining({ storage: `https://${spDomain}/alice/` }),
        false,
        'webid-link-1',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects an invalid or expired provisionCode before reading the receipt', async () => {
      await expect(creator.handle({
        name: 'alice', accountId: 'account-1', settings: { provisionCode: 'garbage.token', provisionReceipt: makeReceipt() },
      })).rejects.toThrow('Invalid or expired provisionCode');
      await expect(creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: {
          provisionCode: makeProvisionCode({ expiresAt: Math.floor(Date.now() / 1000) - 10 }),
          provisionReceipt: makeReceipt(),
        },
      })).rejects.toThrow('Invalid or expired provisionCode');
    });

    it('requires an explicit Pod name', async () => {
      await expect(creator.handle({
        accountId: 'account-1',
        settings: { provisionCode: makeProvisionCode(), provisionReceipt: makeReceipt() },
      })).rejects.toThrow('Pod name is required');
    });

    it('reuses an existing same-account WebID link', async () => {
      mockWebIdStore.findLinks.mockResolvedValue([
        { id: 'webid-link-existing', webId: `${spUrl}/alice/profile/card#me` },
      ]);
      const handleWebId = vi.spyOn(creator as any, 'handleWebId');
      const createPod = vi.spyOn(creator as any, 'createPod').mockResolvedValue('pod-id-1');

      const result = await creator.handle({
        name: 'alice', accountId: 'account-1',
        settings: { provisionCode: makeProvisionCode(), provisionReceipt: makeReceipt() },
      });

      expect(handleWebId).not.toHaveBeenCalled();
      expect(createPod).toHaveBeenCalledWith('account-1', expect.any(Object), false, undefined);
      expect(result.webIdLink).toBe('webid-link-existing');
    });

    it('does not read or rewrite a Cloud-side profile for a Local SP WebID', async () => {
      vi.spyOn(creator as any, 'createPod').mockResolvedValue('pod-id-1');

      await creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: { provisionCode: makeProvisionCode(), provisionReceipt: makeReceipt() },
      });

      expect(mockResourceStore.getRepresentation).not.toHaveBeenCalled();
      expect(mockResourceStore.setRepresentation).not.toHaveBeenCalled();
    });

    it('keeps the modeled remote Account-lock work inside the six-second budget', async () => {
      vi.useFakeTimers();
      const delayed = <T>(value: T, delayMs: number): Promise<T> => new Promise((resolve) => {
        setTimeout(() => resolve(value), delayMs);
      });
      mockEdgeNodeRepository.getSpNode.mockImplementation(() => delayed({
        nodeId,
        publicUrl: spUrl,
        serviceTokenHash: deriveProvisionReceiptSecret(serviceToken),
      }, 1_300));
      mockWebIdStore.findLinks.mockImplementation(() => delayed([], 1_300));
      vi.spyOn(creator as any, 'handleWebId').mockImplementation(() => delayed('webid-link-1', 1_300));
      vi.spyOn(creator as any, 'createPod').mockImplementation(() => delayed('pod-id-1', 1_300));

      const operation = creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: { provisionCode: makeProvisionCode(), provisionReceipt: makeReceipt() },
      });

      await vi.advanceTimersByTimeAsync(5_999);
      await expect(operation).resolves.toMatchObject({ podId: 'pod-id-1' });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockResourceStore.getRepresentation).not.toHaveBeenCalled();
      expect(mockResourceStore.setRepresentation).not.toHaveBeenCalled();
    });
  });

  describe('with provisionCode for the current storage provider', () => {
    it('uses the native CSS create path without requiring a receipt', async () => {
      const localBaseUrl = 'https://node.example.com/';
      const localCreator = makeCreator({
        baseUrl: localBaseUrl,
        identifierGenerator: {
          generate: vi.fn((name: string) => ({ path: `${localBaseUrl}${name}/` })),
          extractPod: vi.fn((identifier: { path: string }) => identifier),
        },
      });
      vi.spyOn(localCreator as any, 'handleWebId').mockResolvedValue('webid-link-1');
      vi.spyOn(localCreator as any, 'createPod').mockResolvedValue('pod-id-1');
      const result = await localCreator.handle({
        name: 'alice', accountId: 'account-1',
        settings: { provisionCode: makeProvisionCode({ spUrl: localBaseUrl }) },
      });
      expect(result.podUrl).toBe(`${localBaseUrl}alice/`);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('recognizes the current node id across loopback and managed URLs', async () => {
      const localCreator = makeCreator({ baseUrl: 'http://localhost:5737/', nodeId });
      vi.spyOn(localCreator as any, 'handleWebId').mockResolvedValue('webid-link-1');
      const createPod = vi.spyOn(localCreator as any, 'createPod').mockResolvedValue('pod-id-1');
      await localCreator.handle({
        name: 'alice', accountId: 'account-1',
        settings: { provisionCode: makeProvisionCode({ spUrl: 'https://node-1.nodes.example/', spDomain: 'node-1.nodes.example' }) },
      });
      expect(createPod).toHaveBeenCalledWith(
        'account-1', expect.objectContaining({ storage: 'https://node-1.nodes.example/alice/' }), false, 'webid-link-1',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('without provisionCode', () => {
    it('creates a native CSS Pod', async () => {
      vi.spyOn(creator as any, 'handleWebId').mockResolvedValue('webid-link-1');
      const createPod = vi.spyOn(creator as any, 'createPod').mockResolvedValue('pod-id-1');
      const result = await creator.handle({ name: 'bob', accountId: 'account-2', settings: {} });
      expect(result).toEqual({
        podUrl: `${baseUrl}bob/`, webId: `${baseUrl}bob/profile/card#me`, podId: 'pod-id-1', webIdLink: 'webid-link-1',
      });
      expect(createPod).toHaveBeenCalledWith(
        'account-2', expect.objectContaining({ storage: `${baseUrl}bob/`, oidcIssuer: baseUrl }), false, 'webid-link-1',
      );
    });

    it('maps duplicate resources to a Pod-name conflict', async () => {
      vi.spyOn(creator as any, 'handleWebId').mockResolvedValue('webid-link-1');
      vi.spyOn(creator as any, 'createPod').mockRejectedValue(new Error(`There already is a resource at ${baseUrl}bob/`));
      await expect(creator.handle({ name: 'bob', accountId: 'account-2', settings: {} }))
        .rejects.toThrow('Pod name "bob" is already taken for this storage target.');
    });

    it('keeps native CSS Pod creation best-effort when profile reconciliation fails', async () => {
      const resourceStore = { getRepresentation: vi.fn().mockRejectedValue(new Error('lock timeout')), setRepresentation: vi.fn() };
      const localCreator = makeCreator({ resourceStore });
      vi.spyOn(localCreator as any, 'handleWebId').mockResolvedValue('webid-link-1');
      vi.spyOn(localCreator as any, 'createPod').mockResolvedValue('pod-id-1');
      const result = await localCreator.handle({ name: 'bob', accountId: 'account-2', settings: {} });
      expect(result.podId).toBe('pod-id-1');
      expect(resourceStore.setRepresentation).not.toHaveBeenCalled();
    });
  });
});
