import { projectTaskRunFailureDiagnostic, type TaskRunFailureDiagnostic } from '../../src/api/tasks/TaskRunFailureDiagnostic';
import type { TaskCredentialSummary } from '../../src/api/tasks/TaskCredentialStore';
import { TASK_RESUME_STAGES, TASK_RESUME_ERROR_TYPES, selectTaskResumeFailure, type TaskResumeFailure, type TaskResumeStage, type TaskResumeErrorType } from '../../src/api/tasks/TaskResumeDiagnostics';
import { randomUUID } from 'node:crypto';
import { drizzle, type SolidAuthSession } from '@undefineds.co/drizzle-solid';
import { approvalResource, sessionResource, threadResource, decideApprovalRequest, RunStepType, type ApprovalRow } from '@undefineds.co/models';

export interface LiveTaskRun {
  id: string;
  thread: string;
  status: string;
  waitingToolCallId?: string;
  error?: unknown;
  failureDiagnostic?: TaskRunFailureDiagnostic;
}
export interface LiveTaskFailureDetails {
  substage: 'queued-request' | 'queued-assert' | 'checkpoint-run-read' | 'checkpoint-approval-read'
    | 'checkpoint-match' | 'checkpoint-session-read' | 'checkpoint-session-assert' | 'checkpoint-marker-read'
    | 'checkpoint-marker-assert' | 'decision-request' | 'decision-assert' | 'decision-persisted-read'
    | 'decision-persisted-assert' | 'decision-resume-request' | 'decision-resume-assert' | 'other';
  category: 'assertion' | 'timeout' | 'connection' | 'parse' | 'other';
  name: 'LiveTaskEvidenceError' | 'Error' | 'TypeError' | 'SyntaxError' | 'AbortError' | 'TimeoutError' | 'DOMException' | 'other';
  code?: 'ENOSPC' | 'ECONNREFUSED' | 'ECONNRESET' | 'ETIMEDOUT' | 'ENOTFOUND' | 'EACCES' | 'ERR_INVALID_URL';
  causeCode?: LiveTaskFailureDetails['code'];
  httpStatus?: number;
  runDocumentHttpStatus?: number;
  taskResumeStage?: TaskResumeStage;
  taskResumeErrorType?: TaskResumeErrorType;
  taskResumeFailure?: TaskResumeFailure;
  taskError?: TaskHttpErrorToken;
  errorEnvelope?: TaskErrorEnvelope;
}

export interface LiveTaskCaseEvidence {
  failureDiagnostic?: TaskRunFailureDiagnostic;
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
  acceptancePhase?: string;
  failureDetails?: LiveTaskFailureDetails;
  terminalSnapshot?: {
    status: string;
    errorPresent: boolean;
    errorClassification: 'pi_assistant_error' | 'pi_assistant_aborted' | 'other_error' | 'none';
    /** Run milestones do not establish whether an HTTP model request was sent. */
    modelRequest: 'unobserved';
    steps: { available: boolean; counts?: Record<string, number>; approvalTool?: boolean };
  };
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
  /** Safe coarse provider classification produced by the runner (never upstream text). */
  providerClass?: string;
  providerApi?: string;
  providerName?: string;
  providerModel?: string;
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
  // The runner appends allowlisted wire facts as `(class=..., api=..., provider=..., model=...)`.
  // Only that fixed vocabulary is copied; the provider body is never in these tokens.
  const token = (key: string): string | undefined => {
    const match = text.match(new RegExp(`\\b${key}=([A-Za-z0-9_.:\\-]{1,64})`, 'u'));
    return match?.[1];
  };
  evidence.producerFailure = {
    status: run.status as LiveTaskProducerFailure['status'], errorPresent,
    errorLength: Math.min(text.length, 1_000_000),
    errorClass: classes.find(([pattern]) => pattern.test(text))?.[1] ?? (errorPresent ? 'unknown' : 'none'),
    ...(statuses.size === 1 ? { httpStatus: [...statuses][0] } : {}),
    ...(token('class') ? { providerClass: token('class') } : {}),
    ...(token('api') ? { providerApi: token('api') } : {}),
    ...(token('provider') ? { providerName: token('provider') } : {}),
    ...(token('model') ? { providerModel: token('model') } : {}),
  };
}

export interface LiveTaskEvidence {
  ok: boolean;
  cases: LiveTaskCaseEvidence[];
  cleanup: { ok: boolean; tasksPaused: number; runsStopped: number; sessionsTerminal: number; grantRevoked: boolean };
  failure?: string;
  acceptancePhase?: string;
  failureDetails?: LiveTaskFailureDetails;
}

const taskHttpErrors = {
  'Authentication required': 'authentication_required',
  'authentication_required': 'authentication_required',
  'pod_owner_mismatch': 'pod_owner_mismatch',
  'service_access_missing': 'service_access_missing',
  'Resource id is required': 'resource_id_required',
  'Approval is required': 'approval_required',
  'Run not found': 'run_not_found',
  'Approval does not authorize this run': 'approval_not_authorized',
  'Approval does not match the pending tool checkpoint': 'approval_checkpoint_mismatch',
  'Approval has expired': 'approval_expired',
  'Run is not waiting at this approval checkpoint': 'run_checkpoint_mismatch',
  'Task not found for this run': 'task_not_found',
  'Agent execution credential is unavailable': 'agent_execution_credential_unavailable',
  'AI Connection invocation key issuer is required': 'ai_connection_invocation_issuer_required',
  'Run conditional writes require authenticated Pod access': 'run_conditional_auth_required',
  'Run updates require a strong document ETag': 'run_strong_etag_required',
  'Run updates require a Turtle document': 'run_turtle_document_required',
  'Run has invalid persisted status': 'run_persisted_status_invalid',
  'Run has invalid persisted timestamp': 'run_persisted_timestamp_invalid',
  'Run document changed repeatedly during conditional update': 'run_conditional_update_conflict',
  'Durable client tool continuation claim capability is required': 'continuation_claim_required',
  'Durable client tool continuation release capability is required': 'continuation_release_required',
  'Run workspace reference is required': 'run_workspace_required',
  'Durable approval session storage is unavailable': 'approval_session_storage_unavailable',
} as const;
const taskDocumentErrors = ['run_document_read_failed', 'run_document_update_failed'] as const;
const taskErrorEnvelopes = ['error_string', 'json_other', 'non_json', 'oversized', 'unreadable'] as const;
type TaskErrorEnvelope = typeof taskErrorEnvelopes[number];
type TaskHttpErrorToken = typeof taskHttpErrors[keyof typeof taskHttpErrors] | typeof taskDocumentErrors[number] | 'other_error';

/** Public desktop diagnostics contain reviewed tokens and bounded facts only. */
export function summarizeLiveTaskFailure(evidence: LiveTaskEvidence) {
  const phase = evidence.acceptancePhase;
  const details = evidence.failureDetails;
  const category = details?.category;
  const status = details?.httpStatus;
  const taskError = details?.taskError;
  const substage = details?.substage;
  const producer = [...evidence.cases].reverse().find(row => row.producerFailure)?.producerFailure;
  return {
    phase: phase && /^(?:grant|(?:approved|rejected|stopped):(?:prepare|queued|checkpoint|decision|terminal|duplicate))$/u.test(phase)
      ? phase : 'other',
    ...(['assertion', 'timeout', 'connection', 'parse', 'other'].includes(category ?? '') ? { category } : {}),
    ...(Number.isInteger(status) && status! >= 100 && status! <= 599 ? { httpStatus: status } : {}),
    ...(taskError && ['other_error', ...Object.values(taskHttpErrors), ...taskDocumentErrors].includes(taskError)
      ? { taskError } : {}),
    ...(substage && /^(?:queued-(?:request|assert)|checkpoint-(?:run-read|approval-read|match|session-read|session-assert|marker-read|marker-assert)|decision-(?:request|assert|persisted-read|persisted-assert|resume-request|resume-assert))$/u.test(substage) ? { substage } : {}),
    ...(producer && ['failed', 'cancelled', 'completed'].includes(producer.status) ? { producerStatus: producer.status } : {}),
    ...(producer && ['none', 'unknown', 'auth_required', 'service_access_missing', 'token_exchange_failed', 'provider_error', 'provider_aborted', 'sandbox_unavailable', 'worker_start_failed', 'worker_exited', 'execution_state_error'].includes(producer.errorClass) ? { producerErrorClass: producer.errorClass } : {}),
    completedCases: evidence.cases.filter(row => row.ok === true).length,
    cleanupOk: evidence.cleanup.ok === true,
  };
}

class LiveTaskEvidenceError extends Error {
  public httpStatus?: number;
  public runDocumentHttpStatus?: number;
  public taskResumeStage?: TaskResumeStage;
  public taskResumeErrorType?: TaskResumeErrorType;
  public taskResumeFailure?: TaskResumeFailure;
  public taskError?: TaskHttpErrorToken;
  public errorEnvelope?: TaskErrorEnvelope;
}

/** Read only a small error envelope; never retain or report its contents. */
async function taskHttpErrorToken(response: Response): Promise<Pick<LiveTaskFailureDetails, 'taskResumeStage' | 'taskResumeErrorType' | 'taskResumeFailure' | 'runDocumentHttpStatus'> & { taskError: TaskHttpErrorToken; errorEnvelope: TaskErrorEnvelope }> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body?.getReader();
    if (!reader) return { taskError: 'other_error', errorEnvelope: 'unreadable' };
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) { void reader.cancel().catch(() => undefined); return { taskError: 'other_error', errorEnvelope: 'oversized' }; }
      chunks.push(value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(buffer)); }
    catch { return { taskError: 'other_error', errorEnvelope: 'non_json' }; }
    const envelope = body && typeof body === 'object' && !Array.isArray(body)
      ? body as { error?: unknown; taskResumeStage?: unknown; taskResumeErrorType?: unknown; taskResumeFailure?: unknown } : undefined;
    const taskResumeFailure = selectTaskResumeFailure(envelope?.taskResumeFailure);
    const resumeDiagnostics = {
      ...(taskResumeFailure ? { taskResumeFailure } : {}),
      ...(typeof envelope?.taskResumeStage === 'string' && TASK_RESUME_STAGES.includes(envelope.taskResumeStage as TaskResumeStage) ? { taskResumeStage: envelope.taskResumeStage as TaskResumeStage } : {}),
      ...(typeof envelope?.taskResumeErrorType === 'string' && TASK_RESUME_ERROR_TYPES.includes(envelope.taskResumeErrorType as TaskResumeErrorType) ? { taskResumeErrorType: envelope.taskResumeErrorType as TaskResumeErrorType } : {}),
    };
    const error = envelope?.error;
    if (typeof error !== 'string') return { taskError: 'other_error', errorEnvelope: 'json_other', ...resumeDiagnostics };
    let taskError: TaskHttpErrorToken = 'other_error';
    let runDocumentHttpStatus: number | undefined;
    if (Object.prototype.hasOwnProperty.call(taskHttpErrors, error)) taskError = taskHttpErrors[error as keyof typeof taskHttpErrors];
    else {
      const documentError = /^Run document (read|update) failed: HTTP ([1-5][0-9]{2})$/.exec(error);
      if (documentError?.[0] === error) {
        taskError = documentError[1] === 'read' ? 'run_document_read_failed' : 'run_document_update_failed';
        runDocumentHttpStatus = Number(documentError[2]);
      }
    }
    return { taskError, errorEnvelope: 'error_string', ...resumeDiagnostics, ...(runDocumentHttpStatus !== undefined ? { runDocumentHttpStatus } : {}) };
  } catch { return { taskError: 'other_error', errorEnvelope: 'unreadable' }; }
  finally { reader?.releaseLock(); }
}

/** Fixed diagnostics only; upstream prose and arbitrary error properties never enter evidence. */
function safeFailureDetails(substage: LiveTaskFailureDetails['substage'], error: unknown): LiveTaskFailureDetails {
  try {
    const value = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
    const names = ['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'DOMException'];
    const codes = ['ENOSPC', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EACCES', 'ERR_INVALID_URL'];
    const controlled = error instanceof LiveTaskEvidenceError;
    const name = controlled ? 'LiveTaskEvidenceError'
      : typeof value?.name === 'string' && names.includes(value.name) ? value.name as LiveTaskFailureDetails['name'] : 'other';
    const code = typeof value?.code === 'string' && codes.includes(value.code) ? value.code as LiveTaskFailureDetails['code'] : undefined;
    const causeCode = typeof value?.cause?.code === 'string' && codes.includes(value.cause.code) ? value.cause.code as LiveTaskFailureDetails['code'] : undefined;
    const observedCodes = [code, causeCode];
    const taskResumeFailure = controlled ? selectTaskResumeFailure(error.taskResumeFailure) : undefined;
    const category = controlled ? 'assertion'
      : name === 'TimeoutError' || observedCodes.includes('ETIMEDOUT') ? 'timeout'
        : observedCodes.some(item => item === 'ECONNREFUSED' || item === 'ECONNRESET' || item === 'ENOTFOUND') ? 'connection'
          : name === 'SyntaxError' ? 'parse' : 'other';
    return { substage, category, name, ...(code ? { code } : {}), ...(causeCode ? { causeCode } : {}),
      ...(controlled && Number.isInteger(error.runDocumentHttpStatus) && error.runDocumentHttpStatus! >= 100 && error.runDocumentHttpStatus! <= 599 ? { runDocumentHttpStatus: error.runDocumentHttpStatus } : {}),
      ...(controlled && Number.isInteger(error.httpStatus) && error.httpStatus! >= 100 && error.httpStatus! <= 599 ? { httpStatus: error.httpStatus } : {}),
      ...(controlled && (error.taskError === 'other_error' || [...Object.values(taskHttpErrors), ...taskDocumentErrors].includes(error.taskError as Exclude<TaskHttpErrorToken, 'other_error'>)) ? { taskError: error.taskError } : {}),
      ...(controlled && taskErrorEnvelopes.includes(error.errorEnvelope as TaskErrorEnvelope) ? { errorEnvelope: error.errorEnvelope } : {}),
      ...(controlled && TASK_RESUME_STAGES.includes(error.taskResumeStage as TaskResumeStage) ? { taskResumeStage: error.taskResumeStage } : {}),
      ...(controlled && TASK_RESUME_ERROR_TYPES.includes(error.taskResumeErrorType as TaskResumeErrorType) ? { taskResumeErrorType: error.taskResumeErrorType } : {}),
      ...(taskResumeFailure ? { taskResumeFailure } : {}),
    };
  } catch {
    return { substage, category: 'other', name: 'other' };
  }
}

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

function sameThread(left: string | null | undefined, right: string | null | undefined, db?: ReturnType<typeof drizzle>): boolean {
  if (!left || !right) return false;
  return db ? threadResource.buildIriForDatabase(db, left) === threadResource.buildIriForDatabase(db, right) : left === right;
}

export function requireLiveCheckpoint(run: LiveTaskRun, approvals: ApprovalRow[], target: string,
  owner: string, evidence?: LiveTaskCaseEvidence, db?: ReturnType<typeof drizzle>): ApprovalRow | undefined {
  if (terminal.has(run.status)) {
    recordProducerFailure(run, evidence);
    const failure = evidence?.producerFailure;
    const facts = failure
      ? ` (class=${failure.errorClass}${failure.providerClass ? `/${failure.providerClass}` : ''}` +
        `${failure.providerApi ? `, api=${failure.providerApi}` : ''}` +
        `${failure.providerModel ? `, model=${failure.providerModel}` : ''}` +
        `${failure.httpStatus ? `, http=${failure.httpStatus}` : ''})`
      : '';
    throw new LiveTaskEvidenceError(`Producer ended ${run.status} before requesting approval${facts}`);
  }
  if (run.status !== 'waiting_input') return undefined;
  const matching = approvals.filter(approval => approval.target === target && sameThread(approval.thread, run.thread, db)
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
  const approvalSessions = new Map<string, string>();
  let grantId: string | undefined;
  let grantAttempted = false;
  let phase = 'grant';
  let failureSubstage: LiveTaskFailureDetails['substage'] = 'other';
  let lastObservedRun: LiveTaskRun | undefined;
  // Do not include upstream bodies, model prose, tool arguments or credential material in errors/evidence.
  const request = async <T>(route: string, method = 'GET', body?: unknown, timeout = 20_000): Promise<T> => {
    const response = await options.ownerFetch(new URL(route, options.gateway), {
      method, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeout),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const validStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599;
      const error = new LiveTaskEvidenceError(`Task ${method} ${route.split('?')[0]} HTTP ${validStatus ? response.status : 'unknown'}`);
      if (validStatus) error.httpStatus = response.status;
      Object.assign(error, await taskHttpErrorToken(response));
      throw error;
    }
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
    lastObservedRun = run;
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
      lastObservedRun = undefined;
      failureSubstage = 'other';
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
      failureSubstage = 'queued-request';
      const acknowledged = await request<{ run: LiveTaskRun }>(
        `/api/tasks/run?id=${encodeURIComponent(created.task.id)}`, 'POST', {});
      row.runId = acknowledged.run.id;
      failureSubstage = 'queued-assert';
      requireEvidence(acknowledged.run.status === 'queued', 'Manual Run did not acknowledge queued status');
      row.queuedAck = true;
      phase = `${kind}:checkpoint`;
      const approval = await pollLiveTask(async () => {
        failureSubstage = 'checkpoint-run-read';
        const run = await readRun(created.task.id, acknowledged.run.id);
        if (run.status === 'failed') {
          row.failureDiagnostic = projectTaskRunFailureDiagnostic(run.failureDiagnostic, run.status)
            ?? { code: 'TASK_DIAGNOSTIC_UNAVAILABLE', stage: 'unknown', status: 'failed' };
          return requireLiveCheckpoint(run, [], target, options.webId, row, db);
        }
        failureSubstage = 'checkpoint-approval-read';
        const approvals = await db.select().from(approvalResource).execute();
        failureSubstage = 'checkpoint-match';
        return requireLiveCheckpoint(run, approvals, target, options.webId, row, db);
      }, value => Boolean(value), 'real producer approval');
      requireEvidence(approval, 'Producer approval missing');
      row.approvalPending = true;
      approvalSessions.set(approval.session, acknowledged.run.thread);
      failureSubstage = 'checkpoint-session-read';
      await pollLiveTask(() => sessionStatus(approval.session), value => value === 'paused', 'paused Session');
      const persistedSession = await db.findByIri(sessionResource, approval.session);
      failureSubstage = 'checkpoint-session-assert';
      requireEvidence(persistedSession?.owner === options.webId && sameThread(persistedSession.thread, acknowledged.run.thread, db),
        'Approval Session does not belong to the current owner and Run thread');
      row.sessionPaused = true;
      failureSubstage = 'checkpoint-marker-read';
      const beforeDecisionMarker = await marker(target);
      failureSubstage = 'checkpoint-marker-assert';
      requireEvidence(beforeDecisionMarker.status === 404, 'Producer wrote before approval');
      const approvalIri = approvalResource.buildIri(options.podUrl, { id: approval.id });
      const resumeRoute = `/api/tasks/resume?id=${encodeURIComponent(acknowledged.run.id)}`;
      phase = `${kind}:decision`;
      failureSubstage = 'other';
      if (kind === 'stopped') {
        await request(`/api/tasks/stop?id=${encodeURIComponent(acknowledged.run.id)}`, 'POST', {});
      } else {
        failureSubstage = 'decision-request';
        const decision = await decideApprovalRequest({ approval: approvalIri, decision: kind,
          decisionBy: options.webId, authenticatedFetch: podFetch });
        failureSubstage = 'decision-assert';
        requireEvidence(decision.status === 'decided', 'Owner approval compare-and-swap did not decide');
        row.decision = kind;
        failureSubstage = 'decision-persisted-read';
        const persisted = await db.findByIri(approvalResource, approvalIri);
        failureSubstage = 'decision-persisted-assert';
        requireEvidence(persisted?.status === kind && persisted.decisionBy === options.webId && persisted.resolvedAt,
          'Owner decision was not durably persisted');
        failureSubstage = 'decision-resume-request';
        const resumed = await request<{ run: LiveTaskRun; resumed: boolean }>(resumeRoute, 'POST', { approval: approvalIri }, 180_000);
        failureSubstage = 'decision-resume-assert';
        requireEvidence(resumed.run.id === acknowledged.run.id, 'Resume returned a different Run');
        requireEvidence(resumed.resumed === (kind === 'approved'), 'Unexpected approval continuation result');
      }
      phase = `${kind}:terminal`;
      failureSubstage = 'other';
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
      failureSubstage = 'other';
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
    evidence.acceptancePhase = phase;
    evidence.failureDetails = safeFailureDetails(failureSubstage, error);
    evidence.failure = `Task acceptance failed at ${phase}${error instanceof LiveTaskEvidenceError ? `: ${error.message}` : ''}`;
    const row = evidence.cases[evidence.cases.length - 1];
    if (row) {
      row.acceptancePhase = phase;
      row.failureDetails = safeFailureDetails(failureSubstage, error);
      if (lastObservedRun && terminal.has(lastObservedRun.status)) {
        const runError = lastObservedRun.error;
        const errorPresent = typeof runError === 'string' ? runError.length > 0 : runError != null;
        const snapshot: NonNullable<LiveTaskCaseEvidence['terminalSnapshot']> = {
          status: lastObservedRun.status,
          errorPresent,
          errorClassification: runError === 'Pi assistant ended with error' ? 'pi_assistant_error'
            : runError === 'Pi assistant ended with aborted' ? 'pi_assistant_aborted'
              : errorPresent ? 'other_error' : 'none',
          modelRequest: 'unobserved',
          steps: { available: false },
        };
        row.terminalSnapshot = snapshot;
        try {
          // Only failure diagnostics read steps; never expose their free-text messages or arguments.
          const result = await request<{ steps: Array<{ type: unknown; message: unknown }> }>(
            `/api/tasks/steps?id=${encodeURIComponent(lastObservedRun.id)}`);
          requireEvidence(Array.isArray(result.steps), 'Task diagnostic steps missing');
          const knownTypes = new Set<string>(Object.values(RunStepType));
          const counts: Record<string, number> = {};
          let approvalTool = false;
          for (const step of result.steps) {
            if (!step || typeof step.type !== 'string' || !knownTypes.has(step.type)) continue;
            counts[step.type] = (counts[step.type] ?? 0) + 1;
            if (step.type === RunStepType.TOOL_CALL && step.message === 'request_approval') approvalTool = true;
          }
          snapshot.steps = { available: true, counts, approvalTool };
        } catch { /* Diagnostic failure cannot replace the producer failure or prevent cleanup. */ }
      }
    }
    options.onEvidence(evidence);
  } finally {
    let cleanupOk = true;
    for (const taskId of tasks) {
      try { await pause(taskId); evidence.cleanup.tasksPaused += 1; } catch { cleanupOk = false; }
      try {
        const runs = await runsFor(taskId);
        try {
          // Discover Sessions independently of checkpoint matching: a failed producer may
          // have persisted its Session before writing the Approval, and both relations read as IRIs.
          const sessions = await db.select().from(sessionResource).execute();
          for (const run of runs) {
            const matching = sessions.filter(session => sameThread(session.thread, run.thread, db));
            requireEvidence(matching.every(session => session.owner === options.webId), 'Cleanup Session owner mismatch');
            requireEvidence(!(run.status === 'waiting_input' || run.waitingToolCallId) || matching.length === 1,
              'Cleanup approval Run requires its real Session');
            for (const session of matching) approvalSessions.set(sessionResource.buildIriForDatabase(db, session), run.thread);
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
    for (const [iri, thread] of approvalSessions) {
      try {
        await pollLiveTask(() => db.findByIri(sessionResource, iri), session => Boolean(session
          && session.owner === options.webId && sameThread(session.thread, thread, db)
          && (session.status === 'completed' || session.status === 'error')), 'cleanup Session termination', 60_000);
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
