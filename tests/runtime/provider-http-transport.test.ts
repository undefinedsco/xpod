import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);

describe('provider transport on native Bun', () => {
  it('pins DNS and preserves proxy, TLS, streaming and abort policy', async () => {
    const root = path.resolve('.test-data/provider-http-transport');
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, 'tls-'));
    const cert = path.join(directory, 'cert.pem');
    const key = path.join(directory, 'key.pem');
    try {
      await execute('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=native.provider.test', '-addext', 'subjectAltName=DNS:native.provider.test',
        '-keyout', key, '-out', cert,
      ]);
      const result = await execute(process.env.XPOD_TEST_BUN ?? 'bun', [
        '--no-env-file', 'tests/helpers/providerHttpTransportFixture.ts', cert, key,
      ], {
        timeout: 20_000,
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
      });
      expect(result.stdout).toContain('native provider transport verified');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
