import { expect, test } from 'bun:test';
import { preflightRegistryInstalledProductConsumer, observeRegistryInstalledProductConsumer } from '../../scripts/lib/independent-admission/consumer-context';

test('unified registry consumer never accepts JSON identities as opaque products', async () => {
  for (const artifact of [{}, null, { identity: { package: '@undefineds.co/xpod-client' } },
    { identity: { package: '@undefineds.co/xpod-css-darwin-arm64', target: 'darwin-arm64' } }]) {
    expect(() => preflightRegistryInstalledProductConsumer({ artifact })).toThrow('real collected');
    await expect(observeRegistryInstalledProductConsumer({ artifact, stage: 'postpublish', registryObservation: {},
      evidenceDirectory: '/must-not-be-created' })).rejects.toThrow('real collected');
  }
});
