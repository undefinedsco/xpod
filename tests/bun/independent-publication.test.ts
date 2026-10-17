import { describe, expect, test } from 'bun:test';
import { planIndependentPublication } from '../../scripts/lib/independent-admission/publication';

describe('independent publication boundaries', () => {
  test('serialized passed records do not issue artifact or publication authority', () => {
    const fake = { identity: { package: '@undefineds.co/xpod-client', version: '1.0.0' }, status: 'verified', sourceQualified: true, registryConsumer: 'passed' };
    expect(() => planIndependentPublication({ client: fake, cli: fake, clientSource: fake, cliSource: fake })).toThrow('real central');
    expect(() => planIndependentPublication({ client: {}, cli: {}, clientSource: {}, cliSource: {} })).toThrow('real central');
  });
});
