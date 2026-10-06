import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approvalResource, sessionResource } from '@undefineds.co/models';
import type { SolidAuthSession } from '@undefineds.co/drizzle-solid';
import { acceptLiveTaskApproval } from '../../scripts/helpers/live-task-approval';

const mocks = vi.hoisted(() => ({ select: vi.fn(), find: vi.fn(), decide: vi.fn() }));
vi.mock('@undefineds.co/drizzle-solid', async () => {
  const actual = await vi.importActual<typeof import('@undefineds.co/drizzle-solid')>('@undefineds.co/drizzle-solid');
  return { ...actual, drizzle: (...drizzleArgs: Parameters<typeof actual.drizzle>) => {
    const db = actual.drizzle(...drizzleArgs);
    return Object.assign(Object.create(db), {
      select: () => ({ from: (table: unknown) => ({ execute: () => mocks.select(table) }) }),
      findByIri: (...findArgs: unknown[]) => mocks.find(...findArgs),
    });
  } };
});
vi.mock('@undefineds.co/models', async importOriginal => ({
  ...await importOriginal<typeof import('@undefineds.co/models')>(),
  decideApprovalRequest: (...args: unknown[]) => mocks.decide(...args),
}));
beforeEach(() => { mocks.select.mockReset().mockResolvedValue([]); mocks.find.mockReset(); mocks.decide.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

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
      session: { info: { isLoggedIn: true, webId: 'https://pod.example/alice/profile/card#me' }, fetch: async () => new Response('', { status: 201 }) } as SolidAuthSession,
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
      ownerInterfaceKey: 'secret-key', ownerFetch, session: { info: { isLoggedIn: true, webId: 'https://pod.example/profile/card#me' }, fetch: async () => new Response('', { status: 201 }) } as SolidAuthSession,
      onEvidence: () => undefined,
    });
    expect(result.cases[0]).toMatchObject({ terminalSnapshot: { errorClassification: 'pi_assistant_error', steps: { available: false } } });
    expect(result.failure).toContain('Producer ended failed before requesting approval');
    expect(result.cleanup.ok).toBe(true);
    expect(revoked).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });
});


describe('live Task safe failure substage (unit orchestration only)', () => {
  const privateText = 'Bearer private-token https://private.example/pod#id model prose tool arguments';
  type Fault = 'none' | 'persisted-read' | 'persisted-assert' | 'resume-request' | 'resume-assert' | 'resume-unknown' | 'resume-unreadable' | 'resume-abort' | 'queued' | 'checkpoint';
  async function fixture(fault: Fault, httpFailure?: { status: number; body: string; unreadable?: boolean }) {
    const owner = 'https://pod.example/alice/profile/card#me';
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    let count = 0;
    let granted = false;
    let revoked = false;
    let injected = false;
    let current = { id: '', run: '', thread: '', target: '', expected: '', decision: '', status: 'waiting_input', resumes: 0 };
    const sessionThreads = new Map<string, string>();
    const requests: Array<{ route: string; signal?: AbortSignal | null }> = [];
    const connectionError = Object.assign(new TypeError(privateText), { cause: { code: 'ECONNREFUSED', message: privateText } });
    mocks.select.mockImplementation(async (table: unknown) => {
      if (fault === 'checkpoint' && !injected) { injected = true; throw new SyntaxError(privateText); }
      if (table === sessionResource) return [{ id: `https://pod.example/session#${count}`, owner, thread: current.thread,
        status: current.status === 'waiting_input' ? 'paused' : 'completed' }];
      return [{ id: '2026/10/04.ttl#request', session: `https://pod.example/session#${count}`, target: current.target,
        thread: current.thread, toolCallId: 'call-one', toolName: 'request_approval', assignedTo: owner,
        status: current.decision || 'pending' }];
    });
    mocks.find.mockImplementation(async (table: unknown, iri?: unknown) => {
      if (table === sessionResource) return { owner, thread: sessionThreads.get(String(iri)) ?? current.thread,
        status: current.status === 'waiting_input' ? 'paused' : 'completed' };
      expect(table).toBe(approvalResource);
      if (fault === 'persisted-read' && !injected) { injected = true; throw new DOMException(privateText, 'TimeoutError'); }
      return { status: fault === 'persisted-assert' ? 'pending' : current.decision, decisionBy: owner, resolvedAt: new Date() };
    });
    mocks.decide.mockImplementation(async (input: { decision: string }) => { current.decision = input.decision; return { status: 'decided' }; });
    const ownerFetch: typeof fetch = async (input, init) => {
      const route = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      requests.push({ route, signal: init?.signal });
      let body: unknown;
      if (route === '/api/ai/task-credentials') {
        if (method === 'POST') { granted = true; body = { credential: { credentialRef: 'grant-one' } }; }
        else body = { data: granted ? [{ credentialRef: 'grant-one', status: revoked ? 'revoked' : 'active' }] : [] };
      } else if (route === '/api/ai/task-credentials/grant-one') { revoked = true; body = {}; }
      else if (route === '/api/tasks') {
        const prompt = JSON.parse(String(init?.body)).prompt as string;
        count += 1;
        const thread = `https://pod.example/alice/.data/task/task-${count}/index.ttl#thread-${count}`;
        sessionThreads.set(`https://pod.example/session#${count}`, thread);
        current = { id: `task-${count}`, run: `run-${count}`, thread,
          target: /target=([^,]+)/.exec(prompt)![1], expected: /write exactly (\S+) followed/.exec(prompt)![1],
          decision: '', status: 'waiting_input', resumes: 0 };
        body = { task: { id: current.id } };
      } else if (route === '/api/tasks/pause') body = { task: { schedule: { paused: true } } };
      else if (route === '/api/tasks/run') {
        if (fault === 'queued' && !injected) { injected = true; throw connectionError; }
        body = { run: { id: current.run, thread: current.thread, status: 'queued' } };
      } else if (route === '/api/tasks/runs') body = { runs: [{ id: current.run, thread: current.thread, status: current.status, waitingToolCallId: 'call-one' }] };
      else if (route === '/api/tasks/resume') {
        if (httpFailure && !injected) { injected = true; const response = new Response(httpFailure.unreadable ? new ReadableStream({ pull(controller) { controller.error(new Error(privateText)); } }) : httpFailure.body, { status: 400 }); Object.defineProperty(response, 'status', { value: httpFailure.status }); return response; }
        if (fault === 'resume-request' && !injected) { injected = true; throw connectionError; }
        if (fault === 'resume-unknown' && !injected) { injected = true; throw Object.assign(new Error(privateText), { name: 'secret-name', code: 'secret-code', cause: { code: 'secret-code' } }); }
        if (fault === 'resume-abort' && !injected) { injected = true; throw new DOMException(privateText, 'AbortError'); }
        if (fault === 'resume-unreadable' && !injected) { injected = true; throw Object.defineProperty(new Error(privateText), 'name', { get() { throw new Error(privateText); } }); }
        const duplicate = current.resumes++ > 0;
        current.status = current.decision === 'approved' ? 'completed' : 'cancelled';
        body = { run: { id: fault === 'resume-assert' ? 'wrong-run' : current.run, status: current.status },
          resumed: !duplicate && current.decision === 'approved', duplicate };
      } else if (route === '/api/tasks/stop') { current.status = 'cancelled'; body = {}; }
      else if (route === '/api/tasks/steps') body = { steps: [] };
      else throw new Error('Unexpected request');
      return Response.json(body);
    };
    const session = { info: { isLoggedIn: true, webId: owner }, fetch: async (_input: unknown, init?: RequestInit) =>
      init?.method === 'PUT' ? new Response('', { status: 201 })
        : current.status === 'completed' ? new Response(`${current.expected}\n`) : new Response('', { status: 404 }),
    } as unknown as SolidAuthSession;
    const result = await acceptLiveTaskApproval({ gateway: 'https://gateway.example/', podUrl: 'https://pod.example/alice/',
      webId: owner, ownerInterfaceKey: privateText, ownerFetch, session, onEvidence: () => undefined });
    return { result, revoked, requests, timeouts: timeout.mock.calls.map(([milliseconds]) => milliseconds) };
  }
  it.each([
    ['persisted-read', 'decision-persisted-read', 'timeout', 'TimeoutError'],
    ['persisted-assert', 'decision-persisted-assert', 'assertion', 'LiveTaskEvidenceError'],
    ['resume-request', 'decision-resume-request', 'connection', 'TypeError'],
    ['resume-assert', 'decision-resume-assert', 'assertion', 'LiveTaskEvidenceError'],
    ['resume-unknown', 'decision-resume-request', 'other', 'other'],
    ['resume-unreadable', 'decision-resume-request', 'other', 'other'],
    ['resume-abort', 'decision-resume-request', 'other', 'AbortError'],
    ['queued', 'queued-request', 'connection', 'TypeError'],
    ['checkpoint', 'checkpoint-approval-read', 'parse', 'SyntaxError'],
  ] as const)('safely records %s without changing failure or cleanup', async (fault, substage, category, name) => {
    const { result, revoked } = await fixture(fault);
    expect(result.ok).toBe(false);
    expect(result.cases[0]).toMatchObject({ failureDetails: { substage, category, name } });
    expect(revoked).toBe(true);
    expect(result.cleanup.grantRevoked).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateText);
    expect(JSON.stringify(result)).not.toContain('secret-name');
    expect(JSON.stringify(result)).not.toContain('secret-code');
    if (category !== 'assertion') expect(result.failure).toBe(`Task acceptance failed at approved:${fault === 'queued' ? 'queued' : fault === 'checkpoint' ? 'checkpoint' : 'decision'}`);
    if (category === 'connection') expect(result.cases[0]).toMatchObject({ failureDetails: { causeCode: 'ECONNREFUSED' } });
  });
  it.each([
    [400, JSON.stringify({ error: 'Agent execution credential is unavailable' }), 'agent_execution_credential_unavailable'],
    [401, JSON.stringify({ error: 'authentication_required' }), 'authentication_required'],
    [403, JSON.stringify({ error: 'service_access_missing' }), 'service_access_missing'],
    [400, JSON.stringify({ error: privateText }), 'other_error'],
    [400, JSON.stringify({ error: 'Run conditional writes require authenticated Pod access' }), 'run_conditional_auth_required'],
    [400, JSON.stringify({ error: 'Run updates require a strong document ETag' }), 'run_strong_etag_required'],
    [400, JSON.stringify({ error: 'Run updates require a Turtle document' }), 'run_turtle_document_required'],
    [400, JSON.stringify({ error: 'Run has invalid persisted status' }), 'run_persisted_status_invalid'],
    [400, JSON.stringify({ error: 'Run has invalid persisted timestamp' }), 'run_persisted_timestamp_invalid'],
    [400, JSON.stringify({ error: 'Run document changed repeatedly during conditional update' }), 'run_conditional_update_conflict'],
    [400, JSON.stringify({ error: 'Durable client tool continuation claim capability is required' }), 'continuation_claim_required'],
    [400, JSON.stringify({ error: 'Durable client tool continuation release capability is required' }), 'continuation_release_required'],
    [400, JSON.stringify({ error: 'Run workspace reference is required' }), 'run_workspace_required'],
    [400, JSON.stringify({ error: 'Durable approval session storage is unavailable' }), 'approval_session_storage_unavailable'],
    [400, JSON.stringify({ error: 'Run document read failed: HTTP 401' }), 'run_document_read_failed'],
    [400, JSON.stringify({ error: 'Run document update failed: HTTP 599' }), 'run_document_update_failed'],
    [400, JSON.stringify({ error: 'Run document read failed: HTTP 100' }), 'run_document_read_failed'],
    [400, JSON.stringify({ error: 'Run document read failed: HTTP 99' }), 'other_error'],
    [400, JSON.stringify({ error: 'Run document update failed: HTTP 600' }), 'other_error'],
    [400, JSON.stringify({ error: 'Run document read failed: HTTP 400 secret' }), 'other_error'],
    [400, JSON.stringify({ error: 'Run document read failed: HTTP 0400' }), 'other_error'],
    [400, JSON.stringify({ error: 'Run document read failed: HTTP 400.5' }), 'other_error'],
    [400, JSON.stringify({ error: 'Run document read failed: HTTP 400\n' }), 'other_error'],
    [400, '{broken', 'other_error'],
    [400, JSON.stringify({ error: 'Approval has expired', extra: privateText }), 'approval_expired'],
    [400, JSON.stringify({ error: 'Approval has expired' }) + ' '.repeat(5000), 'other_error'],
  ])('records bounded non-OK diagnostics %s safely', async (status, body, taskError) => {
    const { result, revoked } = await fixture('none', { status: status as number, body: body as string });
    expect(result.cases[0]?.failureDetails).toMatchObject({ substage: 'decision-resume-request', category: 'assertion', name: 'LiveTaskEvidenceError', httpStatus: status, taskError });
    expect(result.failure).toContain(`HTTP ${status}`);
    expect(result.cleanup.ok).toBe(true);
    expect(revoked).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateText);
  });
  it.each([
    [JSON.stringify({ error: privateText }), 'error_string'],
    [JSON.stringify({ message: privateText }), 'json_other'],
    [JSON.stringify({ error: { secret: privateText } }), 'json_other'],
    ['private non-JSON ' + privateText, 'non_json'],
    [privateText.repeat(100), 'oversized'],
  ])('classifies only the fixed error envelope', async (body, errorEnvelope) => {
    const { result } = await fixture('none', { status: 400, body });
    expect(result.cases[0]?.failureDetails).toMatchObject({ taskError: 'other_error', errorEnvelope });
    expect(JSON.stringify(result)).not.toContain(privateText);
  });
  it.each([100, 401, 404, 500, 599])('retains only the strict inner Run document status %s', async runDocumentHttpStatus => {
    const { result } = await fixture('none', { status: 400, body: JSON.stringify({ error: `Run document read failed: HTTP ${runDocumentHttpStatus}` }) });
    expect(result.cases[0]?.failureDetails).toMatchObject({ httpStatus: 400, runDocumentHttpStatus, taskError: 'run_document_read_failed' });
  });
  it('omits inner status outside the exact document error grammar', async () => {
    const { result } = await fixture('none', { status: 400, body: JSON.stringify({ error: 'Run document update failed: HTTP 401 secret' }) });
    expect(result.cases[0]?.failureDetails).not.toHaveProperty('runDocumentHttpStatus');
  });
  it('keeps the original HTTP assertion when the error body is unreadable', async () => {
    const { result } = await fixture('none', { status: 400, body: '', unreadable: true });
    expect(result.cases[0]?.failureDetails).toMatchObject({ category: 'assertion', httpStatus: 400, taskError: 'other_error', errorEnvelope: 'unreadable' });
    expect(result.failure).toContain('HTTP 400');
    expect(JSON.stringify(result)).not.toContain(privateText);
    expect(result.cleanup.ok).toBe(true);
  });
  it.each([99, 600, 400.5, NaN])('omits malformed HTTP status %s', async status => {
    const { result } = await fixture('none', { status, body: '{broken' });
    expect(result.cases[0]?.failureDetails).toMatchObject({ taskError: 'other_error', category: 'assertion' });
    expect(result.cases[0]?.failureDetails).not.toHaveProperty('httpStatus');
    expect(result.failure).toContain('HTTP unknown');
    expect(result.cleanup.ok).toBe(true);
  });
  it.each([
    ['route_run_read', 'type_error'],
    ['task_auth_restore', 'error'],
    ['continuation_prepare', 'range_error'],
    ['continuation_complete', 'syntax_error'],
    ['route_request', 'non_error'],
  ])('retains fixed producer resume diagnostics without publishing error text', async (taskResumeStage, taskResumeErrorType) => {
    const { result, revoked } = await fixture('none', { status: 400, body: JSON.stringify({ error: privateText, taskResumeStage, taskResumeErrorType, stack: privateText }) });
    expect(result.cases[0]?.failureDetails).toMatchObject({ httpStatus: 400, taskError: 'other_error', taskResumeStage, taskResumeErrorType });
    expect(result.cleanup.ok).toBe(true);
    expect(revoked).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateText);
  });
  it('retains the bounded producer failure site while rejecting sensitive extra fields', async () => {
    const taskResumeFailure = { name: 'Error', code: 'ECONNRESET', causeCode: 'ECONNREFUSED',
      site: { module: 'api/runs/store', line: 17, column: 4, coordinate: 'source_ts', kind: 'first_project_frame' } };
    const { result } = await fixture('none', { status: 400, body: JSON.stringify({ error: privateText,
      taskResumeFailure, stack: privateText, taskResumeStage: 'continuation_complete', taskResumeErrorType: 'error' }) });
    expect(result.ok).toBe(false);
    expect(result.cases[0]?.failureDetails).toMatchObject({ httpStatus: 400, taskResumeStage: 'continuation_complete', taskResumeFailure });
    expect(JSON.stringify(result)).not.toContain(privateText);
    expect(result.cleanup.ok).toBe(true);
    const invalid = await fixture('none', { status: 400, body: JSON.stringify({ error: privateText,
      taskResumeFailure: { ...taskResumeFailure, message: privateText } }) });
    expect(invalid.result.cases[0]?.failureDetails).not.toHaveProperty('taskResumeFailure');
  });
  it.each([null, [], 'private', { name: 'private' }, { name: 'Error', code: 'private' },
    { name: 'Error', site: { module: '/Users/private/store.ts', line: 1, column: 2, coordinate: 'source_ts', kind: 'first_project_frame' } },
    { name: 'Error', site: { module: 'api/runs/store', line: 0, column: 2, coordinate: 'source_ts', kind: 'first_project_frame' } },
  ])('omits malformed producer failure schema %#', async taskResumeFailure => {
    const { result } = await fixture('none', { status: 400, body: JSON.stringify({ error: privateText, taskResumeFailure }) });
    expect(result.cases[0]?.failureDetails).not.toHaveProperty('taskResumeFailure');
    expect(result.cleanup.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateText);
  });
  it.each([privateText, null, 123, {}, [], 'task_auth_restore\n'])('omits unrecognized resume diagnostic values', async invalid => {
    const { result } = await fixture('none', { status: 400, body: JSON.stringify({ error: privateText, taskResumeStage: invalid, taskResumeErrorType: invalid }) });
    expect(result.cases[0]?.failureDetails).not.toHaveProperty('taskResumeStage');
    expect(result.cases[0]?.failureDetails).not.toHaveProperty('taskResumeErrorType');
    expect(result.cases[0]?.failureDetails).toMatchObject({ httpStatus: 400, taskError: 'other_error' });
    expect(JSON.stringify(result)).not.toContain(privateText);
  });
  it('does not recover diagnostic fields beyond the original error-body cap', async () => {
    const { result } = await fixture('none', { status: 400, body: JSON.stringify({ error: privateText.repeat(100), taskResumeStage: 'task_auth_restore', taskResumeErrorType: 'error' }) });
    expect(result.cases[0]?.failureDetails).toMatchObject({ errorEnvelope: 'oversized' });
    expect(result.cases[0]?.failureDetails).not.toHaveProperty('taskResumeStage');
    expect(result.cases[0]?.failureDetails).not.toHaveProperty('taskResumeErrorType');
    expect(result.cleanup.ok).toBe(true);
  });
  it('leaves all three success cases, cleanup and request signals unchanged', async () => {
    const { result, revoked, requests, timeouts } = await fixture('none');
    expect(result.ok).toBe(true);
    expect(result.cases).toHaveLength(3);
    expect(result.cases.every(row => row.ok && !('failureDetails' in row))).toBe(true);
    expect(result.cleanup).toEqual({ ok: true, tasksPaused: 3, runsStopped: 0, sessionsTerminal: 3, grantRevoked: true });
    expect(revoked).toBe(true);
    expect(requests.every(request => request.signal instanceof AbortSignal)).toBe(true);
    expect(new Set(timeouts)).toEqual(new Set([20_000, 180_000]));
  });
});
