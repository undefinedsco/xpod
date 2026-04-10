import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProvisionPodCreator } from '../../src/provision/ProvisionPodCreator';
import { ProvisionCodeCodec } from '../../src/provision/ProvisionCodeCodec';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('ProvisionPodCreator', () => {
  const baseUrl = 'https://cloud.example.com/';
  const codec = new ProvisionCodeCodec(baseUrl);

  let creator: ProvisionPodCreator;
  let mockIdentifierGenerator: any;
  let mockWebIdStore: any;
  let mockPodStore: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockIdentifierGenerator = {
      generate: vi.fn((name: string) => ({ path: `${baseUrl}${name}/` })),
    };
    mockWebIdStore = {
      create: vi.fn().mockResolvedValue('webid-link-1'),
      isLinked: vi.fn().mockResolvedValue(false),
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
    });
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
          body: JSON.stringify({ podName: 'alice' }),
        }),
      );

      expect(result.podUrl).toBe(`${spUrl}/alice/`);
      expect(result.webId).toBe(`${baseUrl}alice/profile/card#me`);
      expect(result.podId).toBe('pod-id-1');
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

      // But fetch should still use the real spUrl
      expect(mockFetch).toHaveBeenCalledWith(
        `${spUrl}/provision/pods`,
        expect.any(Object),
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
        }),
      );
      expect((creator as any).createPod).toHaveBeenCalledWith(
        'account-2',
        expect.objectContaining({
          base: { path: `${baseUrl}bob/` },
          webId: `${baseUrl}bob/profile/card#me`,
          oidcIssuer: baseUrl,
        }),
        false,
        'webid-link-1',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
