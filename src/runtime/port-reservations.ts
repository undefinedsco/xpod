import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/**
 * Port reservations: one small mechanism that keeps every *other* group off the fixed ports a
 * group needs.
 *
 * The tunnel acceptance has two legs whose origin port is not ours to choose — the Cloudflare
 * Dashboard's local service port and the SakuraFrp console's `local_port`, both 5737 on the
 * operator's machine. Those are fixed parameters, so the group that needs them publishes a
 * reservation, and every port *allocator* in the repo skips reserved ports:
 *
 * - allocation helpers in `src/runtime/port-finder.ts` (which is what the runtime, the test
 *   helpers, `run-integration-full`/`run-integration-lite` and the acceptance harness use);
 * - the harness's own free-port helpers.
 *
 * Two sources, both optional and both additive:
 * - the `XPOD_RESERVED_PORTS` env var (`"5737,4599"`), for a run that knows its fixed ports;
 * - one JSON file per reservation under `.test-data/port-reservations/`, for a group that
 *   holds a port for the duration of a run.
 *
 * A reservation is a *claim about the future*, not a lock: it is never enforced against a
 * process that ignores it. That is deliberate — the network group fails loudly naming whoever
 * holds its port, and nothing in this repo signals a process it does not own.
 *
 * Reservations expire (12h by default) so a crashed run cannot block a port forever.
 */

export const RESERVED_PORTS_ENV = 'XPOD_RESERVED_PORTS';
export const PORT_RESERVATION_DIR_ENV = 'XPOD_PORT_RESERVATION_DIR';

export interface PortReservation {
  port: number;
  /** Who holds it: a run id, a harness name, an operator. */
  owner: string;
  /** Which group needs the fixed port (`network` for the tunnel acceptance). */
  group: string;
  /** ISO timestamp the reservation was written. */
  reservedAt: string;
  /** Why this port is fixed, so the next person does not have to guess. */
  note?: string;
  /** Where the reservation came from, so a log line can name the source. */
  source?: 'file' | 'env';
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1_000;
const DEFAULT_DIRECTORY = path.join('.test-data', 'port-reservations');

export function portReservationDir(root: string = process.cwd()): string {
  return process.env[PORT_RESERVATION_DIR_ENV]?.trim() || path.join(root, DEFAULT_DIRECTORY);
}

export function portReservationFile(port: number, root: string = process.cwd()): string {
  return path.join(portReservationDir(root), `${port}.json`);
}

/** Publishes a reservation (idempotent for the same owner and port). */
export function reservePort(
  reservation: Omit<PortReservation, 'reservedAt'> & { reservedAt?: string },
  root: string = process.cwd(),
): PortReservation {
  const record: PortReservation = {
    ...reservation,
    reservedAt: reservation.reservedAt ?? new Date().toISOString(),
    source: 'file',
  };
  const directory = portReservationDir(root);
  mkdirSync(directory, { recursive: true });
  writeFileSync(portReservationFile(record.port, root), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

/** Removes a reservation this owner wrote; another owner's reservation is left alone. */
export function releasePort(port: number, owner: string, root: string = process.cwd()): boolean {
  const file = portReservationFile(port, root);
  const existing = readReservationFile(file);
  if (!existing) {
    return false;
  }
  if (existing.owner !== owner) {
    return false;
  }
  rmSync(file, { force: true });
  return true;
}

export function parseReservedPortsEnv(value: string | undefined): number[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[\s,]+/u)
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535);
}

/** Every reservation in force right now: env var plus unexpired files. */
export function readPortReservations(
  options: { env?: Record<string, string | undefined>; root?: string; now?: number; ttlMs?: number } = {},
): PortReservation[] {
  const env = options.env ?? process.env;
  const root = options.root ?? process.cwd();
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const reservations: PortReservation[] = [];

  // Files first: they carry owner, group and timestamp, so a failure message can name who
  // reserved the port. The env var only says "this number is spoken for".
  let entries: string[];
  try {
    entries = readdirSync(portReservationDir(root));
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const record = readReservationFile(path.join(portReservationDir(root), entry));
    if (!record) {
      continue;
    }
    if (now - Date.parse(record.reservedAt) > ttlMs) {
      // A crashed run must not block a port forever; expiry is the whole reason for the stamp.
      continue;
    }
    reservations.push({ ...record, source: 'file' });
  }

  for (const port of parseReservedPortsEnv(env[RESERVED_PORTS_ENV])) {
    if (reservations.some((reservation) => reservation.port === port)) {
      continue;
    }
    reservations.push({
      port,
      owner: `${RESERVED_PORTS_ENV}`,
      group: 'env',
      reservedAt: new Date(now).toISOString(),
      source: 'env',
    });
  }
  return reservations;
}

/** The set every allocator skips. Cheap enough to call once per allocation. */
export function reservedPorts(options: { env?: Record<string, string | undefined>; root?: string; now?: number } = {}): Set<number> {
  return new Set(readPortReservations(options).map((reservation) => reservation.port));
}

/** The reservation covering a port, when there is one: what a failure message should name. */
export function portReservation(
  port: number,
  options: { env?: Record<string, string | undefined>; root?: string; now?: number } = {},
): PortReservation | undefined {
  return readPortReservations(options).find((reservation) => reservation.port === port);
}

function readReservationFile(file: string): PortReservation | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PortReservation;
    return typeof parsed?.port === 'number' && typeof parsed?.reservedAt === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The slice of `net.Server`/`http.Server` this needs, so both can be passed in. */
export interface ReservingListenable {
  listen(port: number, host: string, callback: () => void): unknown;
  address(): { port: number } | string | null;
  close(callback?: (error?: Error) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * Binds a server to an OS-assigned port that is not reserved.
 *
 * `listen(0)` hands out whatever the kernel likes, reservations included. Fixtures that bind
 * their own server therefore come through here: one retry loop, one rule, and a reserved port is
 * never taken even by accident.
 */
export async function listenOnUnreservedPort(
  server: ReservingListenable,
  host = '127.0.0.1',
  attempts = 8,
): Promise<number> {
  const reserved = reservedPorts();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    if (!reserved.has(port)) {
      return port;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error('the OS only offered reserved ephemeral ports; release a reservation or widen the pool');
}

/** An unreserved OS-assigned port, released again so the caller can bind it itself. */
export async function getUnreservedEphemeralPort(host = '127.0.0.1', attempts = 8): Promise<number> {
  const server = net.createServer();
  try {
    return await listenOnUnreservedPort(server, host, attempts);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
