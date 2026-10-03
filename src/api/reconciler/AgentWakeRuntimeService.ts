import { createHash } from 'node:crypto';
import { MatrixError } from '../matrix/MatrixError';
import type { MatrixStoreContext } from '../matrix/types';
import type { SharedWakeAgentJob } from './coordination';
import type { WakeAgentLeaseReference, WakeAgentQueue } from './WakeAgentQueue';

export interface AgentWakeRequest { roomId: string; agent: string; runtimeId: string; leaseMs?: number }
export interface AgentWakeLeaseRequest extends AgentWakeRequest { id: string; fencingToken: string }
export interface AgentWakeResult { body: string; handoffTo?: string; evidence?: string[] }
export interface AgentWakeRuntimeBackend {
  authorize(roomId: string, agent: string, context: MatrixStoreContext): Promise<{ thread: string }>;
  recover(roomId: string, context: MatrixStoreContext): Promise<void>;
  loadInput(roomId: string, job: SharedWakeAgentJob, context: MatrixStoreContext): Promise<{ content: string; [key: string]: unknown }>;
  commitResult(roomId: string, job: SharedWakeAgentJob, result: AgentWakeResult, context: MatrixStoreContext): Promise<{ eventId: string; run: string }>;
  recordFailure(roomId: string, job: SharedWakeAgentJob, failure: { error?: string; retry: boolean }, context: MatrixStoreContext): Promise<void>;
}

/** At-least-once execution: backend result writes and external tools need their own idempotency. */
export class AgentWakeRuntimeService {
  public constructor(private readonly queue: WakeAgentQueue, private readonly backend: AgentWakeRuntimeBackend) {}

  public async claim(request: AgentWakeRequest, context: MatrixStoreContext): Promise<{
    job: SharedWakeAgentJob | null; input?: { content: string; [key: string]: unknown };
  }> {
    const options = await this.options(request, context);
    await this.backend.recover(request.roomId, context);
    const job = await this.queue.claim(options);
    if (!job) { return { job: null }; }
    try {
      return { job, input: await this.backend.loadInput(request.roomId, job, context) };
    } catch (error) {
      await this.fail({ ...request, id: job.id, fencingToken: job.fencingToken!, error: 'Input loading failed', retry: true }, context);
      throw error;
    }
  }

  public async renew(request: AgentWakeLeaseRequest, context: MatrixStoreContext): Promise<{ ok: true }> {
    this.assertLease(await this.queue.renew(await this.reference(request, context)));
    return { ok: true };
  }

  public async fail(request: AgentWakeLeaseRequest & { error?: string; retry?: boolean }, context: MatrixStoreContext): Promise<{ ok: true }> {
    const reference = await this.reference(request, context);
    const job = await this.activeJob(reference);
    // The public runtime contract uses the queue's default three-attempt budget.
    const retry = request.retry !== false && (job.attempts ?? 0) < 3;
    await this.backend.recordFailure(request.roomId, job, { error: request.error, retry }, context);
    this.assertLease(await this.queue.fail({ ...reference, error: request.error, retry }));
    return { ok: true };
  }

  public async complete(request: AgentWakeLeaseRequest & AgentWakeResult, context: MatrixStoreContext): Promise<{ eventId: string; run: string }> {
    const reference = await this.reference(request, context);
    const job = await this.activeJob(reference);
    const result = await this.backend.commitResult(request.roomId, job, {
      body: request.body, handoffTo: request.handoffTo, evidence: request.evidence,
    }, context);
    // A crash after the Pod write causes a replay. The backend must reuse the job's result ID.
    this.assertLease(await this.queue.complete(reference));
    return result;
  }

  private async options(request: AgentWakeRequest, context: MatrixStoreContext): Promise<{
    thread: string; agent: string; owner: string; leaseMs?: number;
  }> {
    if (!context.webId) { throw new MatrixError(401, 'M_UNAUTHORIZED', 'Authenticated WebID required'); }
    if (!request.runtimeId || request.runtimeId.length > 128 ||
      (request.leaseMs !== undefined && (!Number.isSafeInteger(request.leaseMs) || request.leaseMs < 1000 || request.leaseMs > 300_000))) {
      throw new MatrixError(400, 'M_BAD_JSON', 'runtimeId and lease duration are invalid');
    }
    const { thread } = await this.backend.authorize(request.roomId, request.agent, context);
    const clientId = context.auth?.type === 'solid' ? context.auth.clientId ?? '' : '';
    const owner = createHash('sha256').update(JSON.stringify([context.webId, clientId, request.runtimeId])).digest('hex');
    return { thread, agent: request.agent, owner, leaseMs: request.leaseMs };
  }

  private async reference(request: AgentWakeLeaseRequest, context: MatrixStoreContext): Promise<WakeAgentLeaseReference> {
    return { ...await this.options(request, context), id: request.id, fencingToken: request.fencingToken };
  }

  private async activeJob(reference: WakeAgentLeaseReference): Promise<SharedWakeAgentJob> {
    this.assertLease(await this.queue.renew(reference));
    const job = (await this.queue.listQueued(reference.thread, reference.agent)).find(candidate =>
      candidate.status === 'leased' && candidate.id === reference.id && candidate.leaseOwner === reference.owner && candidate.fencingToken === reference.fencingToken);
    this.assertLease(Boolean(job));
    return job!;
  }

  private assertLease(valid: boolean): void {
    if (!valid) { throw new MatrixError(409, 'M_CONFLICT', 'Lease is expired, superseded, or owned by another runtime'); }
  }
}
