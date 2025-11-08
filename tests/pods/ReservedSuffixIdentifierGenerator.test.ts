import { describe, expect, it } from 'vitest';
import type { ResourceIdentifier } from '@solid/community-server';
import { ReservedSuffixIdentifierGenerator } from '../../src/pods/ReservedSuffixIdentifierGenerator';

describe('ReservedSuffixIdentifierGenerator', () => {
  it('rejects reserved names', () => {
    const generator = new ReservedSuffixIdentifierGenerator({ baseUrl: 'https://example.com/' });
    expect(() => generator.generate('admin')).toThrow('Pod identifier');
    expect(() => generator.generate('quota')).toThrow('Pod identifier');
    expect(() => generator.generate('signal')).toThrow('Pod identifier');
  });

  it('allows normal names', () => {
    const generator = new ReservedSuffixIdentifierGenerator({ baseUrl: 'https://example.com/' });
    const identifier = generator.generate('alice');
    expect(identifier).toEqual({ path: 'https://example.com/alice/' } satisfies ResourceIdentifier);
  });

  it('supports custom reserved list', () => {
    const generator = new ReservedSuffixIdentifierGenerator({ baseUrl: 'https://example.com/', reserved: [ 'pods' ] });
    expect(() => generator.generate('pods')).toThrow('Pod identifier');
  });
});
