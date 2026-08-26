import { describe, expect, it } from 'vitest';
import { resolveCloudSignalApiUrl } from '../../src/api/container/routes';

describe('Cloud managed-route endpoint', () => {
  it('uses the deployment public API URL for signaling', () => {
    expect(resolveCloudSignalApiUrl(
      {
        cloudApiEndpoint: 'https://api.undefineds.co',
        publicUrl: 'https://id-rc.undefineds.co',
      },
      { XPOD_PUBLIC_API_URL: 'https://api-rc.undefineds.co' },
    )).toBe('https://api-rc.undefineds.co');
  });

  it('falls back to the configured Cloud API endpoint', () => {
    expect(resolveCloudSignalApiUrl(
      { cloudApiEndpoint: 'https://api.undefineds.co' },
      {},
    )).toBe('https://api.undefineds.co');
  });
});
