import { describe, it, expect } from 'vitest';
import { Supervisor } from '../../src/supervisor/Supervisor';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  label: string,
  // Child processes are real `bun` starts: under a full-suite run (many workers) a single
  // start can take seconds, so the budget must not be tight enough to time out on load.
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Child that fails immediately with output on stderr. */
const failFast = (message: string): string => `console.error(${JSON.stringify(message)}); process.exit(1);`;

describe('Supervisor lifecycle (N20)', () => {
  it('gives up after the retry budget is exhausted and reports the reason', async () => {
    const supervisor = new Supervisor({
      handleProcessSignals: false,
      maxRestarts: 2,
      restartBaseDelayMs: 10,
    });
    supervisor.register({
      name: 'api',
      command: process.execPath,
      args: ['-e', failFast('boom: child failed')],
    });

    supervisor.start('api');

    await waitFor(() => supervisor.getStatus('api')?.status === 'given-up', 'api to give up');

    const state = supervisor.getStatus('api')!;
    expect(state.status).toBe('given-up');
    expect(state.givenUpReason).toContain('max restarts');
    expect(state.restartCount).toBe(2);
    expect(state.consecutiveFailures).toBe(3);
    expect(state.lastExitCode).toBe(1);
    expect(typeof state.lastExitAt).toBe('number');
    expect(state.lastOutput?.join('\n')).toContain('boom: child failed');

    // Once given up, nothing may silently restart the child again.
    await sleep(200);
    expect(supervisor.getStatus('api')?.status).toBe('given-up');
    expect(supervisor.getStatus('api')?.restartCount).toBe(2);
  });

  it('does not retry a child whose own runtime cannot resolve a module', async () => {
    const supervisor = new Supervisor({
      handleProcessSignals: false,
      maxRestarts: 5,
      restartBaseDelayMs: 10,
    });
    supervisor.register({
      name: 'api',
      command: process.execPath,
      args: [
        '-e',
        failFast("error: Cannot find package 'global-logger-factory' from '/srv/src/api/main.ts'"),
      ],
    });

    supervisor.start('api');
    await waitFor(() => supervisor.getStatus('api')?.status === 'given-up', 'api to give up');

    const state = supervisor.getStatus('api')!;
    expect(state.givenUpReason).toContain('missing dependency');
    expect(state.restartCount).toBe(0);
    expect(state.consecutiveFailures).toBe(1);

    await sleep(200);
    expect(supervisor.getStatus('api')?.restartCount).toBe(0);
  });

  it('clears the failure streak after a run that stayed up long enough', async () => {
    const supervisor = new Supervisor({
      handleProcessSignals: false,
      maxRestarts: 2,
      restartBaseDelayMs: 10,
      healthyUptimeMs: 100,
    });
    supervisor.register({
      name: 'api',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => { console.error("late crash"); process.exit(1); }, 250);'],
    });

    supervisor.start('api');

    // Four restarts already exceed the budget of two, so the streak must be resetting.
    await waitFor(() => (supervisor.getStatus('api')?.restartCount ?? 0) >= 4, 'four restarts');

    const state = supervisor.getStatus('api')!;
    expect(state.status).not.toBe('given-up');
    expect(state.consecutiveFailures).toBe(0);

    await supervisor.stop('api');
  });

  it('cancels a scheduled restart when the service is stopped', async () => {
    const supervisor = new Supervisor({
      handleProcessSignals: false,
      maxRestarts: 5,
      restartBaseDelayMs: 300,
    });
    supervisor.register({
      name: 'api',
      command: process.execPath,
      args: ['-e', failFast('boom')],
    });

    supervisor.start('api');
    await waitFor(() => (supervisor.getStatus('api')?.restartCount ?? 0) === 1, 'restart to be scheduled');

    await supervisor.stop('api');
    expect(supervisor.getStatus('api')?.status).toBe('stopped');

    // Wait past the backoff window: the cancelled timer must not resurrect the child.
    await sleep(700);
    const state = supervisor.getStatus('api')!;
    expect(state.status).toBe('stopped');
    expect(state.restartCount).toBe(1);
    expect(state.pid).toBeUndefined();
  });

  it('redacts credentials from the retained output tail', async () => {
    const supervisor = new Supervisor({
      handleProcessSignals: false,
      maxRestarts: 0,
      restartBaseDelayMs: 10,
    });
    supervisor.register({
      name: 'api',
      command: process.execPath,
      args: ['-e', failFast('XPOD_NODE_TOKEN=supersecret-token-value')],
    });

    supervisor.start('api');
    await waitFor(() => supervisor.getStatus('api')?.status === 'given-up', 'api to give up');

    const tail = supervisor.getStatus('api')?.lastOutput?.join('\n') ?? '';
    expect(tail).toContain('XPOD_NODE_TOKEN=***');
    expect(tail).not.toContain('supersecret-token-value');
  });

  it('reports readiness from supervised state, not reachability', async () => {
    const supervisor = new Supervisor({ handleProcessSignals: false });
    expect(supervisor.isReady()).toBe(true);

    supervisor.register({
      name: 'css',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000);'],
    });
    expect(supervisor.isReady()).toBe(false);

    supervisor.start('css');
    await waitFor(() => supervisor.getStatus('css')?.status === 'running', 'css to run');
    expect(supervisor.isReady()).toBe(true);

    await supervisor.stop('css');
    await waitFor(() => supervisor.getStatus('css')?.status === 'stopped', 'css to stop');
    expect(supervisor.isReady()).toBe(false);
  });
});
