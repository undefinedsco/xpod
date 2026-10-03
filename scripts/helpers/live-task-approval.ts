import type { TaskCredentialSummary } from '../../src/api/tasks/TaskCredentialStore';
import { randomUUID } from 'node:crypto';
import { drizzle, type SolidAuthSession } from '@undefineds.co/drizzle-solid';
import { approvalResource, sessionResource, decideApprovalRequest, type ApprovalRow } from '@undefineds.co/models';

export interface LiveTaskRun {
  id: string;
  thread: string;
  status: string;
  waitingToolCallId?: string;
  error?: unknown;
}
export interface LiveTaskCaseEvidence {
  kind: 'approved' | 'rejected' | 'stopped';
  taskId?: string;
  runId?: string;
  queuedAck?: boolean;
  approvalPending?: boolean;
  sessionPaused?: boolean;
  decision?: string;
  terminalStatus?: string;
  producerFailure?: LiveTaskProducerFailure;
  sessionCompleted?: boolean;
  sameRun?: boolean;
  markerMatches?: boolean;
  markerAbsent?: boolean;
  duplicateResume?: boolean;
  stableAfterDuplicateOrStop?: boolean;
  ok: boolean;
}
export interface LiveTaskProducerFailure {
  status: 'failed' | 'cancelled' | 'completed';
  errorPresent: boolean;
  errorLength: number;
  errorClass: 'none' | 'unknown' | 'auth_required' | 'service_access_missing' | 'token_exchange_failed'
    | 'provider_error' | 'provider_aborted' | 'sandbox_unavailable' | 'worker_start_failed'
    | 'worker_exited' | 'execution_state_error';
  httpStatus?: number;
}

/** Never copy error text: upstream messages may include credentials, bodies or URLs. */
function recordProducerFailure(run: LiveTaskRun, evidence?: LiveTaskCaseEvidence): void {
  if (!evidence || !['failed', 'cancelled', 'completed'].includes(run.status)) return;
  const text = typeof run.error === 'string' ? run.error : '';
  const errorPresent = run.error !== undefined && run.error !== null && run.error !== '';
  const classes: Array<[RegExp, LiveTaskProducerFailure['errorClass']]> = [
    [/\bservice_access_missing\b/u, 'service_access_missing'],
    [/\btoken_exchange_failed\b/u, 'token_exchange_failed'],
    [/\bauth_required\b/u, 'auth_required'],
    [/^(?:Error: )?Pi assistant ended with error(?:$|\s)/u, 'provider_error'],
    [/^(?:Error: )?Pi assistant ended with aborted(?:$|\s)/u, 'provider_aborted'],
    [/^(?:Error: )?Cloud Agent Runtime (?:requires an OS sandbox|refused to run without a sandbox)/u, 'sandbox_unavailable'],
    [/^(?:Error: )?Agent Runtime worker failed to start:/u, 'worker_start_failed'],
    [/^(?:Error: )?Agent Runtime worker exited with code /u, 'worker_exited'],
    [/^(?:Error: )?Unable to read execution state:/u, 'execution_state_error'],
  ];
  const statuses = new Set(Array.from(text.matchAll(/\b(?:HTTP(?: status)?|status(?: code)?)\s*[:=]?\s*([45]\d{2})(?!\d)/giu),
    match => Number(match[1])));
  evidence.producerFailure = {
    status: run.status as LiveTaskProducerFailure['status'], errorPresent,
    errorLength: Math.min(text.length, 1_000_000),
    errorClass: classes.find(([pattern]) => pattern.test(text))?.[1] ?? (errorPresent ? 'unknown' : 'none'),
    ...(statuses.size === 1 ? { httpStatus: [...statuses][0] } : {}),
  };
}

export interface LiveTaskEvidence {
  ok: boolean;
  cases: LiveTaskCaseEvidence[];
  cleanup: { ok: boolean; tasksPaused: number; runsStopped: number; sessionsTerminal: number; grantRevoked: boolean };
  failure?: string;
}

class LiveTaskEvidenceError extends Error {}

const terminal = new Set(['completed', 'cancelled', 'failed']);
function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new LiveTaskEvidenceError(message);
}

/** Poll real persisted state; transport failures and failed producers are not successes. */
export async function pollLiveTask<T>(read: () => Promise<T>, ready: (value: T) => boolean,
  label: string, timeoutMs = 180_000, intervalMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  } while (Date.now() <= deadline);
  throw new LiveTaskEvidenceError(`Timed out waiting for ${label}`);
}

export function requireLiveCheckpoint(run: LiveTaskRun, approvals: ApprovalRow[], target: string,
  owner: string, evidence?: LiveTaskCaseEvidence): ApprovalRow | undefined {
  if (terminal.has(run.status)) {
    recordProducerFailure(run, evidence);
    throw new LiveTaskEvidenceError(`Producer ended ${run.status} before requesting approval`);
  }
  if (run.status !== 'waiting_input') return undefined;
  const matching = approvals.filter(approval => approval.target === target && approval.thread === run.thread
    && approval.toolCallId === run.waitingToolCallId && approval.toolName === 'request_approval'
    && approval.assignedTo === owner && approval.status === 'pending');
  requireEvidence(matching.length <= 1, 'Multiple approvals matched one producer checkpoint');
  return matching[0];
}

export function requireLiveTerminal(run: LiveTaskRun, expectedRunId: string, expectedStatus: string,
  evidence?: LiveTaskCaseEvidence): boolean {
  requireEvidence(run.id === expectedRunId, 'Task resumed into a different Run');
  if (!terminal.has(run.status)) return false;
  if (run.status !== expectedStatus) recordProducerFailure(run, evidence);
  requireEvidence(run.status === expectedStatus, `Task ended ${run.status}; expected ${expectedStatus}`);
  return true;
}

/** Uses the existing acceptance account, authenticated route and actual Gateway. No synthetic checkpoints. */
export async function acceptLiveTaskApproval(options: {
  gateway: string;
  podUrl: string;
  webId: string;
  ownerInterfaceKey: string;
  ownerFetch: typeof fetch;
  session: SolidAuthSession;
  onEvidence: (evidence: LiveTaskEvidence) => void;
}): Promise<LiveTaskEvidence> {
  const evidence: LiveTaskEvidence = {
    ok: false, cases: [], cleanup: { ok: false, tasksPaused: 0, runsStopped: 0, sessionsTerminal: 0, grantRevoked: false },
  };
  const tasks: string[] = [];
  const approvalSessions = new Set<string>();
  let grantId: string | undefined;
  let grantAttempted = false;
  let phase = 'grant';
  // Do not include upstream bodies, model prose, tool arguments or credential material in errors/evidence.
  const request = async <T>(route: string, method = 'GET', body?: unknown, timeout = 20_000): Promise<T> => {
    const response = await options.ownerFetch(new URL(route, options.gateway), {
      method, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeout),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    requireEvidence(response.ok, `Task ${method} ${route.split('?')[0]} HTTP ${response.status}`);
    return response.json() as Promise<T>;
  };
  const podFetch: typeof fetch = (input, init) => options.session.fetch(input, {
    ...init, signal: AbortSignal.timeout(20_000),
  });
  const db = drizzle({ ...options.session, fetch: podFetch }, {
    podUrl: options.podUrl, schema: { approval: approvalResource, session: sessionResource },
    autoConnect: false, resourcePreparation: 'off',
  });
  const runsFor = async (taskId: string) => (await request<{ runs: LiveTaskRun[] }>(
    `/api/tasks/runs?id=${encodeURIComponent(taskId)}`)).runs;
  const pause = async (taskId: string) => {
    const value = await request<{ task: { schedule?: { paused: boolean } } }>(`/api/tasks/pause?id=${encodeURIComponent(taskId)}`, 'POST', { paused: true });
    requireEvidence(value.task.schedule?.paused === true, 'Task schedule did not pause');
  };
  const readRun = async (taskId: string, runId: string) => {
    const runs = await runsFor(taskId);
    requireEvidence(runs.length === 1, 'Expected exactly one manually queued Run per paused Task');
    const run = runs.find(row => row.id === runId);
    requireEvidence(run, 'Original Task Run disappeared');
    return run;
  };
  const sessionStatus = async (iri: string) => (await db.findByIri(sessionResource, iri))?.status;
  const steps = async (runId: string) => (await request<{ steps: Array<{ id: string }> }>(
    `/api/tasks/steps?id=${encodeURIComponent(runId)}`)).steps.map(step => step.id).sort();
  const marker = async (target: string) => {
    const response = await podFetch(target);
    const body = await response.text();
    requireEvidence(response.ok || response.status === 404, `Marker GET HTTP ${response.status}`);
    return { status: response.status, body, etag: response.headers.get('etag') };
  };
  try {
    const existingGrants = await request<{ data: TaskCredentialSummary[] }>('/api/ai/task-credentials');
    requireEvidence(existingGrants.data.length === 0, 'Task acceptance requires a fresh account without task grants');
    grantAttempted = true;
    const grant = await request<{ credential: TaskCredentialSummary }>('/api/ai/task-credentials', 'POST', {
      apiKey: options.ownerInterfaceKey,
    });
    grantId = grant.credential?.credentialRef;
    requireEvidence(grantId, 'Task execution grant did not return its credential reference');
    for (const kind of ['approved', 'rejected', 'stopped'] as const) {
      const row: LiveTaskCaseEvidence = { kind, ok: false };
      evidence.cases.push(row);
      phase = `${kind}:prepare`;
      const unique = randomUUID();
      const workspace = new URL(`acceptance/task-${unique}/`, options.podUrl).href;
      const target = new URL('marker.txt', workspace).href;
      const expected = `XPOD_TASK_${unique}`;
      const seed = await podFetch(new URL('seed.txt', workspace), {
        method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'Acceptance workspace\n',
      });
      requireEvidence(seed.ok, `Task workspace PUT HTTP ${seed.status}`);
      const created = await request<{ task: { id: string } }>('/api/tasks', 'POST', {
        kind: 'interval', intervalSeconds: 86400, workspace,
        prompt: `First call request_approval with target=${target}, action=http://www.w3.org/ns/odrl/2/write, risk=low, description=Write one acceptance marker line. Do not write anything before approval. After approval use the write tool to write exactly ${expected} followed by a newline into workspace-relative marker.txt. Then reply DONE. If rejected, do not write. Do not inspect credentials or unrelated files.`,
      });
      row.taskId = created.task.id;
      tasks.push(created.task.id);
      await pause(created.task.id);
      phase = `${kind}:queued`;
      const acknowledged = await request<{ run: LiveTaskRun }>(
        `/api/tasks/run?id=${encodeURIComponent(created.task.id)}`, 'POST', {});
      row.runId = acknowledged.run.id;
      requireEvidence(acknowledged.run.status === 'queued', 'Manual Run did not acknowledge queued status');
      row.queuedAck = true;
      phase = `${kind}:checkpoint`;
      const approval = await pollLiveTask(async () => {
        const run = await readRun(created.task.id, acknowledged.run.id);
        const approvals = await db.select().from(approvalResource).execute();
        return requireLiveCheckpoint(run, approvals, target, options.webId, row);
      }, value => Boolean(value), 'real producer approval');
      requireEvidence(approval, 'Producer approval missing');
      row.approvalPending = true;
      approvalSessions.add(approval.session);
      await pollLiveTask(() => sessionStatus(approval.session), value => value === 'paused', 'paused Session');
      const persistedSession = await db.findByIri(sessionResource, approval.session);
      requireEvidence(persistedSession?.owner === options.webId && persistedSession.thread === acknowledged.run.thread,
        'Approval Session does not belong to the current owner and Run thread');
      row.sessionPaused = true;
      requireEvidence((await marker(target)).status === 404, 'Producer wrote before approval');
      const approvalIri = approvalResource.buildIri(options.podUrl, { id: approval.id });
      const resumeRoute = `/api/tasks/resume?id=${encodeURIComponent(acknowledged.run.id)}`;
      phase = `${kind}:decision`;
      if (kind === 'stopped') {
        await request(`/api/tasks/stop?id=${encodeURIComponent(acknowledged.run.id)}`, 'POST', {});
      } else {
        const decision = await decideApprovalRequest({ approval: approvalIri, decision: kind,
          decisionBy: options.webId, authenticatedFetch: podFetch });
        requireEvidence(decision.status === 'decided', 'Owner approval compare-and-swap did not decide');
        row.decision = kind;
        const persisted = await db.findByIri(approvalResource, approvalIri);
        requireEvidence(persisted?.status === kind && persisted.decisionBy === options.webId && persisted.resolvedAt,
          'Owner decision was not durably persisted');
        const resumed = await request<{ run: LiveTaskRun; resumed: boolean }>(resumeRoute, 'POST', { approval: approvalIri }, 180_000);
        requireEvidence(resumed.run.id === acknowledged.run.id, 'Resume returned a different Run');
        requireEvidence(resumed.resumed === (kind === 'approved'), 'Unexpected approval continuation result');
      }
      phase = `${kind}:terminal`;
      const finalRun = await pollLiveTask(() => readRun(created.task.id, acknowledged.run.id),
        run => requireLiveTerminal(run, acknowledged.run.id, kind === 'approved' ? 'completed' : 'cancelled', row), 'same Run terminal state');
      row.sameRun = true;
      row.terminalStatus = finalRun.status;
      await pollLiveTask(() => sessionStatus(approval.session), value => value === 'completed', 'completed Session');
      row.sessionCompleted = true;
      const beforeMarker = await marker(target);
      if (kind === 'approved') {
        requireEvidence(beforeMarker.status === 200 && beforeMarker.body === `${expected}\n`, 'Approved Run did not write the exact Pod marker');
        row.markerMatches = true;
      } else {
        requireEvidence(beforeMarker.status === 404, 'Rejected or stopped Run wrote a marker');
        row.markerAbsent = true;
      }
      // Steps, Run count/status, Session and marker validator must stay stable after duplicate commands.
      const beforeSteps = await steps(acknowledged.run.id);
      phase = `${kind}:duplicate`;
      if (kind !== 'stopped') {
        const duplicate = await request<{ run: LiveTaskRun; resumed: boolean; duplicate: boolean }>(resumeRoute, 'POST', { approval: approvalIri });
        requireEvidence(duplicate.duplicate === true && duplicate.resumed === false
          && duplicate.run.id === acknowledged.run.id, 'Duplicate resume was not idempotent');
        row.duplicateResume = true;
      } else {
        await request(`/api/tasks/stop?id=${encodeURIComponent(acknowledged.run.id)}`, 'POST', {});
      }
      await new Promise(resolve => setTimeout(resolve, 2_000));
      requireEvidence(requireLiveTerminal(await readRun(created.task.id, acknowledged.run.id), acknowledged.run.id, finalRun.status, row),
        'Duplicate resume or Stop reopened the terminal Run');
      const afterMarker = await marker(target);
      requireEvidence(JSON.stringify(await steps(acknowledged.run.id)) === JSON.stringify(beforeSteps)
        && afterMarker.status === beforeMarker.status && afterMarker.body === beforeMarker.body
        && afterMarker.etag === beforeMarker.etag && await sessionStatus(approval.session) === 'completed',
      'Duplicate resume or Stop changed terminal execution evidence');
      row.stableAfterDuplicateOrStop = true;
      row.ok = true;
      options.onEvidence(evidence);
    }
  } catch (error) {
    // Only our controlled assertion vocabulary is safe; never emit raw upstream exceptions.
    evidence.failure = `Task acceptance failed at ${phase}${error instanceof LiveTaskEvidenceError ? `: ${error.message}` : ''}`;
  } finally {
    let cleanupOk = true;
    for (const taskId of tasks) {
      try { await pause(taskId); evidence.cleanup.tasksPaused += 1; } catch { cleanupOk = false; }
      try {
        const runs = await runsFor(taskId);
        try {
          const approvals = await db.select().from(approvalResource).execute();
          for (const approval of approvals) {
            if (runs.some(run => run.thread === approval.thread)) approvalSessions.add(approval.session);
          }
        } catch { cleanupOk = false; }
        for (const run of runs) {
          if (terminal.has(run.status)) continue;
          try {
            await request(`/api/tasks/stop?id=${encodeURIComponent(run.id)}`, 'POST', {});
            await pollLiveTask(async () => (await runsFor(taskId)).find(value => value.id === run.id),
              value => Boolean(value && terminal.has(value.status)), 'cleanup Run termination', 60_000);
            evidence.cleanup.runsStopped += 1;
          } catch { cleanupOk = false; }
        }
      } catch { cleanupOk = false; }
    }
    for (const iri of approvalSessions) {
      try {
        await pollLiveTask(() => sessionStatus(iri), value => value === 'completed' || value === 'error', 'cleanup Session termination', 60_000);
        evidence.cleanup.sessionsTerminal += 1;
      } catch { cleanupOk = false; }
    }
    // Recover a created grant even if POST timed out or its response was malformed. The account
    // was verified grant-free before POST, so these references belong only to this acceptance.
    const grantRefs = new Set(grantId ? [grantId] : []);
    if (grantAttempted && !grantId) {
      try {
        const recovered = await pollLiveTask(
          async () => (await request<{ data: TaskCredentialSummary[] }>('/api/ai/task-credentials')).data,
          grants => grants.some(grant => Boolean(grant.credentialRef)), 'unknown grant POST outcome', 20_000);
        for (const grant of recovered) grantRefs.add(grant.credentialRef);
      } catch { cleanupOk = false; }
    }
    // Revoke after bounded Stop attempts even if pausing or cancellation failed; never leave an active grant.
    if (grantRefs.size) {
      try {
        for (const ref of grantRefs) await request(`/api/ai/task-credentials/${encodeURIComponent(ref)}`, 'DELETE');
        const grants = await request<{ data: TaskCredentialSummary[] }>('/api/ai/task-credentials');
        requireEvidence(!grants.data.some(grant => grantRefs.has(grant.credentialRef) && grant.status !== 'revoked'),
          'Task grant remained active after revocation');
        evidence.cleanup.grantRevoked = true;
      } catch { cleanupOk = false; }
    }
    evidence.cleanup.ok = cleanupOk && (!grantRefs.size || evidence.cleanup.grantRevoked);
    evidence.ok = evidence.cases.length === 3 && evidence.cases.every(row => row.ok) && evidence.cleanup.ok;
    options.onEvidence(evidence);
  }
  return evidence;
}
