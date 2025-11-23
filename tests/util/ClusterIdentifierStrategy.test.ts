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
});
