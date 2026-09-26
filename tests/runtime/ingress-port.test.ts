import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  assertUsableIngressPort,
  defaultIngressPortDeps,
  IngressPortConflictError,
  resolveIngressPort,
  type IngressPortDeps,
  type IngressPortLogger,
} from '../../src/runtime/ingress-port';
import { identifyIngressPortOccupants } from '../../src/runtime/ingress-occupant';
import { isFreePortForWildcard } from '../../src/runtime/port-finder';
import type { DeclaredOriginReadResult } from '../../src/tunnel/TunnelDeclaredOrigin';

/**
 * The tunnel entry port: explicit pin → the console's declared origin → the gateway-derived
 * default.
 *
 * The two strict sources are strict about *being taken*: a port somebody else holds fails the
 * start with the occupant named, and nothing is signalled or silently substituted — a tunnel
 * forwards to a number, so it must find this runtime listening on it.
 */

interface Harness {
  deps: Partial<IngressPortDeps>;
  logger: { info: string[]; warn: string[] };
  occupied: Set<number>;
  findDefaultPort: Mock<[mainPort: number], Promise<number>>;
}

function harness(input: {
  defaultPort?: number;
  occupied?: number[];
  declared?: Record<string, DeclaredOriginReadResult>;
  describeOccupant?: (port: number) => string;
} = {}): Harness {
  const logger = { info: [] as string[], warn: [] as string[] };
  const occupied = new Set(input.occupied ?? []);
  const log: IngressPortLogger = {
    info: (message) => logger.info.push(message),
    warn: (message) => logger.warn.push(message),
  };
  const findDefaultPort = vi.fn(async(mainPort: number) => input.defaultPort ?? mainPort + 3);

  return {
    logger,
    occupied,
    findDefaultPort,
    deps: {
      findDefaultPort,
      isFree: async(port) => !occupied.has(port),
      identifyOccupants: (port) => input.describeOccupant?.(port)
        ?? `pid 90210 · /usr/local/bin/other-service --port ${port} · cwd /srv/other`,
      readDeclaredOrigin: async(profile) => input.declared?.[profile.id] ?? {
        error: `${profile.provider} reported no console origin`,
      },
      logger: log,
    },
  };
}

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

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('tunnel entry port resolution', () => {
  it('adopts the port the active profile\'s console declares', async() => {
    const harnessed = harness({
      declared: {
        'sakura-active': { origin: { port: 5737, readBack: 'sakura_frp:GET /v4/tunnels local_port' } },
      },
    });

    const resolution = await resolveIngressPort({
      mainPort: 3300,
      env: {},
      profiles: [ { id: 'sakura-active', provider: 'sakura_frp', credentialEnvKey: 'TOKEN' } ],
      activeProfileId: 'sakura-active',
      deps: harnessed.deps,
    });

    // The console owns the number: the runtime binds that one, not gateway+3.
    expect(resolution).toMatchObject({ port: 5737, source: 'console-declared' });
    expect(resolution.declared).toMatchObject({ profileId: 'sakura-active', provider: 'sakura_frp' });
    expect(harnessed.logger.info.join('\n')).toMatch(/Adopting the Sakura FRP console's tunnel origin 5737/u);
  });

  it('keeps a pin from being lost to a console declaration (finding B)', async() => {
    const harnessed = harness({
      declared: {
        'sakura-active': { origin: { port: 5737, readBack: 'sakura_frp:GET /v4/tunnels local_port' } },
      },
    });

    const resolution = await resolveIngressPort({
      mainPort: 3300,
      env: { XPOD_GATEWAY_INGRESS_PORT: '4599' },
      profiles: [ { id: 'sakura-active', provider: 'sakura_frp' } ],
      activeProfileId: 'sakura-active',
      deps: harnessed.deps,
    });

    expect(resolution).toMatchObject({ port: 4599, source: 'explicit' });
    expect(harnessed.logger.info.join('\n')).toMatch(/pinned to 4599/u);
  });

  it('keeps an explicit XPOD_GATEWAY_INGRESS_PORT over the gateway-derived default', async() => {
    const harnessed = harness({ defaultPort: 3399 });

    const resolution = await resolveIngressPort({
      mainPort: 3300,
      env: { XPOD_GATEWAY_INGRESS_PORT: '5737' },
      profiles: [],
      deps: harnessed.deps,
    });

    expect(resolution).toMatchObject({ port: 5737, source: 'explicit' });
    // Consulting the default at all would mean the pin had been ignored.
    expect(harnessed.findDefaultPort).not.toHaveBeenCalled();
  });

  it('fails loudly when the explicit port is held, naming the occupant and never falling back', async() => {
    const harnessed = harness({ occupied: [ 5737 ] });

    const failure = await resolveIngressPort({
      mainPort: 3300,
      env: { XPOD_GATEWAY_INGRESS_PORT: '5737' },
      profiles: [],
      deps: harnessed.deps,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IngressPortConflictError);
    expect((failure as Error).message).toContain('5737');
    expect((failure as Error).message).toContain('pid 90210');
    expect((failure as Error).message).toContain('other-service');
    // No silent substitution: the default port is never even consulted.
    expect(harnessed.findDefaultPort).not.toHaveBeenCalled();
  });

  it('fails a held console port with the occupant named, and leaves that process running', async() => {
    const port = await freePort();
    const script = 'const net = require("node:net");'
      + 'const server = net.createServer(() => undefined);'
      + 'server.listen(Number(process.argv[1]), "0.0.0.0");';
    const occupant = spawn(process.execPath, [ '-e', script, String(port) ], { stdio: 'ignore' });
    children.push(occupant);
    for (let attempt = 0; attempt < 50 && await isFreePortForWildcard(port); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const failure = await resolveIngressPort({
      mainPort: 3300,
      env: {},
      profiles: [ { id: 'sakura-active', provider: 'sakura_frp' } ],
      activeProfileId: 'sakura-active',
      deps: {
        ...harness({}).deps,
        // Real probing and real attribution: this is the path that names a foreign process.
        isFree: isFreePortForWildcard,
        identifyOccupants: (held) => identifyIngressPortOccupants(held).description,
        readDeclaredOrigin: async() => ({ origin: { port, readBack: 'sakura_frp:GET /v4/tunnels local_port' } }),
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IngressPortConflictError);
    expect((failure as Error).message).toContain(`pid ${occupant.pid}`);
    // The refusal is the whole behaviour: the foreign process is untouched.
    expect(isAlive(occupant.pid)).toBe(true);
  }, 30_000);

  it('refuses zero, out-of-range and privileged declared ports with the reason', async() => {
    for (const [ port, expectation ] of [
      [ 0, /not a usable port/u ],
      [ 70_000, /not a usable port/u ],
      [ 80, /privileged port/u ],
    ] as const) {
      const harnessed = harness({
        declared: { 'sakura-active': { origin: { port, readBack: 'sakura_frp:GET /v4/tunnels local_port' } } },
      });
      const failure = await resolveIngressPort({
        mainPort: 3300,
        env: {},
        profiles: [ { id: 'sakura-active', provider: 'sakura_frp' } ],
        activeProfileId: 'sakura-active',
        deps: harnessed.deps,
      }).catch((error: unknown) => error);

      expect(failure, `declared port ${port}`).toBeInstanceOf(Error);
      expect((failure as Error).message, `declared port ${port}`).toMatch(expectation);
      expect(harnessed.findDefaultPort, `declared port ${port}`).not.toHaveBeenCalled();
    }
  });

  it('never adopts a port that is one of this runtime\'s own service ports', () => {
    expect(() => assertUsableIngressPort(3300, { label: 'the console port', reservedPorts: new Set([ 3300 ]) }))
      .toThrow(/already serves/u);
  });

  it('rejects a malformed explicit pin instead of treating it as absent', async() => {
    const harnessed = harness();

    await expect(resolveIngressPort({
      mainPort: 3300,
      env: { XPOD_GATEWAY_INGRESS_PORT: 'fifty-seven' },
      profiles: [],
      deps: harnessed.deps,
    })).rejects.toThrow(/XPOD_GATEWAY_INGRESS_PORT="fifty-seven"/u);
  });

  it('lets the active profile win when two profiles declare different console ports', async() => {
    const harnessed = harness({
      declared: {
        'sakura-active': { origin: { port: 5737, readBack: 'sakura_frp:GET /v4/tunnels local_port' } },
        'sakura-old': { origin: { port: 3399, readBack: 'sakura_frp:GET /v4/tunnels local_port' } },
      },
    });

    const resolution = await resolveIngressPort({
      mainPort: 3300,
      env: {},
      profiles: [
        { id: 'sakura-active', provider: 'sakura_frp' },
        { id: 'sakura-old', provider: 'sakura_frp' },
      ],
      activeProfileId: 'sakura-active',
      deps: harnessed.deps,
    });

    expect(resolution.port).toBe(5737);
    expect(resolution.inactiveDeclarations).toEqual([
      { profileId: 'sakura-old', provider: 'sakura_frp', port: 3399, readBack: 'sakura_frp:GET /v4/tunnels local_port' },
    ]);
    // The inactive profile's number is reported, never silently used.
    expect(harnessed.logger.warn.join('\n')).toMatch(/sakura-old.*not active.*3399/u);
  });

  it('warns that an https console origin is not the scheme this listener speaks', async() => {
    const harnessed = harness({
      declared: {
        'cf': { origin: { port: 5737, scheme: 'https', readBack: 'cloudflare:connector remote-config' } },
      },
    });

    const resolution = await resolveIngressPort({
      mainPort: 3300,
      env: {},
      profiles: [ { id: 'cf', provider: 'cloudflare' } ],
      activeProfileId: 'cf',
      deps: harnessed.deps,
    });

    expect(resolution).toMatchObject({ port: 5737, source: 'console-declared' });
    expect(harnessed.logger.warn.join('\n')).toMatch(/speaks plain HTTP/u);
  });

  it('reports an unreadable console declaration instead of inventing a port for it', async() => {
    const harnessed = harness({ defaultPort: 3303 });

    const resolution = await resolveIngressPort({
      mainPort: 3300,
      env: {},
      profiles: [ { id: 'cf-active', provider: 'cloudflare' } ],
      activeProfileId: 'cf-active',
      deps: harnessed.deps,
    });

    expect(resolution).toMatchObject({ port: 3303, source: 'gateway-default' });
    expect(harnessed.logger.warn.join('\n')).toMatch(/could not be read/u);
  });

  it('does not ask a provider that owns its own origin port for a declaration', async() => {
    const readDeclaredOrigin = vi.fn(async() => ({ error: 'ngrok chooses its own origin port' }));
    const harnessed = harness({ defaultPort: 3303 });
    harnessed.deps.readDeclaredOrigin = readDeclaredOrigin;

    const resolution = await resolveIngressPort({
      mainPort: 3300,
      env: {},
      profiles: [ { id: 'ngrok-active', provider: 'ngrok' } ],
      activeProfileId: 'ngrok-active',
      deps: harnessed.deps,
    });

    expect(resolution).toMatchObject({ port: 3303, source: 'gateway-default' });
    expect(readDeclaredOrigin).not.toHaveBeenCalled();
  });

  it('defaults to the gateway-derived entry, never the gateway port itself', async() => {
    const deps = defaultIngressPortDeps();
    const port = await deps.findDefaultPort(5737);

    expect(port).not.toBe(5737);
    expect(port).toBeGreaterThanOrEqual(5740);
  });
});
