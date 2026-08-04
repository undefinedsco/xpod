import { describe, expect, it, vi } from 'vitest';
import {
  parseRcR2Config,
  verifyRcR2Access,
  type RcR2BucketProbe,
} from '../../scripts/verify-rc-r2-access';

describe('RC R2 access verification', () => {
  it('parses the compatibility variables without exposing credentials', () => {
    expect(parseRcR2Config([
      'CSS_MINIO_ENDPOINT=https://account.r2.cloudflarestorage.com/xpod',
      'CSS_MINIO_BUCKET_NAME=xpod-rc',
      'CSS_MINIO_ACCESS_KEY=access-secret',
      'CSS_MINIO_SECRET_KEY=secret-secret',
    ].join('\n'))).toEqual({
      endpoint: 'https://account.r2.cloudflarestorage.com/xpod',
      bucket: 'xpod-rc',
      accessKey: 'access-secret',
      secretKey: 'secret-secret',
    });
  });

  it('requires the dedicated RC bucket before making a network request', async () => {
    const probe: RcR2BucketProbe = { bucketExists: vi.fn(async () => true) };

    await expect(verifyRcR2Access({
      endpoint: 'https://account.r2.cloudflarestorage.com',
      bucket: 'xpod',
      accessKey: 'access-secret',
      secretKey: 'secret-secret',
    }, () => probe)).rejects.toThrow('RC object-store bucket must be xpod-rc');
    expect(probe.bucketExists).not.toHaveBeenCalled();
  });

  it('checks xpod-rc with the configured client', async () => {
    const bucketExists = vi.fn(async () => true);

    await verifyRcR2Access({
      endpoint: 'https://account.r2.cloudflarestorage.com/xpod',
      bucket: 'xpod-rc',
      accessKey: 'access-secret',
      secretKey: 'secret-secret',
    }, () => ({ bucketExists }));

    expect(bucketExists).toHaveBeenCalledWith('xpod-rc');
  });

  it('normalizes denied access without including credential values', async () => {
    const error = await verifyRcR2Access({
      endpoint: 'https://account.r2.cloudflarestorage.com',
      bucket: 'xpod-rc',
      accessKey: 'access-secret',
      secretKey: 'secret-secret',
    }, () => ({
      bucketExists: async () => {
        throw new Error('AccessDenied for access-secret and secret-secret');
      },
    })).catch((caught: unknown) => caught as Error);

    if (!error) throw new Error('Expected RC R2 access verification to fail');
    expect(error.message).toBe('RC R2 bucket xpod-rc is not accessible with the configured credentials');
    expect(error.message).not.toContain('access-secret');
    expect(error.message).not.toContain('secret-secret');
  });
});
