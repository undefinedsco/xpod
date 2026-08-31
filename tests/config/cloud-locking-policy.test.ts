import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Cloud locking policy', () => {
  it('does not replace CSS Redis lock waiting with a sub-second retry budget', async() => {
    const config = JSON.parse(await readFile('config/cloud.json', 'utf8')) as {
      '@graph': Array<Record<string, unknown>>;
    };

    const resourceLockerOverride = config['@graph'].find((entry) => {
      const instance = entry.overrideInstance as { '@id'?: string } | undefined;
      return instance?.['@id'] === 'urn:solid-server:default:ResourceLocker';
    });
    const parameters = resourceLockerOverride?.overrideParameters as {
      locker?: Record<string, unknown>;
      expiration?: number;
    } | undefined;

    expect(parameters?.locker).toMatchObject({
      '@type': 'UrlAwareRedisLocker',
    });
    expect(parameters?.locker).not.toHaveProperty('attemptSettings_retryCount');
    expect(parameters?.expiration).toBeGreaterThanOrEqual(120000);
  });
});
