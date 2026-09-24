import { execFileSync } from 'node:child_process';

/**
 * Who holds a port.
 *
 * A tunnel console forwards to a number, not to a process: if something else already listens
 * there, binding "somewhere else" would make the tunnel reach that other process, and killing
 * it is not this runtime's decision to make. So the only thing this module does is *name* the
 * occupant (pid, command line, cwd, start time) so a refused start points at a culprit instead
 * of at a number. Nothing here ever signals a process.
 */

export interface IngressPortOccupant {
  pid: number;
  /** Full command line when it could be read. */
  command: string;
  cwd?: string;
  startedAt?: string;
}

export interface IngressPortOccupants {
  port: number;
  occupants: IngressPortOccupant[];
  /**
   * One line naming every occupant, for an error message. When nothing can be identified it
   * says so explicitly: "taken by something we cannot name" is a different fact from "free".
   */
  description: string;
}

export interface IdentifyOccupantsDeps {
  /** Runs a command and returns stdout. Injected in tests. */
  exec?: (file: string, args: readonly string[]) => string;
}

/**
 * Names every process listening on the port.
 *
 * `lsof` is the portable answer on macOS and most Linux images; `ss` covers Linux hosts
 * without lsof. When neither is available the answer is "an unidentified listener", never a
 * silent success.
 */
export function identifyIngressPortOccupants(
  port: number,
  deps: IdentifyOccupantsDeps = {},
): IngressPortOccupants {
  const exec = deps.exec ?? defaultExec;
  const pids = new Set<number>();
  let probeFailure: string | undefined;

  try {
    for (const pid of parseLsofPids(exec('lsof', [ '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp' ]))) {
      pids.add(pid);
    }
  } catch (error) {
    probeFailure = `lsof: ${(error as Error).message}`;
  }

  if (pids.size === 0) {
    try {
      for (const pid of parseSsPids(exec('ss', [ '-ltnpH', `sport = :${port}` ]))) {
        pids.add(pid);
      }
    } catch (error) {
      probeFailure = probeFailure
        ? `${probeFailure}; ss: ${(error as Error).message}`
        : `ss: ${(error as Error).message}`;
    }
  }

  const occupants = [ ...pids ].map((pid) => describeProcess(pid, exec));
  return {
    port,
    occupants,
    description: describeOccupants(port, occupants, probeFailure),
  };
}

/** One line for an operator: pid, command, cwd and start time of everything on the port. */
export function describeOccupants(
  port: number,
  occupants: readonly IngressPortOccupant[],
  probeFailure?: string,
): string {
  if (occupants.length === 0) {
    return probeFailure
      ? `port ${port} is not bindable and no process could be named (${probeFailure})`
      : `port ${port} is not bindable and no listener reports it (a transient bind conflict)`;
  }
  return occupants.map((occupant) => {
    const parts = [
      `pid ${occupant.pid}`,
      occupant.command || 'command unknown',
      occupant.cwd ? `cwd ${occupant.cwd}` : undefined,
      occupant.startedAt ? `started ${occupant.startedAt}` : undefined,
    ].filter(Boolean);
    return parts.join(' · ');
  }).join('; ');
}

function defaultExec(file: string, args: readonly string[]): string {
  return execFileSync(file, [ ...args ], { encoding: 'utf8', timeout: 15_000 });
}

function parseLsofPids(output: string): number[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('p'))
    .map((line) => Number.parseInt(line.slice(1), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function parseSsPids(output: string): number[] {
  const pids = new Set<number>();
  for (const match of output.matchAll(/pid=(\d+)/gu)) {
    const pid = Number.parseInt(match[1], 10);
    if (Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return [ ...pids ];
}

function describeProcess(
  pid: number,
  exec: (file: string, args: readonly string[]) => string,
): IngressPortOccupant {
  let command = '';
  let startedAt: string | undefined;
  try {
    const line = exec('ps', [ '-o', 'lstart=,command=', '-p', String(pid) ]).trim();
    // `lstart` is a fixed 24-character timestamp ("Mon Sep 22 17:28:46 2026"), so the command
    // starts right after it; anything shorter is a bare command line.
    const stamp = /^[A-Z][a-z]{2} [A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}\s+/u.exec(line);
    if (stamp) {
      startedAt = stamp[0].trim();
      command = line.slice(stamp[0].length).trim();
    } else {
      command = line;
    }
  } catch {
    // The process may have exited between the port probe and this call.
  }

  let cwd: string | undefined;
  try {
    const line = exec('lsof', [ '-a', '-p', String(pid), '-d', 'cwd', '-Fn' ]).trim();
    cwd = line.split('\n').find((entry) => entry.startsWith('n'))?.slice(1).trim() || undefined;
  } catch {
    // cwd is optional evidence.
  }

  return { pid, command, ...(cwd ? { cwd } : {}), ...(startedAt ? { startedAt } : {}) };
}
