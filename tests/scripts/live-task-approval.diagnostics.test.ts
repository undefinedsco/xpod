import { describe, expect, it, vi } from 'vitest';
import type { SolidAuthSession } from '@undefineds.co/drizzle-solid';
import { acceptLiveTaskApproval } from '../../scripts/helpers/live-task-approval';

vi.mock('@undefineds.co/drizzle-solid', () => ({ drizzle: () => ({
  select: () => ({ from: () => ({ execute: async () => [] }) }),
}) }));

describe('live Task failure diagnostics before cleanup (unit orchestration only)', () => {
  it.each([
    ['Pi assistant ended with error', 'pi_assistant_error'],
    ['Pi assistant ended with aborted', 'pi_assistant_aborted'],
    ['secret-key: upstream private response', 'other_error'],
    ['Pi assistant ended with error secret-key', 'other_error'],
    [undefined, 'none'],
  ])('projects terminal error safely: %s', async (error, errorClassification) => {
    let revoked = false;
    let granted = false;
    let pauses = 0;
    const snapshots: Array<{ value: unknown; pauses: number; revoked: boolean }> = [];
    const requests: string[] = [];
    const ownerFetch: typeof fetch = async (input, init) => {
      const route = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${route}`);
      let value: unknown;
      if (route === '/api/ai/task-credentials' && method === 'POST') {
        granted = true; value = { credential: { credentialRef: 'grant-one' } };
      } else if (route === '/api/ai/task-credentials' && method === 'GET') {
        value = { data: granted ? [{ credentialRef: 'grant-one', status: revoked ? 'revoked' : 'active' }] : [] };
      } else if (route === '/api/ai/task-credentials/grant-one') {
        revoked = true; value = {};
      } else if (route === '/api/tasks') value = { task: { id: 'task-one' } };
      else if (route === '/api/tasks/pause') { pauses += 1; value = { task: { schedule: { paused: true } } }; }
      else if (route === '/api/tasks/run') value = { run: { id: 'run-one', thread: 'thread-one', status: 'queued' } };
      else if (route === '/api/tasks/runs') value = { runs: [{ id: 'run-one', thread: 'thread-one', status: 'failed', error }] };
      else if (route === '/api/tasks/steps') value = { steps: [
        { type: 'run.started', message: 'secret-key' },
        { type: 'runtime.error', message: 'private response' },
        { type: 'runtime.text_delta', message: 'secret-key' },
        { type: 'runtime.text_delta', message: 'private response' },
        { type: 'runtime.tool_call', message: 'request_approval' },
        { type: 'runtime.tool_call', message: 'secret-key' },
        { type: 'secret-key', message: 'private response' },
      ] };
      else throw new Error('Unexpected request');
      return Response.json(value);
    };
    const result = await acceptLiveTaskApproval({
      gateway: 'https://gateway.example/', podUrl: 'https://pod.example/alice/', webId: 'https://pod.example/alice/profile/card#me',
      ownerInterfaceKey: 'secret-key', ownerFetch,
      session: { info: { isLoggedIn: true }, fetch: async () => new Response('', { status: 201 }) } as SolidAuthSession,
      onEvidence: value => { snapshots.push({ value: structuredClone(value), pauses, revoked }); },
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toContain('Producer ended failed before requesting approval');
    expect(result.cases[0]).toMatchObject({ acceptancePhase: 'approved:checkpoint', terminalSnapshot: {
      status: 'failed', errorPresent: error !== undefined, errorClassification, modelRequest: 'unobserved',
      steps: { available: true, counts: { 'run.started': 1, 'runtime.error': 1, 'runtime.text_delta': 2, 'runtime.tool_call': 2 }, approvalTool: true },
    } });
    expect(snapshots[0]).toMatchObject({ pauses: 1, revoked: false, value: { cases: [{ terminalSnapshot: { status: 'failed' } }] } });
    expect(result.cleanup).toMatchObject({ ok: true, tasksPaused: 1, runsStopped: 0, grantRevoked: true });
    expect(requests.filter(value => value === 'GET /api/tasks/steps')).toHaveLength(1);
    expect(requests.indexOf('GET /api/tasks/steps')).toBeLessThan(requests.lastIndexOf('POST /api/tasks/pause'));
    expect(JSON.stringify(snapshots)).not.toContain('secret-key');
    expect(JSON.stringify(result)).not.toContain('private response');
  });

  it('preserves failure evidence and grant cleanup if diagnostic steps cannot be read', async () => {
    let granted = false;
    let revoked = false;
    const ownerFetch: typeof fetch = async (input, init) => {
      const route = new URL(String(input)).pathname;
      if (route === '/api/ai/task-credentials' && init?.method === 'POST') { granted = true; return Response.json({ credential: { credentialRef: 'grant' } }); }
      if (route === '/api/ai/task-credentials') return Response.json({ data: granted ? [{ credentialRef: 'grant', status: revoked ? 'revoked' : 'active' }] : [] });
      if (route === '/api/ai/task-credentials/grant') { revoked = true; return Response.json({}); }
      if (route === '/api/tasks') return Response.json({ task: { id: 'task' } });
      if (route === '/api/tasks/pause') return Response.json({ task: { schedule: { paused: true } } });
      if (route === '/api/tasks/run') return Response.json({ run: { id: 'run', thread: 'thread', status: 'queued' } });
      if (route === '/api/tasks/runs') return Response.json({ runs: [{ id: 'run', thread: 'thread', status: 'failed', error: 'Pi assistant ended with error' }] });
      if (route === '/api/tasks/steps') throw new Error('secret-key private response');
      throw new Error('Unexpected request');
    };
    const result = await acceptLiveTaskApproval({ gateway: 'https://gateway.example/', podUrl: 'https://pod.example/', webId: 'https://pod.example/me',
      ownerInterfaceKey: 'secret-key', ownerFetch, session: { info: { isLoggedIn: true }, fetch: async () => new Response('', { status: 201 }) } as SolidAuthSession,
      onEvidence: () => undefined,
    });
    expect(result.cases[0]).toMatchObject({ terminalSnapshot: { errorClassification: 'pi_assistant_error', steps: { available: false } } });
    expect(result.failure).toContain('Producer ended failed before requesting approval');
    expect(result.cleanup.ok).toBe(true);
    expect(revoked).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });
});
