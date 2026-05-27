import { describe, expect, it } from 'vitest';
import type { ResourceIdentifier } from '@solid/community-server';
import { MultiDomainIdentifierStrategy } from '../../src/util/identifiers/MultiDomainIdentifierStrategy';

function identifier(path: string): ResourceIdentifier {
  return { path };
}

describe('MultiDomainIdentifierStrategy', () => {
  const strategy = new MultiDomainIdentifierStrategy(
    'https://node-1.nodes.undefineds.co/',
    ['https://id.undefineds.co/'],
  );

  it('accepts pod resources on the primary SP host', () => {
    expect(
      strategy.supportsIdentifier(identifier('https://node-1.nodes.undefineds.co/alice/data.ttl')),
    ).toBe(true);
  });

  it('also accepts the same pod-shaped path on the IDP host', () => {
    expect(
      strategy.supportsIdentifier(identifier('https://id.undefineds.co/alice/data.ttl')),
    ).toBe(true);
  });

  it('maps both hosts to the same storage path', () => {
    expect(
      strategy.getStoragePath(identifier('https://node-1.nodes.undefineds.co/alice/data.ttl')),
    ).toBe('/alice/data.ttl');
    expect(
      strategy.getStoragePath(identifier('https://id.undefineds.co/alice/data.ttl')),
    ).toBe('/alice/data.ttl');
  });

  it('can derive the canonical SP URL for a relative pod path', () => {
    expect(strategy.getCanonicalUrl('/alice/data.ttl')).toBe(
      'https://node-1.nodes.undefineds.co/alice/data.ttl',
    );
  });
});
