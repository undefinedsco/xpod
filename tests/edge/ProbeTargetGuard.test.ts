import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  assertPublicProbeTarget,
  createPinnedHeadProbeRequest,
  isPublicIpAddress,
} from '../../src/edge/ProbeTargetGuard';

describe('isPublicIpAddress', () => {
  it('rejects every address family a probe must not reach', () => {
    for (const address of [
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.5.4',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPublicIpAddress(address), address).toBe(false);
    }
  });

  it('accepts ordinary public unicast addresses', () => {
    expect(isPublicIpAddress('93.184.216.34')).toBe(true);
    expect(isPublicIpAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(true);
  });
});

describe('assertPublicProbeTarget', () => {
  it('refuses loopback, private and metadata targets without resolving them', async () => {
    const resolveAddresses = vi.fn();
    for (const target of [
      'http://127.0.0.1:3000/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'http://[::1]:8080/',
      'http://[fd00::1]/',
    ]) {
      const decision = await assertPublicProbeTarget(new URL(target), resolveAddresses);
      expect(decision.allowed, target).toBe(false);
    }
    expect(resolveAddresses).not.toHaveBeenCalled();
  });

  it('refuses non-http schemes', async () => {
    const decision = await assertPublicProbeTarget(new URL('file:///etc/passwd'));
    expect(decision).toEqual({ allowed: false, reason: 'unsupported-scheme:file:' });
  });

  it('refuses a hostname when any resolved address is non-public', async () => {
    const decision = await assertPublicProbeTarget(
      new URL('https://edge.example/'),
      async() => [ '93.184.216.34', '127.0.0.1' ],
    );

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('non-public-address:127.0.0.1');
    }
  });

  it('refuses unresolvable hostnames and accepts public resolutions', async () => {
    const failing = await assertPublicProbeTarget(
      new URL('https://edge.example/'),
      async() => { throw new Error('ENOTFOUND'); },
    );
    expect(failing.allowed).toBe(false);

    const allowed = await assertPublicProbeTarget(new URL('https://edge.example/'), async() => [ '93.184.216.34' ]);
    expect(allowed).toEqual({ allowed: true, address: '93.184.216.34' });
  });
});

describe('createPinnedHeadProbeRequest', () => {
  it('connects to the validated address instead of resolving the hostname again', async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(request.headers.host?.startsWith('edge.example') ? 204 : 400);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      // `edge.example` does not resolve to the test server; pinning is what routes the
      // request there, which is exactly the guarantee DNS rebinding would bypass.
      const probe = createPinnedHeadProbeRequest();
      const result = await probe(new URL(`http://edge.example:${port}/health`), {
        address: '127.0.0.1',
        timeoutMs: 2_000,
      });

      expect(result.status).toBe(204);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
