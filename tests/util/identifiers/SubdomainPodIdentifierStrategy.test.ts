import { SubdomainPodIdentifierStrategy } from '../../../src/util/identifiers/SubdomainPodIdentifierStrategy';
import type { ResourceIdentifier } from '@solid/community-server';

describe('SubdomainPodIdentifierStrategy', () => {
  let strategy: SubdomainPodIdentifierStrategy;
  const baseDomain = 'pods.undefineds.site';

  beforeEach(() => {
    strategy = new SubdomainPodIdentifierStrategy({ baseDomain });
  });

  describe('constructor', () => {
    it('should initialize with valid baseDomain', () => {
      const s = new SubdomainPodIdentifierStrategy({ baseDomain: 'example.com' });
      expect(s).toBeDefined();
    });

    it('should throw if baseDomain is empty', () => {
      expect(() => {
        new SubdomainPodIdentifierStrategy({ baseDomain: '' });
      }).toThrow('requires a baseDomain');
    });
  });

  describe('supportsIdentifier', () => {
    const createIdentifier = (path: string): ResourceIdentifier => ({ path });

    it('should support valid node-id.pods.domain/pod/ URLs', () => {
      const id = createIdentifier('https://node1.pods.undefineds.site/alice/data.ttl');
      expect(strategy.supportsIdentifier(id)).toBe(true);
    });

    it('should support pod root URLs', () => {
      const id = createIdentifier('https://node1.pods.undefineds.site/alice/');
      expect(strategy.supportsIdentifier(id)).toBe(true);
    });

    it('should reject base domain without subdomain', () => {
      const id = createIdentifier('https://pods.undefineds.site/alice/data.ttl');
      expect(strategy.supportsIdentifier(id)).toBe(false);
    });

    it('should reject wrong base domain', () => {
      const id = createIdentifier('https://node1.other.domain/alice/data.ttl');
      expect(strategy.supportsIdentifier(id)).toBe(false);
    });

    it('should reject invalid node-id with dots', () => {
      const id = createIdentifier('https://sub.node1.pods.undefineds.site/alice/data.ttl');
      expect(strategy.supportsIdentifier(id)).toBe(false);
    });

    it('should reject path without pod name', () => {
      const id = createIdentifier('https://node1.pods.undefineds.site/');
      expect(strategy.supportsIdentifier(id)).toBe(false);
    });

    it('should be case insensitive for hostname', () => {
      const id = createIdentifier('https://NODE1.PODS.UNDEFINEDS.SITE/alice/data.ttl');
      expect(strategy.supportsIdentifier(id)).toBe(true);
    });
  });

  describe('isRootContainer', () => {
    const createIdentifier = (path: string): ResourceIdentifier => ({ path });

    it('should return true for /pod/ paths', () => {
      const id = createIdentifier('https://node1.pods.undefineds.site/alice/');
      expect(strategy.isRootContainer(id)).toBe(true);
    });

    it('should return false for /pod/resource paths', () => {
      const id = createIdentifier('https://node1.pods.undefineds.site/alice/data.ttl');
      expect(strategy.isRootContainer(id)).toBe(false);
    });

    it('should return false for nested paths', () => {
      const id = createIdentifier('https://node1.pods.undefineds.site/alice/folder/file.txt');
      expect(strategy.isRootContainer(id)).toBe(false);
    });
  });

  describe('extractNodeId', () => {
    it('should extract node-id from hostname', () => {
      expect(strategy.extractNodeId('node1.pods.undefineds.site')).toBe('node1');
      expect(strategy.extractNodeId('alice-node.pods.undefineds.site')).toBe('alice-node');
    });

    it('should return undefined for base domain', () => {
      expect(strategy.extractNodeId('pods.undefineds.site')).toBeUndefined();
    });

    it('should return undefined for wrong domain', () => {
      expect(strategy.extractNodeId('node1.other.domain')).toBeUndefined();
    });

    it('should handle case insensitively', () => {
      expect(strategy.extractNodeId('NODE1.PODS.UNDEFINEDS.SITE')).toBe('node1');
    });
  });

  describe('extractPodName', () => {
    const createIdentifier = (path: string): ResourceIdentifier => ({ path });

    it('should extract pod name from path', () => {
      const id = createIdentifier('https://node1.pods.undefineds.site/alice/data.ttl');
      expect(strategy.extractPodName(id)).toBe('alice');
    });

    it('should extract pod name from root path', () => {
      const id = createIdentifier('https://node1.pods.undefineds.site/bob/');
      expect(strategy.extractPodName(id)).toBe('bob');
    });

    it('should return undefined for empty path', () => {
      const id = createIdentifier('https://node1.pods.undefineds.site/');
      expect(strategy.extractPodName(id)).toBeUndefined();
    });
  });

  describe('getPodRootIdentifier', () => {
    it('should generate correct pod root identifier', () => {
      const rootId = strategy.getPodRootIdentifier('alice', 'node1');
      expect(rootId.path).toBe('https://node1.pods.undefineds.site/alice/');
    });

    it('should generate different roots for different pods', () => {
      const root1 = strategy.getPodRootIdentifier('alice', 'node1');
      const root2 = strategy.getPodRootIdentifier('bob', 'node1');
      expect(root1.path).not.toBe(root2.path);
    });

    it('should generate different roots for different nodes', () => {
      const root1 = strategy.getPodRootIdentifier('alice', 'node1');
      const root2 = strategy.getPodRootIdentifier('alice', 'node2');
      expect(root1.path).not.toBe(root2.path);
    });
  });

  describe('edge cases', () => {
    const createIdentifier = (path: string): ResourceIdentifier => ({ path });

    it('should handle URL with port', () => {
      const id = createIdentifier('https://node1.pods.undefineds.site:8443/alice/data.ttl');
      expect(strategy.supportsIdentifier(id)).toBe(true);
      expect(strategy.extractPodName(id)).toBe('alice');
    });

    it('should handle URL with query string', () => {
      const id = createIdentifier('https://node1.pods.undefineds.site/alice/data.ttl?version=1');
      expect(strategy.supportsIdentifier(id)).toBe(true);
    });

    it('should handle URL with hash', () => {
      const id = createIdentifier('https://node1.pods.undefineds.site/alice/data.ttl#section');
      expect(strategy.supportsIdentifier(id)).toBe(true);
    });

    it('should reject node-id starting with hyphen', () => {
      const id = createIdentifier('https://-node1.pods.undefineds.site/alice/data.ttl');
      expect(strategy.supportsIdentifier(id)).toBe(false);
    });

    it('should reject node-id ending with hyphen', () => {
      const id = createIdentifier('https://node1-.pods.undefineds.site/alice/data.ttl');
      expect(strategy.supportsIdentifier(id)).toBe(false);
    });

    it('should handle long but valid identifiers', () => {
      const longNodeId = 'a'.repeat(63);
      const id = createIdentifier(`https://${longNodeId}.pods.undefineds.site/alice/data.ttl`);
      expect(strategy.supportsIdentifier(id)).toBe(true);
    });
  });
});
