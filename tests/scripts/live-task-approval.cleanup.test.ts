import { describe, expect, it, vi } from 'vitest';
import type { SolidAuthSession } from '@undefineds.co/drizzle-solid';
import { acceptLiveTaskApproval } from '../../scripts/helpers/live-task-approval';

const approvalRead = vi.hoisted(() => vi.fn(async () => []));

vi.mock('@undefineds.co/drizzle-solid', () => ({ drizzle: () => ({
  select: () => ({ from: () => ({ execute: approvalRead }) }),
}) }));

// Only cleanup orchestration is simulated here; live evidence comes exclusively from the RC Gateway.
describe('live Task acceptance bounded cleanup', () => {
  it.each([{ pauseFailure: false, producerFailed: false, approvalFailure: false },
    { pauseFailure: true, producerFailed: false, approvalFailure: false },
    { pauseFailure: true, producerFailed: true, approvalFailure: false },
    { pauseFailure: false, producerFailed: true, approvalFailure: false },
    { pauseFailure: false, producerFailed: true, approvalFailure: true }])('keeps primary evidence with cleanup scenario %o', async ({ pauseFailure, producerFailed, approvalFailure }) => {
    let cleanupStarted = false;
    const approvalReadPhases: string[] = [];
    approvalRead.mockReset().mockImplementation(async () => {
      approvalReadPhases.push(cleanupStarted ? 'cleanup' : 'checkpoint');
      if (!cleanupStarted) throw new Error('private checkpoint approval failure');
      if (approvalFailure) throw new Error('secondary private approval read failure');
      return [];
    });
    let paused = 0;
    let cancelled = false;
    let revoked = false;
    let granted = false;
    const methods: string[] = [];
    const ownerFetch: typeof fetch = async (input, init) => {
      const route = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      methods.push(`${method} ${route}`);
      let value: unknown;
      if (route === '/api/ai/task-credentials' && method === 'POST') { granted = true; value = { credential: { credentialRef: 'grant-one' } }; }
      else if (route === '/api/tasks' && method === 'POST') value = { task: { id: 'task-one' } };
      else if (route === '/api/tasks/pause') {
        paused += 1;
        if (paused > 1) cleanupStarted = true;
        if (pauseFailure && paused > 1) return new Response('{}', { status: 503 });
        value = { task: { schedule: { paused: true } } };
      } else if (route === '/api/tasks/run') {
        // Invalid ACK must fail the gate, but the producer still needs stopping.
        value = { run: { id: 'run-one', thread: 'thread-one', status: producerFailed ? 'queued' : 'running' } };
      } else if (route === '/api/tasks/runs') value = { runs: [{ id: 'run-one', thread: 'thread-one', status: producerFailed ? 'failed' : cancelled ? 'cancelled' : 'queued',
        failureDiagnostic: { code: producerFailed && !pauseFailure && !approvalFailure ? 'unknown-private-secret' : 'TASK_RUNTIME_ERROR', stage: 'start_backend', status: 'failed', body: 'private-secret' } }] };
      else if (route === '/api/tasks/stop') { cancelled = true; value = { run: { id: 'run-one', status: 'cancelled' } }; }
      else if (route === '/api/ai/task-credentials/grant-one' && method === 'DELETE') { revoked = true; value = { revoked: 'grant-one' }; }
      else if (route === '/api/ai/task-credentials' && method === 'GET') value = { data: granted ? [{ credentialRef: 'grant-one', status: revoked ? 'revoked' : 'active' }] : [] };
      else throw new Error('Unexpected request');
      return Response.json(value);
    };
    const result = await acceptLiveTaskApproval({
      gateway: 'https://gateway.example/', podUrl: 'https://pod.example/alice/', webId: 'https://pod.example/alice/profile/card#me',
      ownerInterfaceKey: 'test-secret-never-in-evidence', ownerFetch,
      session: { info: { isLoggedIn: true }, fetch: async () => new Response('', { status: 201 }) } as SolidAuthSession,
      onEvidence: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(approvalReadPhases).toEqual(['cleanup']);
    expect(approvalRead).toHaveBeenCalledTimes(1);
    expect(result.failure).not.toContain('secondary private');
    expect(result.failure).toContain(producerFailed ? 'Producer ended failed' : 'Manual Run did not acknowledge queued');
    if (producerFailed) expect(result.cases[0].failureDiagnostic).toEqual(pauseFailure || approvalFailure
      ? { code: 'TASK_RUNTIME_ERROR', stage: 'start_backend', status: 'failed' }
      : { code: 'TASK_DIAGNOSTIC_UNAVAILABLE', stage: 'unknown', status: 'failed' });
    expect(cancelled).toBe(!producerFailed);
    expect(result.cleanup.runsStopped).toBe(producerFailed ? 0 : 1);
    expect(result.cleanup.ok).toBe(!pauseFailure && !approvalFailure);
    expect(revoked).toBe(true);
    if (!producerFailed) expect(methods.indexOf('POST /api/tasks/stop')).toBeGreaterThan(methods.indexOf('POST /api/tasks/run'));
    expect(JSON.stringify(result)).not.toContain('private-secret');
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });
});
