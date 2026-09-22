import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  entryServesCandidate,
  evaluatePreflight,
  isPortFree,
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
    // The console forwards this tunnel to the entry the candidate itself serves.
    gatewayPort: 3399,
  };
  const verdict = (leg: string, legs: ReturnType<typeof evaluatePreflight>): string =>
    legs.find((entry) => entry.leg === leg)?.status ?? 'missing';

  it('calls every leg ready when the console facts and the network are in place', () => {
    const legs = evaluatePreflight(base);
    // ngrok, the named cloudflared tunnel and Sakura: the origin port needs no leg of its own
    // because the candidate serves the entry the console already forwards to.
    expect(legs.map((entry) => entry.leg)).toEqual([ 'ngrok', 'cloudflared-named', 'sakura' ]);
    expect(legs.map((entry) => entry.status)).toEqual([ 'ready', 'ready', 'ready' ]);
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

  it('plans the relay for a container client whose origin is the host loopback', () => {
    // The leg carries a loopback origin into the container's own namespace, so this is a
    // plan the run can execute rather than a blocker.
    const legs = evaluatePreflight({ ...base, frpc: { source: 'image' } });
    expect(verdict('sakura', legs)).toBe('ready');
    expect(legs[2].detail).toMatch(/relay namespace will carry the loopback origin/u);
  });

  it('treats a port another process holds as unusable for the tunnel origin', async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, '0.0.0.0', resolve));
    const address = holder.address();
    if (!address || typeof address === 'string') {
      throw new Error('holder has no port');
    }
    // A listener on the wildcard address owns the number even though IPv4 loopback alone
    // would still look free, and a candidate bound anywhere else stops being the origin.
    expect(await isPortFree(address.port)).toBe(false);
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    expect(await isPortFree(address.port)).toBe(true);
  });
});
