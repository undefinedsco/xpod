import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertLegGatewayIsNotIngress,
  blockedCheck,
  blockedPrerequisite,
  classifyUnreachableEntry,
  decideLegPort,
  decideRunOutcome,
  describePortHolder,
  entryServesCandidate,
  evaluatePreflight,
  isPortFree,
  legPrerequisites,
  outcomeOf,
  parseTunnelGroup,
  prerequisiteFor,
  readServicePids,
  reserveNetworkPorts,
  requireCredentialFile,
  resolveTunnelGroups,
  retryTransient,
  stripCloudRegistrationEnv,
  summarizeHistory,
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
    expect(parseTunnelGroup(' external ')).toBe('external');
    expect(parseTunnelGroup(' network ')).toBe('network');
    expect(parseTunnelGroup('all')).toBe('all');
    expect(() => parseTunnelGroup('core')).toThrow(/unknown --group/u);
  });

  it('keeps the third-party legs out of the hermetic group', () => {
    // The default group is the parallel-safe one and it needs no provider: the legs whose verdict
    // depends on somebody else's API are selected only by `external` (or `all`), so an outage on
    // api.ngrok.com cannot change what a default run reports. The network group (fixed
    // parameters) never becomes a prerequisite for either, and never runs as part of them.
    expect(resolveTunnelGroups('default')).toEqual({ dynamic: true, external: false, network: false });
    expect(resolveTunnelGroups('external')).toEqual({ dynamic: true, external: true, network: false });
    expect(resolveTunnelGroups('network')).toEqual({ dynamic: false, external: false, network: true });
    expect(resolveTunnelGroups('all')).toEqual({ dynamic: true, external: true, network: true });
  });
});

describe('accept-network-tunnel outcome policy', () => {
  const passed = { id: 'isolation-matrix', ok: true };
  const failed = { id: 'public-entry-serves-candidate', ok: false };
  const blocked = {
    id: 'ngrok-real-entry',
    ok: false,
    outcome: 'blocked' as const,
    blockedBy: { prerequisite: 'ngrok', detail: 'api.ngrok.com:443 resets TLS', owner: "this machine's egress" },
  };

  it('is red only for a leg that could run and did not', () => {
    expect(decideRunOutcome([ passed, failed ], { strict: false })).toMatchObject({
      exitCode: 1, passed: 1, failed: 1, blocked: 0,
    });
    const green = decideRunOutcome([ passed ], { strict: false });
    expect(green.exitCode).toBe(0);
    expect(green.reasons).toEqual([]);
  });

  it('keeps a blocked prerequisite green unless the caller promised coverage', () => {
    const tolerant = decideRunOutcome([ passed, blocked ], { strict: false });
    expect(tolerant).toMatchObject({ exitCode: 0, passed: 1, failed: 0, blocked: 1 });
    // Reported even when it stays green: an unreached leg is a fact about the run.
    expect(tolerant.reasons).toEqual([ expect.stringContaining('api.ngrok.com:443 resets TLS') ]);

    const strict = decideRunOutcome([ passed, blocked ], { strict: true });
    expect(strict).toMatchObject({ exitCode: 1, blocked: 1 });
    expect(strict.reasons[0]).toContain("this machine's egress");
  });
});

describe('accept-network-tunnel prerequisites', () => {
  it('probes nothing it was not asked about, so a hermetic group stays hermetic', () => {
    expect(evaluatePreflight({})).toEqual([]);
    expect(evaluatePreflight({ frpc: { source: 'absent' } })).toEqual([]);
  });

  it('blocks a quick tunnel on the fact that is actually missing', () => {
    const noBinary = evaluatePreflight({ cloudflaredQuick: { binary: false, apiReachable: true, publicSuffixResolvable: true } });
    expect(noBinary).toEqual([ expect.objectContaining({ leg: 'cloudflared-quick', status: 'blocked' }) ]);
    expect(noBinary[0]!.detail).toMatch(/no cloudflared binary/u);

    const noEdge = evaluatePreflight({ cloudflaredQuick: { binary: true, apiReachable: false, publicSuffixResolvable: true } });
    expect(noEdge[0]!.detail).toMatch(/api\.trycloudflare\.com:443\) is unreachable/u);

    const noDns = evaluatePreflight({
      cloudflaredQuick: { binary: true, apiReachable: true, publicSuffixResolvable: false, resolutionDetail: 'ENOTFOUND' },
    });
    expect(noDns[0]!.detail).toMatch(/does not resolve here/u);
    expect(noDns[0]!.detail).toContain('ENOTFOUND');

    const ready = evaluatePreflight({ cloudflaredQuick: { binary: true, apiReachable: true, publicSuffixResolvable: true } });
    expect(ready).toEqual([ expect.objectContaining({ leg: 'cloudflared-quick', status: 'ready' }) ]);
  });

  it('names who owns each missing fact', () => {
    const blockers = legPrerequisites(evaluatePreflight({
      ngrok: { credential: false, agentConfiguration: false, tcpReachable: true, tlsReachable: true },
      cloudflaredQuick: { binary: false, apiReachable: true, publicSuffixResolvable: true },
      cloudflared: { token: false, resolvedAddresses: [] },
      sakura: { apiReachable: false, tunnelCount: 0 },
      frpc: { source: 'absent' },
    }));
    expect(blockers.map((entry) => entry.prerequisite)).toEqual([ 'ngrok', 'cloudflared-quick', 'cloudflared-named', 'sakura' ]);
    for (const blocker of blockers) {
      expect(blocker.status).toBe('blocked');
      expect(blocker.owner.length).toBeGreaterThan(0);
    }
    expect(prerequisiteFor(blockers, 'sakura')?.owner).toMatch(/SakuraFrp console/u);
    expect(prerequisiteFor(blockers, 'cloudflared-named')?.owner).toMatch(/Cloudflare console/u);
    expect(prerequisiteFor([], 'ngrok')).toBeUndefined();
  });

  it('records a blocked leg as blocked, never as a failure with a product name on it', () => {
    const check = blockedCheck({
      id: 'sakura-real-tunnel',
      entry: 'public',
      expectation: 'real SakuraFrp tunnel serves the candidate',
      leg: blockedPrerequisite('sakura', 'SAKURA_TUNNEL_TOKEN is not configured'),
    });
    expect(check.ok).toBe(false);
    expect(outcomeOf(check)).toBe('blocked');
    expect(check.blockedBy).toMatchObject({ prerequisite: 'sakura' });
    expect(outcomeOf({ ok: true })).toBe('passed');
    expect(outcomeOf({ ok: false })).toBe('failed');
  });
});

describe('accept-network-tunnel transient classification', () => {
  it('separates a provider defect from this machine not seeing the entry', () => {
    expect(classifyUnreachableEntry({
      hostname: 'thin-brook.trycloudflare.com',
      localResolved: false,
      localDetail: 'ENOTFOUND',
      publicDns: { exists: true, detail: 'public DNS has the name' },
    })).toMatchObject({ outcome: 'blocked' });
    expect(classifyUnreachableEntry({
      hostname: 'thin-brook.trycloudflare.com',
      localResolved: false,
      localDetail: 'ENOTFOUND',
      publicDns: { exists: true, detail: 'public DNS has the name' },
    }).detail).toMatch(/not in this machine's resolver|not resolvable/u);

    // Neither resolver knows the name: the provider never published anything usable, which is a
    // real failure of the leg and stays one.
    expect(classifyUnreachableEntry({
      hostname: 'thin-brook.trycloudflare.com',
      localResolved: false,
      localDetail: 'ENOTFOUND',
      publicDns: { exists: false, detail: 'public DNS status 3' },
    }).outcome).toBe('failed');
  });

  it('retries a late fact and jitters so parallel runs stop colliding', async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await retryTransient(
      async (attempt) => {
        calls += 1;
        return `try-${attempt}`;
      },
      { attempts: 3, delayMs: 1_000, sleep: async (ms) => { waits.push(ms); } },
    );
    expect(result).toEqual({ value: 'try-3', attempts: 3 });
    expect(calls).toBe(3);
    expect(waits).toHaveLength(2);
    for (const wait of waits) {
      expect(wait).toBeGreaterThanOrEqual(1_000);
      expect(wait).toBeLessThan(2_000);
    }
  });
});

describe('accept-network-tunnel run history', () => {
  it('turns per-leg outcomes into a rate, with blocked kept apart from failed', () => {
    const rows = summarizeHistory([
      {
        ranAt: '2026-01-01T00:00:00.000Z', candidateSha: 'a', candidateDirty: false, group: 'default', strict: false,
        checks: [ { id: 'isolation-matrix', outcome: 'passed' }, { id: 'ngrok-real-entry', outcome: 'blocked' } ],
        prerequisites: [],
      },
      {
        ranAt: '2026-01-02T00:00:00.000Z', candidateSha: 'b', candidateDirty: false, group: 'all', strict: false,
        checks: [ { id: 'isolation-matrix', outcome: 'passed' }, { id: 'ngrok-real-entry', outcome: 'passed' } ],
        prerequisites: [],
      },
    ]);
    const matrix = rows.find((row) => row.leg === 'isolation-matrix')!;
    expect(matrix).toMatchObject({ runs: 2, passed: 2, blocked: 0, failed: 0, notPassedRate: 0 });
    const ngrok = rows.find((row) => row.leg === 'ngrok-real-entry')!;
    expect(ngrok).toMatchObject({ runs: 2, passed: 1, blocked: 1, failed: 0, notPassedRate: 0.5 });
    // Worst first: the row that says "unstable" is the one to read.
    expect(rows[0]!.leg).toBe('ngrok-real-entry');
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

  interface Listener {
    child: ChildProcess;
    port: number;
  }

  /**
   * Binds a real listener, and reports the port it actually got.
   *
   * "Ask for a free port, then let a child bind it later" is a race: another worker of the same
   * suite (or a concurrent run next door) can take the number in between, and the child then dies
   * with EADDRINUSE while the test waits for a listener that will never come. The child therefore
   * announces its own success, and a failed bind is retried on a new port instead of being read as
   * a timeout.
   */
  async function startListener(preferredPort?: number): Promise<Listener> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const port = preferredPort ?? await freePort();
      const script = 'const net = require("node:net");'
        + 'const server = net.createServer(() => undefined);'
        + 'server.on("error", (error) => { console.error(error.code); process.exit(1); });'
        + 'server.listen(Number(process.argv[1]), "0.0.0.0", () => console.log("listening"));';
      const child = spawn(process.execPath, [ '-e', script, String(port) ], { stdio: [ 'ignore', 'pipe', 'ignore' ] });
      children.push(child);
      if (await waitForListener(child)) {
        return { child, port };
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
    throw new Error('no listener could bind a port of its own');
  }

  /** The child says so itself: polling the port cannot tell "not yet" from "the bind failed". */
  async function waitForListener(child: ChildProcess): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const deadline = setTimeout(() => resolve(false), 15_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('listening')) {
          clearTimeout(deadline);
          resolve(true);
        }
      });
      child.once('exit', () => {
        clearTimeout(deadline);
        resolve(false);
      });
    });
  }

  it('runs a dynamic leg and a console-bound leg together without interfering', async() => {
    const consolePort = await freePort();
    const reserved = new Set([ consolePort ]);
    // A busy preferred port: the dynamic leg has to move, and the only port it may not take is
    // the one the console-bound leg needs.
    const holder = await startListener();
    const busyPort = holder.port;

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
    expect(dynamicLeg.detail).toMatch(new RegExp(`taken \\(pid ${holder.child.pid}`, 'u'));
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
      const holder = await startListener();
      const fixed = holder.port;
      reservePort({ port: fixed, owner: 'accept-network-test', group: 'network' });

      const records: LegPortRecord[] = [];
      const decision = await takeLegPort(
        { leg: 'cloudflared-named', group: 'network', policy: 'console-bound', consolePort: fixed },
        records,
        new Set([ fixed ]),
      );

      expect(decision.ok).toBe(false);
      expect(decision.detail).toContain(`pid ${holder.child.pid}`);
      expect(decision.detail).toMatch(/reserved by group network \(owner accept-network-test/u);
      expect(records[0]).toMatchObject({ group: 'network', portPolicy: 'console-bound', fixedPort: fixed, ok: false });
      // Still no eviction: the holder keeps the port.
      expect(holder.child.exitCode).toBeNull();
      expect(await isPortFree(fixed)).toBe(false);
    } finally {
      if (previousDirectory === undefined) delete process.env[PORT_RESERVATION_DIR_ENV];
      else process.env[PORT_RESERVATION_DIR_ENV] = previousDirectory;
    }
  }, 30_000);

  it('reports a console-bound leg whose port is foreign-occupied, and leaves that process alive', async() => {
    const holder = await startListener();
    const consolePort = holder.port;

    const decision = await decideLegPort({
      leg: 'cloudflared-named',
      policy: 'console-bound',
      consolePort,
      isFree: isPortFree,
      describeOccupant: describePortHolder,
    });

    expect(decision.ok).toBe(false);
    expect(decision.port).toBeUndefined();
    expect(decision.detail).toContain(`pid ${holder.child.pid}`);
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
    expect(holder.child.exitCode).toBeNull();
    expect(await isPortFree(consolePort)).toBe(false);
  }, 30_000);
});
