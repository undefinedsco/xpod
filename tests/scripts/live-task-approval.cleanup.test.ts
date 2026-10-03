import { describe, expect, it, vi } from 'vitest';
import type { SolidAuthSession } from '@undefineds.co/drizzle-solid';
import { acceptLiveTaskApproval } from '../../scripts/helpers/live-task-approval';

vi.mock('@undefineds.co/drizzle-solid', () => ({ drizzle: () => ({
  select: () => ({ from: () => ({ execute: async () => [] }) }),
}) }));

// Only cleanup orchestration is simulated here; live evidence comes exclusively from the RC Gateway.
describe('live Task acceptance bounded cleanup', () => {
  it.each([false, true])('stops an acknowledged producer even when pause cleanup fails=%s', async pauseFailure => {
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
        if (pauseFailure && paused > 1) return new Response('{}', { status: 503 });
        value = { task: { schedule: { paused: true } } };
      } else if (route === '/api/tasks/run') {
        // Invalid ACK must fail the gate, but the producer still needs stopping.
        value = { run: { id: 'run-one', thread: 'thread-one', status: 'running' } };
      } else if (route === '/api/tasks/runs') value = { runs: [{ id: 'run-one', thread: 'thread-one', status: cancelled ? 'cancelled' : 'queued' }] };
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
    expect(result.failure).toContain('Manual Run did not acknowledge queued');
    expect(cancelled).toBe(true);
    expect(result.cleanup.runsStopped).toBe(1);
    expect(result.cleanup.ok).toBe(!pauseFailure);
    expect(revoked).toBe(true);
    expect(methods.indexOf('POST /api/tasks/stop')).toBeGreaterThan(methods.indexOf('POST /api/tasks/run'));
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });
});
