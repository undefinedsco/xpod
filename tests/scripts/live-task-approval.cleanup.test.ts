import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle, type SolidAuthSession } from '@undefineds.co/drizzle-solid';
import { sessionResource, threadResource, type SessionRow } from '@undefineds.co/models';
import { acceptLiveTaskApproval } from '../../scripts/helpers/live-task-approval';

const persisted = vi.hoisted(() => ({ sessions: [] as SessionRow[], read: vi.fn(), select: vi.fn() }));
const approvalRead = persisted.select;
vi.mock('@undefineds.co/drizzle-solid', async () => {
  const actual = await vi.importActual<typeof import('@undefineds.co/drizzle-solid')>('@undefineds.co/drizzle-solid');
  return { ...actual, drizzle: (...args: Parameters<typeof actual.drizzle>) => {
    const db = actual.drizzle(...args);
    return Object.assign(Object.create(db), {
      select: () => ({ from: () => ({ execute: () => persisted.select() }) }),
      findByIri: persisted.read,
    });
  } };
});
afterEach(() => { persisted.sessions = []; persisted.read.mockReset(); persisted.select.mockReset().mockImplementation(async () => persisted.sessions); });

// Only cleanup orchestration is simulated here; live evidence comes exclusively from the RC Gateway.
describe('live Task acceptance bounded cleanup', () => {
  it.each([{ pauseFailure: false, producerFailed: false, approvalFailure: false, producerError: undefined as unknown },
    { pauseFailure: true, producerFailed: false, approvalFailure: false, producerError: undefined as unknown },
    { pauseFailure: true, producerFailed: true, approvalFailure: false, producerError: 'Error: service_access_missing HTTP status 403 private-secret' },
    { pauseFailure: false, producerFailed: true, approvalFailure: false, producerError: 'Pi assistant ended with error (class=rate_limit, api=openai, provider=openai, model=gpt-6.1) HTTP 429 private-secret' },
    { pauseFailure: false, producerFailed: true, approvalFailure: true, producerError: { message: 'private-secret' } }])('keeps primary evidence with cleanup scenario %o', async ({ pauseFailure, producerFailed, approvalFailure, producerError }) => {
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
      } else if (route === '/api/tasks/runs') value = { runs: [{ id: 'run-one', thread: 'thread-one', status: producerFailed ? 'failed' : cancelled ? 'cancelled' : 'queued', error: producerError,
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
      session: { info: { webId: 'https://pod.example/alice/profile/card#me', isLoggedIn: true }, fetch: async () => new Response('', { status: 201 }) } as SolidAuthSession,
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
    if (producerFailed) {
      const failure = result.cases[0].producerFailure;
      expect(failure).toMatchObject({ status: 'failed', errorPresent: true,
        errorLength: typeof producerError === 'string' ? producerError.length : 0,
        errorClass: pauseFailure ? 'service_access_missing' : approvalFailure ? 'unknown' : 'provider_error' });
      if (typeof producerError === 'string') expect(failure?.httpStatus).toBe(pauseFailure ? 403 : 429);
      else expect(failure?.httpStatus).toBeUndefined();
      if (!pauseFailure && !approvalFailure) expect(failure).toMatchObject({ providerClass: 'rate_limit',
        providerApi: 'openai', providerName: 'openai', providerModel: 'gpt-6.1' });
    }
    expect(cancelled).toBe(!producerFailed);
    expect(result.cleanup.runsStopped).toBe(producerFailed ? 0 : 1);
    expect(result.cleanup.ok).toBe(!pauseFailure && !approvalFailure);
    expect(revoked).toBe(true);
    if (!producerFailed) expect(methods.indexOf('POST /api/tasks/stop')).toBeGreaterThan(methods.indexOf('POST /api/tasks/run'));
    expect(JSON.stringify(result)).not.toContain('private-secret');
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
