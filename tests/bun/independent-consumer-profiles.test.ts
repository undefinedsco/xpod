import { expect, test } from 'bun:test';
import { deriveConsumerProfileDeclarations, planClientConsumerProfiles } from '../../scripts/lib/independent-admission/consumer-profiles';

test('declarations derive full exports and optional peers without a special subpath list', () => {
  const result = deriveConsumerProfileDeclarations({ exports: { '.': {}, './arbitrary-feature': {} },
    peerDependencies: { optional: '^3.0.0', required: '~2.0.0' }, peerDependenciesMeta: { optional: { optional: true } } });
  expect(result.profiles[0].exports).toEqual(['.']);
  expect(result.profiles[0].peers.map(row => row.name)).toEqual(['required']);
  expect(result.profiles[1].exports).toEqual(['.', './arbitrary-feature']);
  expect(result.profiles[1].peers.map(row => row.name)).toEqual(['optional', 'required']);
  expect(result.profiles[0].matrix).toEqual([{ runtime: 'node', module: 'esm' }, { runtime: 'node', module: 'cjs' },
    { runtime: 'bun', module: 'esm' }, { runtime: 'bun', module: 'cjs' }]);
  expect(result.consumerVerified).toBe(false);
});
test('conditional root export remains the base entry', () => {
  expect(deriveConsumerProfileDeclarations({ exports: { import: './esm.js', require: './cjs.js' } }).profiles[1].exports).toEqual(['.']);
  expect(() => deriveConsumerProfileDeclarations({ exports: { './only-subpath': {} } })).toThrow('export map');
});
test('serialized declarations or success flags cannot create consumer plans', () => {
  expect(() => planClientConsumerProfiles({ identity: { package: '@undefineds.co/xpod-client' }, status: 'verified' })).toThrow('real collected');
});
