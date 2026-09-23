export interface ServiceConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  readyUrl?: string;
}

/**
 * `given-up` means the supervisor stopped restarting the child on purpose (unrecoverable
 * failure or exhausted retries). It is distinct from `stopped` (intentional stop) and
 * `crashed` (spawn failed) because a given-up child never returns without operator action.
 */
export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'crashed' | 'given-up';

export interface ServiceState {
  name: string;
  status: ServiceStatus;
  pid?: number;
  startTime?: number;
  uptime?: number;
  lastExitCode?: number;
  /** Epoch millis of the last child exit, so a stale crash can be told apart from a live one. */
  lastExitAt?: number;
  restartCount: number;
  /** Consecutive failed runs; a run that stayed up long enough clears it. */
  consecutiveFailures?: number;
  /** Bounded, redacted tail of the child's own output, for diagnosing a crash without shell access. */
  lastOutput?: string[];
  /** Why the supervisor stopped restarting this service (set while status is `given-up`). */
  givenUpReason?: string;
}

export type StatusChangeHandler = (name: string, state: ServiceState) => void;
