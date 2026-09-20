import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  entryServesCandidate,
  evaluatePreflight,
  readServicePids,
  requireCredentialFile,
  stripCloudRegistrationEnv,
} from '../../scripts/accept-network-tunnel';

describe('accept-network-tunnel candidate environment', () => {
  it('removes every input that would register the candidate with a Cloud', () => {
    const cleaned = stripCloudRegistrationEnv({
      PATH: '/usr/bin',
      HOME: '/Users/example',
      XPOD_CLOUD_API_ENDPOINT: 'https://api.undefineds.co/',
      XPOD_PROVISION_CODE: 'code',
      XPOD_PROVISION_URL: 'https://provision.example/',
      XPOD_NODE_ID: 'local-managed-node',
      XPOD_NODE_TOKEN: 'node-token',
      XPOD_SERVICE_TOKEN: 'service-token',
      XPOD_PUBLIC_URL: 'https://node.example/',
      XPOD_SP_DOMAIN: 'node.example',
      XPOD_GATEWAY_LOCATOR_SECRET: 'secret',
    });

    // Acceptance candidates must stay self-contained: a real Cloud registration would both
    // touch the operator's account and replace the entry under test.
    expect(Object.keys(cleaned).filter((key) => key.startsWith('XPOD_'))).toEqual([]);
    expect(cleaned.PATH).toBe('/usr/bin');
    expect(cleaned.HOME).toBe('/Users/example');
  });
});

describe('accept-network-tunnel credential file', () => {
  it('refuses to run without a credential file instead of reporting legs as unconfigured', () => {
    expect(() => requireCredentialFile(path.join(tmpdir(), 'xpod-accept-missing', '.env.acceptance')))
      .toThrow(/does not exist/u);
  });

  it('accepts an existing credential file', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'xpod-accept-env-'));
    const file = path.join(directory, '.env.acceptance');
    writeFileSync(file, 'NGROK_AUTHTOKEN=placeholder\n');
    expect(requireCredentialFile(file)).toBe(file);
  });
});

describe('accept-network-tunnel entry provenance', () => {
  const body = (pids: number[]): string => JSON.stringify(pids.map((pid) => ({ name: 'css', pid })));

  it('only accepts an entry that answers with this candidate runtime', () => {
    expect(entryServesCandidate(body([ 101, 102 ]), body([ 101, 102 ]))).toBe(true);
    // Same shape, different runtime: that is someone else's instance behind the hostname.
    expect(entryServesCandidate(body([ 101, 102 ]), body([ 201, 202 ]))).toBe(false);
  });

  it('refuses to claim provenance without evidence', () => {
    expect(entryServesCandidate(body([ 101 ]), 'not json')).toBe(false);
    expect(entryServesCandidate('', body([ 101 ]))).toBe(false);
    expect(readServicePids('[{"name":"css"}]')).toEqual([]);
  });
});

describe('accept-network-tunnel preflight', () => {
  const base = {
    ngrok: { credential: true, agentConfiguration: false, tcpReachable: true, tlsReachable: true },
    cloudflared: { token: true, hostname: 'entry.example.com', resolvedAddresses: [ '104.21.48.63' ] },
    sakura: {
      apiReachable: true,
      tunnelCount: 1,
      tunnel: { id: 114514, localIp: '127.0.0.1', localPort: 3399, node: 62, remote: '23333', nodeHost: 'frp-ski.com' },
    },
    frpc: { source: 'configured' as const },
    originPort: { port: 3399, free: true },
  };
  const verdict = (leg: string, legs: ReturnType<typeof evaluatePreflight>): string =>
    legs.find((entry) => entry.leg === leg)?.status ?? 'missing';

  it('calls every leg ready when the console facts and the network are in place', () => {
    const legs = evaluatePreflight(base);
    expect(legs.map((entry) => entry.status)).toEqual([ 'ready', 'ready', 'ready', 'ready' ]);
  });

  it('names a blocked network hop instead of blaming the provider', () => {
    const legs = evaluatePreflight({ ...base, ngrok: { ...base.ngrok, tlsReachable: false } });
    expect(verdict('ngrok', legs)).toBe('blocked');
    expect(legs[0].detail).toMatch(/resets TLS/u);
  });

  it('blocks the named tunnel when the token owns no tunnel', () => {
    const legs = evaluatePreflight({
      ...base,
      cloudflared: { ...base.cloudflared, registration: 'ERR Register tunnel error ... Unauthorized: Tunnel not found' },
    });
    expect(verdict('cloudflared-named', legs)).toBe('blocked');
    expect(legs[1].detail).toMatch(/does not own a tunnel/u);
  });

  it('blocks Sakura until a tunnel exists and forwards to the origin port', () => {
    const missing = evaluatePreflight({ ...base, sakura: { apiReachable: true, tunnelCount: 0 } });
    expect(verdict('sakura', missing)).toBe('blocked');
    expect(missing[2].detail).toMatch(/no tunnel yet/u);

    // A configured frpc is spawned with `-f`, which cannot be re-pointed at the candidate.
    const mismatched = evaluatePreflight({
      ...base,
      sakura: { ...base.sakura, tunnel: { ...base.sakura.tunnel, localPort: 443 } },
    });
    expect(verdict('sakura', mismatched)).toBe('blocked');
    expect(mismatched[2].detail).toMatch(/cannot be re-pointed/u);

    // With the vendor image the config can name this candidate's port instead.
    const adaptable = evaluatePreflight({
      ...base,
      frpc: { source: 'image' },
      sakura: { ...base.sakura, tunnel: { ...base.sakura.tunnel, localPort: 443, localIp: 'host.docker.internal' } },
    });
    expect(verdict('sakura', adaptable)).toBe('ready');
    expect(adaptable[2].detail).toMatch(/re-pointed from 443/u);
  });

  it('refuses a container client for a loopback origin', () => {
    const legs = evaluatePreflight({ ...base, frpc: { source: 'image' } });
    expect(verdict('sakura', legs)).toBe('blocked');
    expect(legs[2].detail).toMatch(/container client cannot reach the host loopback/u);
  });

  it('blocks when the origin port is taken', () => {
    const legs = evaluatePreflight({ ...base, originPort: { port: 3399, free: false } });
    expect(verdict('origin-port', legs)).toBe('blocked');
  });
});
