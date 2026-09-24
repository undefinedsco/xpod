import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertLegGatewayIsNotIngress,
  decideLegPort,
  describePortHolder,
  entryServesCandidate,
  evaluatePreflight,
  isPortFree,
  parseTunnelGroup,
  readServicePids,
  reserveNetworkPorts,
  requireCredentialFile,
  resolveTunnelGroups,
  stripCloudRegistrationEnv,
  takeLegPort,
  type LegPortRecord,
} from '../../scripts/accept-network-tunnel';
import {
  portReservation,
  PORT_RESERVATION_DIR_ENV,
  releasePort,
  reservePort,
  RESERVED_PORTS_ENV,
} from '../../src/runtime/port-reservations';

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
    cloudflared: {
      token: true,
      hostname: 'entry.example.com',
      resolvedAddresses: [ '104.21.48.63' ],
      // The Dashboard's local service port, and the fact that it is free to pin right now.
      consolePort: 5737,
      consolePortFree: true,
    },
    sakura: {
      apiReachable: true,
      tunnelCount: 1,
      tunnel: { id: 114514, localIp: '127.0.0.1', localPort: 5737, node: 62, remote: '23333', nodeHost: 'frp-ski.com' },
      localPortFree: true,
    },
    frpc: { source: 'configured' as const },
  };
  const verdict = (leg: string, legs: ReturnType<typeof evaluatePreflight>): string =>
    legs.find((entry) => entry.leg === leg)?.status ?? 'missing';

  it('calls every leg ready when the console facts and the network are in place', () => {
    const legs = evaluatePreflight(base);
    // ngrok, the named cloudflared tunnel and Sakura: the console-bound legs pin the port
    // their console already forwards to, so a free console port is the whole prerequisite.
    expect(legs.map((entry) => entry.leg)).toEqual([ 'ngrok', 'cloudflared-named', 'sakura' ]);
    expect(legs.map((entry) => entry.status)).toEqual([ 'ready', 'ready', 'ready' ]);
    expect(legs[1].detail).toMatch(/pins the Dashboard's local port 5737/u);
    expect(legs[2].detail).toMatch(/pins the console's local port/u);
  });

  it('blocks a console-bound leg whose console port a foreign process holds, and names it', () => {
    const cloudflaredBlocked = evaluatePreflight({
      ...base,
      cloudflared: { ...base.cloudflared, consolePortFree: false, consolePortOccupant: 'pid 4242 · other-service' },
    });
    expect(verdict('cloudflared-named', cloudflaredBlocked)).toBe('blocked');
    expect(cloudflaredBlocked[1].detail).toMatch(/pid 4242/u);
    expect(cloudflaredBlocked[1].detail).toMatch(/never kills it and never moves the leg/u);

    const sakuraBlocked = evaluatePreflight({
      ...base,
      sakura: { ...base.sakura, localPortFree: false, localPortOccupant: 'pid 4243 · another-service' },
    });
    expect(verdict('sakura', sakuraBlocked)).toBe('blocked');
    expect(sakuraBlocked[2].detail).toMatch(/pid 4243/u);
  });

  it('needs the Dashboard port read back for the named leg, never a derived entry', () => {
    const legs = evaluatePreflight({
      ...base,
      cloudflared: {
        ...base.cloudflared,
        consolePort: undefined,
        consolePortFree: undefined,
        consolePortError: 'cloudflared exited with code 255 before reporting the tunnel\'s remote configuration',
      },
    });
    expect(verdict('cloudflared-named', legs)).toBe('blocked');
    expect(legs[1].detail).toMatch(/could not be determined.*exited with code 255/u);
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

  it('blocks Sakura until a tunnel exists and declares a local port', () => {
    const missing = evaluatePreflight({ ...base, sakura: { apiReachable: true, tunnelCount: 0 } });
    expect(verdict('sakura', missing)).toBe('blocked');
    expect(missing[2].detail).toMatch(/no tunnel yet/u);

    // The console owns the port, so a console that declares none gives the leg nothing to pin.
    const undeclared = evaluatePreflight({
      ...base,
      sakura: { ...base.sakura, tunnel: { ...base.sakura.tunnel, localPort: undefined }, localPortFree: undefined },
    });
    expect(verdict('sakura', undeclared)).toBe('blocked');
    expect(undeclared[2].detail).toMatch(/declares no local port/u);
  });

  it('plans the relay for a container client whose origin is the host loopback', () => {
    // The leg carries the console's own port into the container's namespace, so this is a
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

describe('accept-network-tunnel groups', () => {
  it('selects one group with one flag, and validates it', () => {
    expect(parseTunnelGroup('default')).toBe('default');
    expect(parseTunnelGroup(' network ')).toBe('network');
    expect(parseTunnelGroup('all')).toBe('all');
    expect(() => parseTunnelGroup('core')).toThrow(/unknown --group/u);

    // The default group is the parallel-safe one; the network group (fixed parameters) never
    // becomes a prerequisite for it, and it never runs as part of it.
    expect(resolveTunnelGroups('default')).toEqual({ dynamic: true, network: false });
    expect(resolveTunnelGroups('network')).toEqual({ dynamic: false, network: true });
    expect(resolveTunnelGroups('all')).toEqual({ dynamic: true, network: true });
  });
});

describe('accept-network-tunnel leg ports', () => {
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });

  async function freePort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '0.0.0.0', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close((error) => (error ? reject(error) : resolve(port)));
      });
    });
  }

  function startListener(port: number): ChildProcess {
    const script = 'const net = require("node:net");'
      + 'const server = net.createServer(() => undefined);'
      + 'server.listen(Number(process.argv[1]), "0.0.0.0");';
    const child = spawn(process.execPath, [ '-e', script, String(port) ], { stdio: 'ignore' });
    children.push(child);
    return child;
  }

  async function waitForListener(port: number): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!await isPortFree(port)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`nothing started listening on ${port}`);
  }

  it('runs a dynamic leg and a console-bound leg together without interfering', async() => {
    const consolePort = await freePort();
    const reserved = new Set([ consolePort ]);
    // A busy preferred port: the dynamic leg has to move, and the only port it may not take is
    // the one the console-bound leg needs.
    const busyPort = await freePort();
    const holder = startListener(busyPort);
    await waitForListener(busyPort);

    const consoleLeg = await decideLegPort({
      leg: 'sakura-real-tunnel',
      policy: 'console-bound',
      consolePort,
      isFree: isPortFree,
      describeOccupant: describePortHolder,
    });
    const dynamicLeg = await decideLegPort({
      leg: 'ngrok-real',
      policy: 'dynamic',
      preferred: busyPort,
      reserved,
      isFree: isPortFree,
      describeOccupant: describePortHolder,
    });

    expect(consoleLeg.ok).toBe(true);
    // The console's number is the *ingress* listener this leg pins; the candidate's Gateway is
    // a port of its own. Serving both roles on one number is what the runtime refuses (and what
    // would put forwarded traffic on the operator surface), so this separation is the contract.
    expect(consoleLeg.consolePort).toBe(consolePort);
    expect(consoleLeg.ingressPort).toBe(consolePort);
    expect(consoleLeg.ingressPinned).toBe(true);
    expect(consoleLeg.port).toBeDefined();
    expect(consoleLeg.port).not.toBe(consolePort);
    expect(dynamicLeg.ok).toBe(true);
    expect(dynamicLeg.port).not.toBe(consolePort);
    expect(dynamicLeg.port).not.toBe(busyPort);
    // The console's port is still the console's after the dynamic leg picked its own.
    expect(await isPortFree(consolePort)).toBe(true);
    expect(dynamicLeg.detail).toMatch(new RegExp(`taken \\(pid ${holder.pid}`, 'u'));
  }, 30_000);

  it('keeps a console-bound Gateway off the console port even when that port is preferred', async() => {
    const consolePort = await freePort();
    const decision = await decideLegPort({
      leg: 'cloudflared-named',
      policy: 'console-bound',
      consolePort,
      // The conflation this guards against: asking for the console's number as the Gateway.
      preferred: consolePort,
      isFree: isPortFree,
      describeOccupant: describePortHolder,
    });

    expect(decision.ok).toBe(true);
    expect(decision.port).toBeDefined();
    expect(decision.port).not.toBe(consolePort);
    expect(decision.ingressPort).toBe(consolePort);
    expect(decision.ingressPinned).toBe(true);
    expect(decision.detail).toMatch(/has to stay the ingress listener/u);
    expect(() => assertLegGatewayIsNotIngress('cloudflared-named', decision.port!, consolePort)).not.toThrow();
  }, 30_000);

  it('refuses, before any spawn, to serve the Gateway on the pinned ingress port', () => {
    expect(() => assertLegGatewayIsNotIngress('sakura-real-tunnel', 5737, 5737))
      .toThrow(/needs its own Gateway on a dynamic port/u);
    expect(() => assertLegGatewayIsNotIngress('sakura-real-tunnel', 3650, 5737)).not.toThrow();
  });

  it('records the console port as the ingress and a dynamic port as the Gateway', async() => {
    const consolePort = await freePort();
    const records: LegPortRecord[] = [];
    const decision = await takeLegPort(
      { leg: 'cloudflared-named', group: 'network', policy: 'console-bound', consolePort },
      records,
      new Set([ consolePort ]),
    );

    expect(decision.ok).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      leg: 'cloudflared-named',
      group: 'network',
      portPolicy: 'console-bound',
      consolePort,
      fixedPort: consolePort,
      ingressPort: consolePort,
      ingressPinned: true,
      ok: true,
    });
    expect(records[0].port).not.toBe(consolePort);
  }, 30_000);

  it('publishes the network group\'s fixed ports as a reservation every other group skips', () => {
    const previousDirectory = process.env[PORT_RESERVATION_DIR_ENV];
    const previousPorts = process.env[RESERVED_PORTS_ENV];
    const reservationDirectory = mkdtempSync(path.join(tmpdir(), 'xpod-accept-reservations-'));
    process.env[PORT_RESERVATION_DIR_ENV] = reservationDirectory;
    delete process.env[RESERVED_PORTS_ENV];
    try {
      const reservations = reserveNetworkPorts(
        { reservedPorts: [ 5737, 5737 ], group: 'network' } as Parameters<typeof reserveNetworkPorts>[0],
        'accept-network-test',
      );

      expect(reservations).toHaveLength(1);
      expect(reservations[0]).toMatchObject({ port: 5737, group: 'network', owner: 'accept-network-test' });
      // The env var is what child candidates inherit; the file is what other groups read.
      expect(process.env[RESERVED_PORTS_ENV]).toBe('5737');
      expect(portReservation(5737)?.owner).toBe('accept-network-test');
      expect(releasePort(5737, 'accept-network-test')).toBe(true);
    } finally {
      rmSync(reservationDirectory, { recursive: true, force: true });
      if (previousDirectory === undefined) delete process.env[PORT_RESERVATION_DIR_ENV];
      else process.env[PORT_RESERVATION_DIR_ENV] = previousDirectory;
      if (previousPorts === undefined) delete process.env[RESERVED_PORTS_ENV];
      else process.env[RESERVED_PORTS_ENV] = previousPorts;
    }
  });

  it('skips a reserved port in a non-network group and reports it for the network group', async() => {
    const previousDirectory = process.env[PORT_RESERVATION_DIR_ENV];
    const previousPorts = process.env[RESERVED_PORTS_ENV];
    const reservationDirectory = mkdtempSync(path.join(tmpdir(), 'xpod-accept-reservations-'));
    process.env[PORT_RESERVATION_DIR_ENV] = reservationDirectory;
    process.env[RESERVED_PORTS_ENV] = '';
    try {
      const fixed = await freePort();
      reservePort({ port: fixed, owner: 'accept-network-test', group: 'network' });

      // A dynamic leg must never take a reserved port, even when it is free and preferred.
      const dynamicLeg = await decideLegPort({
        leg: 'candidate-gateway',
        policy: 'dynamic',
        preferred: fixed,
        reserved: new Set([ fixed ]),
        isFree: isPortFree,
        describeOccupant: describePortHolder,
      });
      expect(dynamicLeg.ok).toBe(true);
      expect(dynamicLeg.port).not.toBe(fixed);

      // The network group's own leg adopts exactly that port - as its ingress listener, while
      // its Gateway stays a port of its own.
      const networkLeg = await decideLegPort({
        leg: 'cloudflared-named',
        policy: 'console-bound',
        consolePort: fixed,
        isFree: isPortFree,
        describeOccupant: describePortHolder,
      });
      expect(networkLeg.ok).toBe(true);
      expect(networkLeg.ingressPort).toBe(fixed);
      expect(networkLeg.ingressPinned).toBe(true);
      expect(networkLeg.port).not.toBe(fixed);
    } finally {
      rmSync(reservationDirectory, { recursive: true, force: true });
      if (previousDirectory === undefined) delete process.env[PORT_RESERVATION_DIR_ENV];
      else process.env[PORT_RESERVATION_DIR_ENV] = previousDirectory;
      if (previousPorts === undefined) delete process.env[RESERVED_PORTS_ENV];
      else process.env[RESERVED_PORTS_ENV] = previousPorts;
    }
  }, 30_000);

  it('names both the occupant and the reservation when a fixed port is taken anyway', async() => {
    const previousDirectory = process.env[PORT_RESERVATION_DIR_ENV];
    const reservationDirectory = mkdtempSync(path.join(tmpdir(), 'xpod-accept-reservations-'));
    process.env[PORT_RESERVATION_DIR_ENV] = reservationDirectory;
    try {
      const fixed = await freePort();
      const holder = startListener(fixed);
      await waitForListener(fixed);
      reservePort({ port: fixed, owner: 'accept-network-test', group: 'network' });

      const records: LegPortRecord[] = [];
      const decision = await takeLegPort(
        { leg: 'cloudflared-named', group: 'network', policy: 'console-bound', consolePort: fixed },
        records,
        new Set([ fixed ]),
      );

      expect(decision.ok).toBe(false);
      expect(decision.detail).toContain(`pid ${holder.pid}`);
      expect(decision.detail).toMatch(/reserved by group network \(owner accept-network-test/u);
      expect(records[0]).toMatchObject({ group: 'network', portPolicy: 'console-bound', fixedPort: fixed, ok: false });
      // Still no eviction: the holder keeps the port.
      expect(holder.exitCode).toBeNull();
      expect(await isPortFree(fixed)).toBe(false);
    } finally {
      if (previousDirectory === undefined) delete process.env[PORT_RESERVATION_DIR_ENV];
      else process.env[PORT_RESERVATION_DIR_ENV] = previousDirectory;
    }
  }, 30_000);

  it('reports a console-bound leg whose port is foreign-occupied, and leaves that process alive', async() => {
    const consolePort = await freePort();
    const holder = startListener(consolePort);
    await waitForListener(consolePort);

    const decision = await decideLegPort({
      leg: 'cloudflared-named',
      policy: 'console-bound',
      consolePort,
      isFree: isPortFree,
      describeOccupant: describePortHolder,
    });

    expect(decision.ok).toBe(false);
    expect(decision.port).toBeUndefined();
    expect(decision.detail).toContain(`pid ${holder.pid}`);
    expect(decision.detail).toMatch(/refuses to kill a foreign process/u);
    expect(decision.detail).toMatch(/refuses to move a console-bound leg/u);

    // A dynamic leg in the same run still gets a free port of its own.
    const dynamicLeg = await decideLegPort({
      leg: 'candidate-gateway',
      policy: 'dynamic',
      preferred: consolePort,
      reserved: new Set([ consolePort ]),
      isFree: isPortFree,
      describeOccupant: describePortHolder,
    });
    expect(dynamicLeg.ok).toBe(true);
    expect(dynamicLeg.port).not.toBe(consolePort);

    // The foreign process is untouched: no signal, no eviction, just a named refusal.
    expect(holder.exitCode).toBeNull();
    expect(await isPortFree(consolePort)).toBe(false);
  }, 30_000);
});
