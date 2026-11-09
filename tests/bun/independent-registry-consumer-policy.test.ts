import { expect, it } from 'bun:test';
import { describeRegistryConsumerStatus } from '../../scripts/lib/independent-admission/publication';

// These are report-policy fixtures, not collected/consumer capabilities.
it('does not upgrade complete local archive imports to registry installation', () => {
  const smoke = { allProfilesVerified: true, scope: 'local exact-artifact imports/exports smoke; no registry install' };
  expect(describeRegistryConsumerStatus(smoke).status).toBe('pending');
  expect(describeRegistryConsumerStatus({ ...smoke, registryInstallVerified: false }).status).toBe('pending');
});

it('requires complete profiles as well as registry installation in reports', () => {
  expect(describeRegistryConsumerStatus(undefined).status).toBe('pending');
  expect(describeRegistryConsumerStatus({ allProfilesVerified: false, registryInstallVerified: true, scope: 'installation only' }).status).toBe('pending');
  expect(describeRegistryConsumerStatus({ allProfilesVerified: true, registryInstallVerified: true, scope: 'fixed installed consumer' }).status).toBe('verified');
});
