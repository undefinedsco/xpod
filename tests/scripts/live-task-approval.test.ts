import { projectTaskRunFailureDiagnostic } from '../../src/api/tasks/TaskRunFailureDiagnostic';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { approvalResource, threadResource, type ApprovalRow } from '@undefineds.co/models';
import { pollLiveTask, requireLiveCheckpoint, requireLiveTerminal, type LiveTaskRun, type LiveTaskCaseEvidence } from '../../scripts/helpers/live-task-approval';

const owner = 'https://pod.example/alice/profile/card#me';
const target = 'https://pod.example/alice/acceptance/marker.txt';
const run: LiveTaskRun = { id: 'task/test/2026/10/02/runs.ttl#run', thread: 'https://pod.example/alice/thread#one',
  status: 'waiting_input', waitingToolCallId: 'call-one' };
const approval = { id: '2026/10/02/approvals.ttl#one', target, thread: run.thread, toolCallId: 'call-one',
  toolName: 'request_approval', assignedTo: owner, status: 'pending' } as ApprovalRow;

afterEach(() => { vi.useRealTimers(); });

describe('live Task acceptance evidence gates (unit checks, not live proof)', () => {
  it('matches an opaque API Thread to the absolute relation from a real ORM read', async () => {
    const pod = 'https://storage.example/alice/';
    const webId = 'https://id.example/alice/profile/card#me';
    const threadId = 'task/work/index.ttl#thread';
    let body = '';
    const db = drizzle({ fetch: async () => new Response(body, { headers: { 'content-type': 'text/turtle' } }),
      info: { webId, isLoggedIn: true } }, { podUrl: pod });
    const iri = approvalResource.buildIriForDatabase(db, '2026/10/04.ttl#approval');
    const threadIri = threadResource.buildIriForDatabase(db, threadId);
    const marker = `${pod}acceptance/marker.txt`;
    const terms: Record<string, string> = { thread: `<${threadIri}>`, target: `<${marker}>`,
      assignedTo: `<${webId}>`, toolCallId: '"call-one"', toolName: '"request_approval"', status: '"pending"' };
    body = `<${iri}> a <${approvalResource.config.type}>.\n`;
    for (const [key, value] of Object.entries(terms)) {
      const predicate = approvalResource.columns[key as keyof typeof approvalResource.columns].options.predicate!;
      body += `<${iri}> <${predicate}> ${value}.\n`;
    }
    const persisted = await db.findByIri(approvalResource, iri);
    expect(persisted?.thread).toBe(threadIri);
    const apiRun = { ...run, thread: threadId };
    expect(requireLiveCheckpoint(apiRun, [persisted!], marker, webId, undefined, db)).toBe(persisted);
    for (const changed of [
      { thread: threadIri.replace('#thread', '#other') },
      { thread: threadIri.replace('storage.example/alice/', 'foreign.example/alice/') },
      { thread: threadIri.replace('/alice/', '/bob/') },
      { assignedTo: webId.replace('#me', '#other') },
      { assignedTo: webId.replace('#me', '') },
      { target: `${marker}-other` }, { toolCallId: 'other' },
      { toolName: 'write' }, { status: 'approved' },
    ]) {
      expect(requireLiveCheckpoint(apiRun, [{ ...persisted, ...changed } as ApprovalRow], marker, webId, undefined, db)).toBeUndefined();
    }
    expect(requireLiveCheckpoint(apiRun, [persisted!], marker, webId)).toBeUndefined();
  });

  it('requires the actual pending tool checkpoint and owner', () => {
    expect(requireLiveCheckpoint(run, [approval], target, owner)).toBe(approval);
    for (const changed of [ { target: `${target}-other` }, { thread: `${run.thread}-other` },
      { toolCallId: 'other' }, { toolName: 'write' }, { assignedTo: 'https://other.example/me' }, { status: 'approved' } ]) {
      expect(requireLiveCheckpoint(run, [{ ...approval, ...changed } as ApprovalRow], target, owner)).toBeUndefined();
    }
    expect(requireLiveCheckpoint({ ...run, status: 'running' }, [approval], target, owner)).toBeUndefined();
  });
  it.each(['completed', 'failed', 'cancelled'])('does not count early %s as an approval', status => {
    expect(() => requireLiveCheckpoint({ ...run, status }, [approval], target, owner)).toThrow('before requesting approval');
  });
  it('keeps failed producers blocking while projecting only safe diagnostics', () => {
    const secret = 'SYNTHETIC_CREDENTIAL_MARKER';
    const error = `service_access_missing HTTP 403 Bearer ${secret} Cookie=${secret} JWT=eyJ${secret}.payload.signature\nstack: https://user:${secret}@example.test/path?token=${secret} body=${secret}`;
    const evidence: LiveTaskCaseEvidence = { kind: 'approved', ok: false };
    expect(() => requireLiveCheckpoint({ ...run, status: 'failed', error }, [], target, owner, evidence))
      .toThrow('Producer ended failed before requesting approval (class=service_access_missing, http=403)');
    expect(evidence.producerFailure).toEqual({ status: 'failed', errorPresent: true, errorLength: error.length,
      errorClass: 'service_access_missing', httpStatus: 403 });
    expect(JSON.stringify(evidence)).not.toContain(secret);
    expect(JSON.stringify(evidence)).not.toMatch(/Bearer|Cookie|https:|stack|body/);
  });
  it.each<[unknown, string, boolean, number]>([
    [undefined, 'none', false, 0], ['', 'none', false, 0],
    [{ errorClass: 'provider_error', httpStatus: 403, message: 'SECRET' }, 'unknown', true, 0],
    ['SECRET HTTP 401 then status 403', 'unknown', true, 'SECRET HTTP 401 then status 403'.length],
    ...([
      ['Pi assistant ended with error', 'provider_error'],
      ['Pi assistant ended with aborted', 'provider_aborted'],
      ['Error: token_exchange_failed', 'token_exchange_failed'],
      ['auth_required', 'auth_required'],
      ['Cloud Agent Runtime requires an OS sandbox, but none is available on this host', 'sandbox_unavailable'],
      ['Cloud Agent Runtime refused to run without a sandbox', 'sandbox_unavailable'],
      ['Agent Runtime worker failed to start: SECRET', 'worker_start_failed'],
      ['Agent Runtime worker exited with code 1 SECRET', 'worker_exited'],
      ['Unable to read execution state: SECRET', 'execution_state_error'],
    ] as const).map(([text, classification]) => [text, classification, true, text.length] as [unknown, string, boolean, number]),
  ])('projects terminal failures without accepting arbitrary error objects (%s)', (error, errorClass, errorPresent, errorLength) => {
    const evidence: LiveTaskCaseEvidence = { kind: 'approved', ok: false };
    expect(() => requireLiveTerminal({ ...run, status: 'failed', error }, run.id, 'completed', evidence))
      .toThrow('expected completed');
    expect(evidence.producerFailure).toEqual({ status: 'failed', errorClass, errorPresent, errorLength });
    expect(JSON.stringify(evidence)).not.toContain('SECRET');
  });
  it('copies the runner\'s allowlisted provider classification without any upstream text', () => {
    const secret = 'SYNTHETIC_CREDENTIAL_MARKER';
    const error = `Pi assistant ended with error (class=auth, api=openai-completions, provider=xpod, model=deepseek-v4-pro) body=${secret} key=sk-${secret}`;
    const evidence: LiveTaskCaseEvidence = { kind: 'approved', ok: false };
    expect(() => requireLiveTerminal({ ...run, status: 'failed', error }, run.id, 'completed', evidence))
      .toThrow('expected completed');
    expect(evidence.producerFailure).toMatchObject({
      status: 'failed', errorClass: 'provider_error',
      providerClass: 'auth', providerApi: 'openai-completions', providerName: 'xpod', providerModel: 'deepseek-v4-pro',
    });
    expect(JSON.stringify(evidence)).not.toContain(secret);
  });
  it('rejects ambiguous duplicate approvals', () => {
    expect(() => requireLiveCheckpoint(run, [approval, { ...approval, id: 'other' }], target, owner)).toThrow('Multiple approvals');
  });
  it('requires the same Run and the correct terminal result', () => {
    expect(requireLiveTerminal(run, run.id, 'completed')).toBe(false);
    expect(requireLiveTerminal({ ...run, status: 'completed' }, run.id, 'completed')).toBe(true);
    expect(() => requireLiveTerminal({ ...run, status: 'cancelled' }, run.id, 'completed')).toThrow('expected completed');
    expect(() => requireLiveTerminal({ ...run, id: 'other', status: 'completed' }, run.id, 'completed')).toThrow('different Run');
  });
  it('polls persisted state without converting a transient state into success', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce('queued').mockResolvedValueOnce('running').mockResolvedValue('waiting_input');
    const result = pollLiveTask(read, value => value === 'waiting_input', 'checkpoint', 100, 10);
    await vi.advanceTimersByTimeAsync(20);
    await expect(result).resolves.toBe('waiting_input');
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('fails within its polling deadline', async () => {
    vi.useFakeTimers();
    const result = pollLiveTask(async () => 'running', value => value === 'completed', 'terminal Run', 20, 10);
    const assertion = expect(result).rejects.toThrow('Timed out waiting for terminal Run');
    await vi.advanceTimersByTimeAsync(30);
    await assertion;
  });
  it('preserves transport and malformed-evidence failures', async () => {
    await expect(pollLiveTask(async () => { throw new Error('HTTP 403'); }, () => true, 'checkpoint')).rejects.toThrow('HTTP 403');
    await expect(pollLiveTask(async () => ({ ...run, status: 'failed' }), value =>
      requireLiveTerminal(value, run.id, 'completed'), 'terminal')).rejects.toThrow('expected completed');
  });
});

describe('Task failure diagnostic safe projection', () => {
  const diagnostic = { code: 'TASK_RUNTIME_ERROR', stage: 'start_backend', status: 'failed' };
  it('preserves only fixed failed-state fields', () => {
    expect(projectTaskRunFailureDiagnostic({ ...diagnostic, message: 'Bearer secret https://private.example/prompt', owner: 'private' }, 'failed')).toEqual(diagnostic);
  });
  it.each(['running', 'completed', 'cancelled', 'waiting_input', 'waiting_runner'])('omits diagnostics for %s', status => {
    expect(projectTaskRunFailureDiagnostic(diagnostic, status)).toBeUndefined();
  });
  it('rejects unknown enums and malformed fields without parsing arbitrary text', () => {
    for (const bad of [{ ...diagnostic, code: 'HTTP_401_secret' }, { ...diagnostic, stage: 'https://secret.example' },
      { ...diagnostic, status: 'running' }, null, [], 'Bearer secret']) {
      expect(projectTaskRunFailureDiagnostic(bad, 'failed')).toBeUndefined();
    }
  });
});
