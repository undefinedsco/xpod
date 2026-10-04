import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle, type SolidAuthSession } from '@undefineds.co/drizzle-solid';
import { sessionResource, threadResource, type SessionRow } from '@undefineds.co/models';
import { acceptLiveTaskApproval } from '../../scripts/helpers/live-task-approval';

const persisted = vi.hoisted(() => ({ sessions: [] as SessionRow[], read: vi.fn() }));
vi.mock('@undefineds.co/drizzle-solid', async () => {
  const actual = await vi.importActual<typeof import('@undefineds.co/drizzle-solid')>('@undefineds.co/drizzle-solid');
  return { ...actual, drizzle: (...args: Parameters<typeof actual.drizzle>) => {
    const db = actual.drizzle(...args);
    return Object.assign(Object.create(db), {
      select: () => ({ from: () => ({ execute: async () => persisted.sessions }) }),
      findByIri: persisted.read,
    });
  } };
});
afterEach(() => { persisted.sessions = []; persisted.read.mockReset(); });

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
      session: { info: { webId: 'https://pod.example/alice/profile/card#me', isLoggedIn: true }, fetch: async () => new Response('', { status: 201 }) } as SolidAuthSession,
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
  it.each(['terminal', 'missing', 'owner', 'fragment', 'foreign', 'other-pod', 'read-owner', 'read-thread', 'read-error'] as const)(
    'independently verifies the producer Session during cleanup (%s)', async variant => {
      const podUrl = 'https://storage.example/alice/';
      const webId = 'https://identity.example/alice/profile/card#me';
      const thread = 'task/work/index.ttl#thread';
      const binding = drizzle({ fetch: async () => new Response(''), info: { webId, isLoggedIn: true } }, { podUrl });
      const absoluteThread = threadResource.buildIriForDatabase(binding, thread);
      const row = { id: '2026/10/04.ttl#session', owner: webId, thread: absoluteThread, status: 'paused' } as SessionRow;
      if (variant === 'owner') row.owner = webId.replace('#me', '#other');
      if (variant === 'fragment') row.thread = absoluteThread.replace('#thread', '#other');
      if (variant === 'foreign') row.thread = absoluteThread.replace('storage.example', 'foreign.example');
      if (variant === 'other-pod') row.thread = absoluteThread.replace('/alice/', '/bob/');
      persisted.sessions = variant === 'missing' ? [] : [row];
      let stopped = false;
      let revoked = false;
      persisted.read.mockImplementation(async (resource, iri) => {
        expect(resource).toBe(sessionResource);
        expect(iri).toBe(sessionResource.buildIriForDatabase(binding, row));
        expect(stopped).toBe(true);
        // A read failure (including a foreign owner/relation) cannot count as terminal proof.
        if (variant === 'read-error') throw new Error('Session transport failed');
        if (variant === 'read-owner' || variant === 'read-thread') {
          if (persisted.read.mock.calls.length > 1) throw new Error('No valid terminal Session');
          return { ...row, status: 'completed', ...(variant === 'read-owner'
            ? { owner: webId.replace('#me', '#other') } : { thread: absoluteThread.replace('#thread', '#other') }) };
        }
        return { ...row, status: 'completed' };
      });
      const ownerFetch: typeof fetch = async (input, init) => {
        const route = new URL(String(input)).pathname;
        const method = init?.method ?? 'GET';
        let value: unknown;
        if (route === '/api/ai/task-credentials' && method === 'POST') value = { credential: { credentialRef: 'grant-one' } };
        else if (route === '/api/tasks' && method === 'POST') value = { task: { id: 'task-one' } };
        else if (route === '/api/tasks/pause') value = { task: { schedule: { paused: true } } };
        // Fail before selecting any Approval: cleanup must discover the Session from the Run itself.
        else if (route === '/api/tasks/run') value = { run: { id: 'run-one', thread, status: 'waiting_input', waitingToolCallId: 'call-one' } };
        else if (route === '/api/tasks/runs') value = { runs: [{ id: 'run-one', thread,
          status: stopped ? 'cancelled' : 'waiting_input', waitingToolCallId: 'call-one' }] };
        else if (route === '/api/tasks/stop') { stopped = true; value = { run: { id: 'run-one', status: 'cancelled' } }; }
        else if (route === '/api/ai/task-credentials/grant-one' && method === 'DELETE') { revoked = true; value = {}; }
        else if (route === '/api/ai/task-credentials' && method === 'GET') value = { data: [] };
        else throw new Error('Unexpected request');
        return Response.json(value);
      };
      const result = await acceptLiveTaskApproval({ gateway: 'https://gateway.example/', podUrl, webId,
        ownerInterfaceKey: 'test-secret-never-in-evidence', ownerFetch,
        session: { info: { webId, isLoggedIn: true }, fetch: async () => new Response('', { status: 201 }) } as SolidAuthSession,
        onEvidence: () => undefined });
      expect(result.ok).toBe(false);
      expect(result.failure).toContain('Manual Run did not acknowledge queued');
      expect(stopped).toBe(true);
      expect(revoked).toBe(true);
      expect(result.cleanup).toMatchObject({ ok: variant === 'terminal', grantRevoked: true,
        runsStopped: 1, sessionsTerminal: variant === 'terminal' ? 1 : 0 });
      expect(persisted.read).toHaveBeenCalledTimes(variant === 'terminal' || variant === 'read-error' ? 1
        : variant === 'read-owner' || variant === 'read-thread' ? 2 : 0);
    });

});
