import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PORT_RESERVATION_DIR_ENV,
  RESERVED_PORTS_ENV,
  parseReservedPortsEnv,
  portReservation,
  readPortReservations,
  releasePort,
  reservePort,
  reservedPorts,
} from '../../src/runtime/port-reservations';

/**
 * The reservation mechanism is what keeps every other group off the fixed ports the network
 * group needs (the Cloudflare Dashboard and SakuraFrp console both forward to 5737 here).
 *
 * It is a claim about the future, not a lock: it is published in two places (an env var and a
 * file under `.test-data/`), it is read by every allocator, and it expires so a crashed run
 * cannot block a port forever. Nothing here signals a process.
 */
describe('port reservations', () => {
  const previousEnv = { ...process.env };
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'xpod-port-reservations-'));
    process.env[PORT_RESERVATION_DIR_ENV] = directory;
    delete process.env[RESERVED_PORTS_ENV];
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    for (const key of [ PORT_RESERVATION_DIR_ENV, RESERVED_PORTS_ENV ]) {
      if (previousEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousEnv[key];
      }
    }
  });

  it('publishes a reservation as a file another group can read', () => {
    reservePort({ port: 5737, owner: 'accept-network-1', group: 'network', note: 'console origin' });

    const [ reservation ] = readPortReservations();

    expect(reservation).toMatchObject({ port: 5737, owner: 'accept-network-1', group: 'network', source: 'file' });
    expect(reservedPorts().has(5737)).toBe(true);
    expect(portReservation(5737)?.note).toBe('console origin');
  });

  it('reads the env var as well, so a run can declare its fixed port without a file', () => {
    process.env[RESERVED_PORTS_ENV] = '5737, 4599';
    reservePort({ port: 6000, owner: 'accept-network-1', group: 'network' });

    expect(parseReservedPortsEnv(process.env[RESERVED_PORTS_ENV])).toEqual([ 5737, 4599 ]);
    expect([ ...reservedPorts() ].sort((left, right) => left - right)).toEqual([ 4599, 5737, 6000 ]);
  });

  it('ignores an expired reservation so a crashed run cannot block a port forever', () => {
    reservePort({ port: 5737, owner: 'crashed-run', group: 'network', reservedAt: '2020-01-01T00:00:00.000Z' });

    expect(reservedPorts().has(5737)).toBe(false);
    expect(portReservation(5737)).toBeUndefined();
  });

  it('only lets the owner release its own reservation', () => {
    reservePort({ port: 5737, owner: 'accept-network-1', group: 'network' });

    expect(releasePort(5737, 'someone-else')).toBe(false);
    expect(reservedPorts().has(5737)).toBe(true);
    expect(releasePort(5737, 'accept-network-1')).toBe(true);
    expect(reservedPorts().has(5737)).toBe(false);
  });

  it('ignores an unreadable reservation file instead of failing an allocation', () => {
    writeFileSync(path.join(directory, '5737.json'), '{ not json');

    expect(readPortReservations()).toEqual([]);
  });
});
