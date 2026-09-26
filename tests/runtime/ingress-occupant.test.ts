import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { describeOccupants, identifyIngressPortOccupants } from '../../src/runtime/ingress-occupant';
import { isFreePortForWildcard } from '../../src/runtime/port-finder';

/**
 * Port attribution exists for one reason: to *name* whoever holds a tunnel entry, so a refused
 * start points at a culprit instead of at a number. It never signals anything — there is no
 * SIGTERM/SIGKILL path, no pid record and no ownership verdict to be found here.
 */

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
    if (!await isFreePortForWildcard(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`nothing started listening on ${port}`);
}

describe('ingress port occupant identification', () => {
  it('names the pid and command line of a real listener', async() => {
    const port = await freePort();
    const child = startListener(port);
    await waitForListener(port);

    const occupants = identifyIngressPortOccupants(port);

    expect(occupants.occupants.map((occupant) => occupant.pid)).toContain(child.pid);
    expect(occupants.description).toContain(`pid ${child.pid}`);
    expect(occupants.description).toContain('node');
  }, 30_000);

  it('says so explicitly when the port is taken by something it cannot name', () => {
    const occupants = identifyIngressPortOccupants(4700, {
      exec: () => {
        throw new Error('lsof: command not found');
      },
    });

    expect(occupants.occupants).toEqual([]);
    expect(occupants.description).toMatch(/could be named|no listener reports/u);
  });

  it('describes an occupant with command, cwd and start time', () => {
    const description = describeOccupants(4700, [
      { pid: 12, command: '/usr/bin/other --serve', cwd: '/srv/other', startedAt: 'Mon Sep 22 17:28:46 2026' },
    ]);

    expect(description).toBe('pid 12 · /usr/bin/other --serve · cwd /srv/other · started Mon Sep 22 17:28:46 2026');
  });

  it('has no signal surface to call', async() => {
    // The module's whole contract: name the occupant. Everything a process could do with that
    // name — stopping it, moving the tunnel, ignoring it — belongs to the operator.
    const loaded = await import('../../src/runtime/ingress-occupant');
    const exported = Object.keys(loaded);

    expect(exported.some((name) => /kill|signal|reclaim|owner|record/i.test(name))).toBe(false);
    expect(exported.sort()).toEqual([ 'describeOccupants', 'identifyIngressPortOccupants' ]);
  });
});
