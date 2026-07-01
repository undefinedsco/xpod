import { describe, it, expect } from 'vitest';
import type { ResourceIdentifier } from '@solid/community-server';
import { ClusterIdentifierStrategy } from '../../src/util/identifiers/ClusterIdentifierStrategy';

const identifier = (path: string): ResourceIdentifier => ({ path });

describe('ClusterIdentifierStrategy', () => {
  it('accepts identifiers under the base URL', () => {
    const strategy = new ClusterIdentifierStrategy({ baseUrl: 'https://cluster.example.com/' });
    expect(strategy.supportsIdentifier(identifier('https://cluster.example.com/pod/card'))).toBe(true);
    expect(strategy.supportsIdentifier(identifier('https://cluster.example.com/.well-known/openid-configuration'))).toBe(true);
  });

  it('accepts identifiers on subdomains of the base host', () => {
    const strategy = new ClusterIdentifierStrategy({ baseUrl: 'https://cluster.example.com/' });
    expect(strategy.supportsIdentifier(identifier('https://node1.cluster.example.com/profile/card'))).toBe(true);
    expect(strategy.supportsIdentifier(identifier('https://node2.eu-west.cluster.example.com/data/'))).toBe(true);
  });

  it('rejects identifiers on unrelated hosts', () => {
    const strategy = new ClusterIdentifierStrategy({ baseUrl: 'https://cluster.example.com/' });
    expect(strategy.supportsIdentifier(identifier('https://other.example.com/'))).toBe(false);
    expect(strategy.supportsIdentifier(identifier('https://fakeclusterexample.com/'))).toBe(false);
  });

  it('accepts wildcard allowed host entries only for matching subdomains', () => {
    const strategy = new ClusterIdentifierStrategy({
      baseUrl: 'https://id.undefineds.co/',
      allowedHosts: '*.undefineds.co',
    });

    expect(strategy.supportsIdentifier(identifier('https://node-0000.undefineds.co/alice/'))).toBe(true);
    expect(strategy.supportsIdentifier(identifier('https://registry.undefineds.co/nodes/node-0000'))).toBe(true);
    expect(strategy.supportsIdentifier(identifier('https://deep.node-0000.undefineds.co/alice/'))).toBe(false);
    expect(strategy.supportsIdentifier(identifier('https://undefineds.co/'))).toBe(false);
    expect(strategy.supportsIdentifier(identifier('https://fakeundefineds.co/'))).toBe(false);
    expect(strategy.supportsIdentifier(identifier('https://undefineds.co.evil.test/'))).toBe(false);
  });

  it('treats path-based pods on the base host as storage roots', () => {
    const strategy = new ClusterIdentifierStrategy({ baseUrl: 'https://cluster.example.com/' });
    expect(strategy.isRootContainer(identifier('https://cluster.example.com/'))).toBe(true);
    expect(strategy.isRootContainer(identifier('https://cluster.example.com/ganbb/'))).toBe(true);
    expect(strategy.isRootContainer(identifier('https://cluster.example.com/ganbb/.data/file.ttl'))).toBe(false);
    expect(strategy.isRootContainer(identifier('https://cluster.example.com/favicon.ico'))).toBe(false);
    expect(strategy.isRootContainer(identifier('https://cluster.example.com/app/'))).toBe(false);
    expect(strategy.isRootContainer(identifier('https://cluster.example.com/.well-known/openid-configuration'))).toBe(false);
    expect(strategy.isRootContainer(identifier('https://cluster.example.com/.account/client-credentials/'))).toBe(false);
  });

  it('stops recursive container creation at a path-based pod root', () => {
    const strategy = new ClusterIdentifierStrategy({ baseUrl: 'https://cluster.example.com/' });
    const dataContainer = identifier('https://cluster.example.com/ganbb/.data/');
    const podRoot = strategy.getParentContainer(dataContainer);
    expect(podRoot.path).toBe('https://cluster.example.com/ganbb/');
    expect(strategy.isRootContainer(podRoot)).toBe(true);
    expect(() => strategy.getParentContainer(podRoot)).toThrow(/because it is a root container/);
  });

  it('keeps subdomain hosts rooted at their domain root', () => {
    const strategy = new ClusterIdentifierStrategy({ baseUrl: 'https://cluster.example.com/' });
    expect(strategy.isRootContainer(identifier('https://node1.cluster.example.com/'))).toBe(true);
    expect(strategy.isRootContainer(identifier('https://node1.cluster.example.com/ganbb/'))).toBe(false);
  });
});
