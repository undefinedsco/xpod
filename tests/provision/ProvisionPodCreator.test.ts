import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { ProvisionPodCreator } from '../../src/provision/ProvisionPodCreator';
import { ProvisionCodeCodec } from '../../src/provision/ProvisionCodeCodec';

const mockFetch = vi.fn();
const realFetch = globalThis.fetch;

describe('ProvisionPodCreator', () => {
  const baseUrl = 'https://cloud.example.com/';
  const codec = new ProvisionCodeCodec(baseUrl);

  let creator: ProvisionPodCreator;
  let mockIdentifierGenerator: any;
  let mockWebIdStore: any;
  let mockPodStore: any;

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
    mockPodStore = {
      create: vi.fn().mockResolvedValue('pod-id-1'),
    };

    creator = new ProvisionPodCreator({
      baseUrl,
      provisionBaseUrl: baseUrl,
      identifierGenerator: mockIdentifierGenerator,
      relativeWebIdPath: 'profile/card#me',
      webIdStore: mockWebIdStore,
      podStore: mockPodStore,
      identityDbUrl: 'sqlite::memory:',
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  describe('with provisionCode (SP mode)', () => {
    const spUrl = 'https://sp.example.com';
    const serviceToken = 'st-secret';
    const nodeId = 'node-1';

    function makeProvisionCode(opts?: { spDomain?: string }): string {
      return codec.encode({
        spUrl,
        serviceToken,
        nodeId,
        spDomain: opts?.spDomain,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
    }

    it('should decode provisionCode and callback SP to create pod', async () => {
      const provisionCode = makeProvisionCode();

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ podUrl: `${spUrl}/alice/` }),
      });

      // Mock the inherited methods
      vi.spyOn(creator as any, 'handleWebId').mockResolvedValue('webid-link-1');
      vi.spyOn(creator as any, 'createPod').mockResolvedValue('pod-id-1');

      const result = await creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: { provisionCode },
      });

      // Verify fetch was called with correct SP URL and serviceToken
      expect(mockFetch).toHaveBeenCalledWith(
        `${spUrl}/provision/pods`,
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceToken}`,
          },
          body: JSON.stringify({
            podName: 'alice',
            webId: `${baseUrl}alice/profile/card#me`,
          }),
        }),
      );

      expect(result.podUrl).toBe(`${spUrl}/alice/`);
      expect(result.webId).toBe(`${baseUrl}alice/profile/card#me`);
      expect(result.podId).toBe('pod-id-1');
    });

    it('uses the managed route for a Cloud-issued node domain callback', async () => {
      const expiresAt = Math.floor(Date.now() / 1000) + 900;
      const provisionCode = codec.encode({
        spUrl,
        serviceAccessToken: 'sat-local-once.signature',
        serviceAccessTokenExp: expiresAt,
        signalApiUrl: 'https://api.example.com/',
        routeAccessToken: 'svc-route-once',
        routeAccessTokenExp: expiresAt,
        nodeId,
        exp: expiresAt,
      });
      const managedCallback = vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ podUrl: `${spUrl}/alice/` }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ));
      const close = vi.fn();
      const createManagedFetch = vi.spyOn(creator as any, 'createManagedFetch').mockResolvedValue({
        route: { kind: 'p2p' },
        fetch: managedCallback,
        close,
      });
      vi.spyOn(creator as any, 'handleWebId').mockResolvedValue('webid-link-1');
      vi.spyOn(creator as any, 'createPod').mockResolvedValue('pod-id-1');

      const result = await creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: { provisionCode },
      });

      expect(createManagedFetch).toHaveBeenCalledWith(expect.objectContaining({
        apiBaseUrl: 'https://api.example.com/',
        nodeId,
        token: 'svc-route-once',
        clientId: expect.stringMatching(/^provision-/u),
      }));
      expect(managedCallback).toHaveBeenCalledWith(
        `${spUrl}/provision/pods`,
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer sat-local-once.signature',
          },
        }),
      );
      expect(close).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.podUrl).toBe(`${spUrl}/alice/`);
    });

    it('creates directly when provisionCode points at the current SP', async () => {
      const localBaseUrl = 'https://node.example.com/';
      const localCodec = new ProvisionCodeCodec(baseUrl);
      const localCreator = new ProvisionPodCreator({
        baseUrl: localBaseUrl,
        provisionBaseUrl: baseUrl,
        identifierGenerator: {
          generate: vi.fn((name: string) => ({ path: `${localBaseUrl}${name}/` })),
          extractPod: vi.fn((identifier: { path: string }) => identifier),
        },
        relativeWebIdPath: 'profile/card#me',
        webIdStore: mockWebIdStore,
        podStore: mockPodStore,
      });
      const provisionCode = localCodec.encode({
        spUrl: localBaseUrl,
        serviceToken,
        nodeId,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      vi.spyOn(localCreator as any, 'handleWebId').mockResolvedValue('webid-link-1');
      vi.spyOn(localCreator as any, 'createPod').mockResolvedValue('pod-id-1');

      const result = await localCreator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: { provisionCode },
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect((localCreator as any).handleWebId).toHaveBeenCalledWith(
        true,
        `${baseUrl}alice/profile/card#me`,
        'account-1',
        expect.objectContaining({
          base: { path: `${localBaseUrl}alice/` },
          oidcIssuer: baseUrl,
          storage: `${localBaseUrl}alice/`,
          webId: `${baseUrl}alice/profile/card#me`,
        }),
      );
      expect(result).toEqual({
        podUrl: `${localBaseUrl}alice/`,
        webId: `${baseUrl}alice/profile/card#me`,
        podId: 'pod-id-1',
        webIdLink: 'webid-link-1',
      });
    });

    it('creates directly when provisionCode nodeId matches this SP even if URLs use different access paths', async () => {
      const localAccessUrl = 'http://localhost:5737/';
      const managedDomain = 'node-0000.undefineds.co';
      const localCodec = new ProvisionCodeCodec(baseUrl);
      const localCreator = new ProvisionPodCreator({
        baseUrl: localAccessUrl,
        provisionBaseUrl: baseUrl,
        nodeId,
        identifierGenerator: {
          generate: vi.fn((name: string) => ({ path: `${localAccessUrl}${name}/` })),
          extractPod: vi.fn((identifier: { path: string }) => identifier),
        },
        relativeWebIdPath: 'profile/card#me',
        webIdStore: mockWebIdStore,
        podStore: mockPodStore,
        identityDbUrl: 'sqlite::memory:',
      });
      const provisionCode = localCodec.encode({
        spUrl: `https://${managedDomain}/`,
        serviceToken,
        nodeId,
        spDomain: managedDomain,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      vi.spyOn(localCreator as any, 'handleWebId').mockResolvedValue('webid-link-1');
      vi.spyOn(localCreator as any, 'createPod').mockResolvedValue('pod-id-1');

      const result = await localCreator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: { provisionCode },
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect((localCreator as any).createPod).toHaveBeenCalledWith(
        'account-1',
        expect.objectContaining({
          base: { path: `https://${managedDomain}/alice/` },
          oidcIssuer: baseUrl,
          storage: `https://${managedDomain}/alice/`,
          webId: `${baseUrl}alice/profile/card#me`,
        }),
        false,
        'webid-link-1',
      );
      expect(result).toEqual({
        podUrl: `https://${managedDomain}/alice/`,
        webId: `${baseUrl}alice/profile/card#me`,
        podId: 'pod-id-1',
        webIdLink: 'webid-link-1',
      });
    });

    it('reuses an existing same-account WebID link when creating Local storage for a Cloud WebID', async () => {
      const localBaseUrl = 'https://node-0000.undefineds.co/';
      const localCodec = new ProvisionCodeCodec(baseUrl);
      const localWebIdStore = {
        create: vi.fn().mockResolvedValue('webid-link-new'),
        isLinked: vi.fn().mockResolvedValue(true),
        findLinks: vi.fn().mockResolvedValue([
          {
            id: 'webid-link-existing',
            webId: `${baseUrl}glocal99/profile/card#me`,
          },
        ]),
        delete: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(undefined),
      };
      const localCreator = new ProvisionPodCreator({
        baseUrl: localBaseUrl,
        provisionBaseUrl: baseUrl,
        nodeId,
        identifierGenerator: {
          generate: vi.fn((name: string) => ({ path: `${localBaseUrl}${name}/` })),
          extractPod: vi.fn((identifier: { path: string }) => identifier),
        },
        relativeWebIdPath: 'profile/card#me',
        webIdStore: localWebIdStore,
        podStore: mockPodStore,
      });
      const provisionCode = localCodec.encode({
        spUrl: localBaseUrl,
        serviceToken,
        nodeId,
        spDomain: 'node-0000.undefineds.co',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      vi.spyOn(localCreator as any, 'handleWebId');
      vi.spyOn(localCreator as any, 'createPod').mockResolvedValue('pod-id-1');

      const result = await localCreator.handle({
        name: 'glocal99',
        accountId: 'account-1',
        settings: { provisionCode },
      });

      expect(localWebIdStore.findLinks).toHaveBeenCalledWith('account-1');
      expect(localWebIdStore.create).not.toHaveBeenCalled();
      expect((localCreator as any).handleWebId).not.toHaveBeenCalled();
      expect((localCreator as any).createPod).toHaveBeenCalledWith(
        'account-1',
        expect.objectContaining({
          base: { path: `${localBaseUrl}glocal99/` },
          oidcIssuer: baseUrl,
          storage: `${localBaseUrl}glocal99/`,
          webId: `${baseUrl}glocal99/profile/card#me`,
        }),
        false,
        undefined,
      );
      expect(result).toEqual({
        podUrl: `${localBaseUrl}glocal99/`,
        webId: `${baseUrl}glocal99/profile/card#me`,
        podId: 'pod-id-1',
        webIdLink: 'webid-link-existing',
      });
    });

    it('should use spDomain for podUrl when available', async () => {
      const provisionCode = makeProvisionCode({ spDomain: 'abc123.undefineds.site' });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({}), // SP doesn't return podUrl
      });

      vi.spyOn(creator as any, 'handleWebId').mockResolvedValue('webid-link-1');
      vi.spyOn(creator as any, 'createPod').mockResolvedValue('pod-id-1');

      const result = await creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: { provisionCode },
      });

      // Should use spDomain, not spUrl
      expect(result.podUrl).toBe('https://abc123.undefineds.site/alice/');
      expect((creator as any).createPod).toHaveBeenCalledWith(
        'account-1',
        expect.objectContaining({
          storage: 'https://abc123.undefineds.site/alice/',
        }),
        false,
        'webid-link-1',
      );

      // But fetch should still use the real spUrl
      expect(mockFetch).toHaveBeenCalledWith(
        `${spUrl}/provision/pods`,
        expect.any(Object),
      );
    });

    it('reconciles storage pointer to canonical storage url when SP returns a local callback podUrl', async () => {
      const provisionCode = makeProvisionCode({ spDomain: 'abc123.undefineds.site' });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ podUrl: `${spUrl}/alice/` }),
      });

      vi.spyOn(creator as any, 'handleWebId').mockResolvedValue('webid-link-1');
      vi.spyOn(creator as any, 'createPod').mockResolvedValue('pod-id-1');

      const result = await creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: { provisionCode },
      });

      expect(result.podUrl).toBe(`${spUrl}/alice/`);
      expect((creator as any).createPod).toHaveBeenCalledWith(
        'account-1',
        expect.objectContaining({
          storage: 'https://abc123.undefineds.site/alice/',
        }),
        false,
        'webid-link-1',
      );
    });

    it('should throw on invalid provisionCode', async () => {
      vi.spyOn(creator as any, 'handleWebId').mockResolvedValue('webid-link-1');

      await expect(creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: { provisionCode: 'garbage.token' },
      })).rejects.toThrow('Invalid or expired provisionCode');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw on expired provisionCode', async () => {
      const expired = codec.encode({
        spUrl,
        serviceToken,
        exp: Math.floor(Date.now() / 1000) - 10,
      });

      vi.spyOn(creator as any, 'handleWebId').mockResolvedValue('webid-link-1');

      await expect(creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: { provisionCode: expired },
      })).rejects.toThrow('Invalid or expired provisionCode');
    });

    it('should throw when podName is missing', async () => {
      const provisionCode = makeProvisionCode();

      vi.spyOn(creator as any, 'handleWebId').mockResolvedValue('webid-link-1');

      await expect(creator.handle({
        accountId: 'account-1',
        settings: { provisionCode },
      })).rejects.toThrow('Pod name is required');
    });

    it('should throw when SP callback fails', async () => {
      const provisionCode = makeProvisionCode();

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      vi.spyOn(creator as any, 'handleWebId').mockResolvedValue('webid-link-1');

      await expect(creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: { provisionCode },
      })).rejects.toThrow('Failed to create pod on SP: 500');
    });

    it('does not expose the low-level fetch error when the SP callback is unreachable', async () => {
      const provisionCode = makeProvisionCode();

      mockFetch.mockRejectedValue(new TypeError('fetch failed'));

      await expect(creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: { provisionCode },
      })).rejects.toThrow('Cloud storage is not ready. Please wait for Xpod to reconnect and try again.');
    });

    it('preserves SP conflict messages', async () => {
      const provisionCode = makeProvisionCode();

      mockFetch.mockResolvedValue({
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ message: 'Pod alice already exists' }),
      });

      vi.spyOn(creator as any, 'handleWebId').mockResolvedValue('webid-link-1');

      await expect(creator.handle({
        name: 'alice',
        accountId: 'account-1',
        settings: { provisionCode },
      })).rejects.toThrow('Pod alice already exists');
    });

    it('should use provided webId instead of generating one', async () => {
      const provisionCode = makeProvisionCode();
      const customWebId = 'https://other.example.com/profile#me';

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ podUrl: `${spUrl}/alice/` }),
      });

      vi.spyOn(creator as any, 'handleWebId').mockResolvedValue('webid-link-1');
      vi.spyOn(creator as any, 'createPod').mockResolvedValue('pod-id-1');

      const result = await creator.handle({
        name: 'alice',
        accountId: 'account-1',
        webId: customWebId,
        settings: { provisionCode },
      });

      expect(result.webId).toBe(customWebId);
    });

    describe('profile storage binding sync', () => {
      const existingWebId = `${baseUrl}alice/profile/card#me`;
      const cardUrl = `${baseUrl}alice/profile/card`;
      const staleCardTurtle = `<${existingWebId}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <${baseUrl}> .
<${existingWebId}> <http://www.w3.org/ns/solid/terms#storage> <${baseUrl}alice/> .
<${existingWebId}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://xmlns.com/foaf/0.1/Person> .
`;

      function makeResourceStore(turtle: string): any {
        return {
          getRepresentation: vi.fn().mockResolvedValue({
            data: Readable.from(turtle),
          }),
          setRepresentation: vi.fn().mockResolvedValue(undefined),
        };
      }

      function makeCreatorWithStore(resourceStore: any): ProvisionPodCreator {
        return new ProvisionPodCreator({
          baseUrl,
          provisionBaseUrl: baseUrl,
          identifierGenerator: mockIdentifierGenerator,
          relativeWebIdPath: 'profile/card#me',
          webIdStore: {
            ...mockWebIdStore,
            isLinked: vi.fn().mockResolvedValue(true),
            findLinks: vi.fn().mockResolvedValue([{ id: 'webid-link-existing', webId: existingWebId }]),
          },
          podStore: mockPodStore,
          resourceStore,
        });
      }

      async function readStream(stream: any): Promise<string> {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString('utf8');
      }

      it('replaces a stale solid:storage entry when the Pod moved to another SP', async () => {
        const resourceStore = makeResourceStore(staleCardTurtle);
        const localCreator = makeCreatorWithStore(resourceStore);
        const provisionCode = makeProvisionCode();

        mockFetch.mockResolvedValue({
          ok: true,
          json: async () => ({ podUrl: `${spUrl}/alice/` }),
        });
        vi.spyOn(localCreator as any, 'handleWebId').mockResolvedValue('webid-link-existing');
        vi.spyOn(localCreator as any, 'createPod').mockResolvedValue('pod-id-1');

        await localCreator.handle({
          name: 'alice',
          accountId: 'account-1',
          settings: { provisionCode },
        });

        expect(resourceStore.getRepresentation).toHaveBeenCalledWith(
          { path: cardUrl },
          expect.objectContaining({ type: { 'text/turtle': 1 } }),
        );
        expect(resourceStore.setRepresentation).toHaveBeenCalledTimes(1);
        const [identifier, representation] = resourceStore.setRepresentation.mock.calls[0];
        expect(identifier).toEqual({ path: cardUrl });
        const written = await readStream(representation.data);
        expect(written).toContain('solid:storage <https://sp.example.com/alice/>');
        expect(written).not.toContain(`solid:storage <${baseUrl}alice/>`);
        expect(written).toContain('solid:oidcIssuer');
      });

      it('leaves the card untouched when the storage binding is already correct', async () => {
        const freshCardTurtle = staleCardTurtle.replace(
          `<${baseUrl}alice/> .\n<${existingWebId}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>`,
          `<${spUrl}/alice/> .\n<${existingWebId}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>`,
        );
        const resourceStore = makeResourceStore(freshCardTurtle);
        const localCreator = makeCreatorWithStore(resourceStore);
        const provisionCode = makeProvisionCode();

        mockFetch.mockResolvedValue({
          ok: true,
          json: async () => ({ podUrl: `${spUrl}/alice/` }),
        });
        vi.spyOn(localCreator as any, 'handleWebId').mockResolvedValue('webid-link-existing');
        vi.spyOn(localCreator as any, 'createPod').mockResolvedValue('pod-id-1');

        await localCreator.handle({
          name: 'alice',
          accountId: 'account-1',
          settings: { provisionCode },
        });

        expect(resourceStore.setRepresentation).not.toHaveBeenCalled();
      });

      it('skips WebIDs hosted on a different server', async () => {
        const resourceStore = makeResourceStore(staleCardTurtle);
        const localCreator = makeCreatorWithStore(resourceStore);
        const provisionCode = makeProvisionCode();

        mockFetch.mockResolvedValue({
          ok: true,
          json: async () => ({ podUrl: `${spUrl}/alice/` }),
        });
        vi.spyOn(localCreator as any, 'handleWebId').mockResolvedValue('webid-link-1');
        vi.spyOn(localCreator as any, 'createPod').mockResolvedValue('pod-id-1');

        await localCreator.handle({
          name: 'alice',
          accountId: 'account-1',
          webId: 'https://other.example.com/alice/profile/card#me',
          settings: { provisionCode },
        });

        expect(resourceStore.getRepresentation).not.toHaveBeenCalled();
        expect(resourceStore.setRepresentation).not.toHaveBeenCalled();
      });

      it('does not fail pod creation when the card sync fails', async () => {
        const resourceStore = {
          getRepresentation: vi.fn().mockRejectedValue(new Error('lock timeout')),
          setRepresentation: vi.fn(),
        };
        const localCreator = makeCreatorWithStore(resourceStore);
        const provisionCode = makeProvisionCode();

        mockFetch.mockResolvedValue({
          ok: true,
          json: async () => ({ podUrl: `${spUrl}/alice/` }),
        });
        vi.spyOn(localCreator as any, 'handleWebId').mockResolvedValue('webid-link-existing');
        vi.spyOn(localCreator as any, 'createPod').mockResolvedValue('pod-id-1');

        const result = await localCreator.handle({
          name: 'alice',
          accountId: 'account-1',
          settings: { provisionCode },
        });

        expect(result.podId).toBe('pod-id-1');
        expect(resourceStore.setRepresentation).not.toHaveBeenCalled();
      });
    });
  });

  describe('without provisionCode (standard mode)', () => {
    it('should create pod through standard mode path', async () => {
      vi.spyOn(creator as any, 'handleWebId').mockResolvedValue('webid-link-1');
      vi.spyOn(creator as any, 'createPod').mockResolvedValue('pod-id-1');

      const expectedResult = {
        podUrl: `${baseUrl}bob/`,
        webId: `${baseUrl}bob/profile/card#me`,
        podId: 'pod-id-1',
        webIdLink: 'webid-link-1',
      };

      const result = await creator.handle({
        name: 'bob',
        accountId: 'account-2',
        settings: {},
      });

      expect(result).toEqual(expectedResult);
      expect((creator as any).handleWebId).toHaveBeenCalledWith(
        true,
        `${baseUrl}bob/profile/card#me`,
        'account-2',
        expect.objectContaining({
          base: { path: `${baseUrl}bob/` },
          webId: `${baseUrl}bob/profile/card#me`,
          oidcIssuer: baseUrl,
          storage: `${baseUrl}bob/`,
        }),
      );
      expect((creator as any).createPod).toHaveBeenCalledWith(
        'account-2',
        expect.objectContaining({
          base: { path: `${baseUrl}bob/` },
          webId: `${baseUrl}bob/profile/card#me`,
          oidcIssuer: baseUrl,
          storage: `${baseUrl}bob/`,
        }),
        false,
        'webid-link-1',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('maps duplicate resource conflicts to a pod-name conflict message', async () => {
      vi.spyOn(creator as any, 'handleWebId').mockResolvedValue('webid-link-1');
      vi.spyOn(creator as any, 'createPod').mockRejectedValue(new Error(`There already is a resource at ${baseUrl}bob/`));

      await expect(creator.handle({
        name: 'bob',
        accountId: 'account-2',
        settings: {},
      })).rejects.toThrow('Pod name "bob" is already taken for this storage target.');
    });
  });
});
