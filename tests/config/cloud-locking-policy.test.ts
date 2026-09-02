import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('CSS locking policy', () => {
  it.each([
    ['cloud', 'config/cloud.json', 'UrlAwareRedisLocker'],
    ['local', 'config/local.json', 'GreedyReadWriteLocker'],
    ['xpod', 'config/xpod.json', 'GreedyReadWriteLocker'],
  ])('sets %s ResourceLocker expiration to the standard 6000ms budget', async(_name, configPath, lockerType) => {
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
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
      '@type': lockerType,
    });
    expect(parameters?.locker).not.toHaveProperty('attemptSettings_retryCount');
    expect(parameters?.expiration).toBe(6000);
  });
});
