import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'bun:test';

describe('cloud binary access configuration', () => {
  it('streams authenticated objects through Xpod instead of cross-origin redirects', async () => {
    const config = JSON.parse(await readFile('config/cloud.json', 'utf8')) as {
      '@graph': Array<Record<string, unknown>>;
    };
    const accessor = config['@graph'].find(entry => entry['@id'] === 'urn:undefineds:xpod:MixDataAccessor');

    expect(accessor?.presignedRedirectEnabled).toBe(false);
  });
});
