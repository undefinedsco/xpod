import {
  normalizeReconcilerOwner,
  type ReconcilerOwner,
  type SharedWakeAgentJob,
  type WakeAgentReason,
} from './coordination';
import {
  createWakeAgentQueue,
  sharedWakeAgentJobId,
  type WakeAgentQueue,
} from './WakeAgentQueue';

export interface ReconcileGroupThreadMessageInput {
  thread: string;
  triggerMessage: string;
  actor?: string;
  role?: 'user' | 'assistant' | 'system' | string;
  content?: string;
  reconcilerOwner?: ReconcilerOwner;
  mentions?: string[];
  routeTargetAgent?: string;
  participants?: string[];
}

export interface ReconcileGroupThreadMessageResult {
  wakeJobs: SharedWakeAgentJob[];
  inserted: number;
  skippedReason?: string;
}

export interface ServerGroupReconcilerServiceOptions {
  wakeQueue?: WakeAgentQueue;
  redisUrl?: string;
  now?: () => Date;
}

/**
 * Protocol-independent group-room Reconciler.
 *
 * It decides only whether a group message should enqueue minimal WakeAgentJob
 * records. It does not choose models, providers, workspaces, or tool placement,
 * and it does not create a durable Reconciler Pod resource.
 */
export class ServerGroupReconcilerService {
  private readonly wakeQueue: WakeAgentQueue;
  private readonly now: () => Date;

  public constructor(options: ServerGroupReconcilerServiceOptions = {}) {
    this.wakeQueue = options.wakeQueue ?? createWakeAgentQueue({ redisUrl: options.redisUrl });
    this.now = options.now ?? (() => new Date());
  }

  public async reconcileThreadMessage(input: ReconcileGroupThreadMessageInput): Promise<ReconcileGroupThreadMessageResult> {
    const reconcilerOwner = normalizeReconcilerOwner(input.reconcilerOwner, 'server');
    if (reconcilerOwner !== 'server') {
      return { wakeJobs: [], inserted: 0, skippedReason: 'not_server_reconciled' };
    }
    if (input.role && input.role !== 'user') {
      return { wakeJobs: [], inserted: 0, skippedReason: 'not_user_message' };
    }

    const targets = selectWakeTargets({
      mentions: input.mentions,
      routeTargetAgent: input.routeTargetAgent,
      participants: input.participants,
    });
    if (targets.length === 0) {
      return { wakeJobs: [], inserted: 0, skippedReason: 'no_agent_selected' };
    }

    const createdAt = this.now().toISOString();
    const jobs = targets.map(({ agent, reason }) => createWakeJob({
      thread: input.thread,
      triggerMessage: input.triggerMessage,
      agent,
      reason,
      createdAt,
    }));

    let inserted = 0;
    const enqueued: SharedWakeAgentJob[] = [];
    for (const job of jobs) {
      const result = await this.wakeQueue.enqueue(job);
      if (result.inserted) {
        inserted += 1;
      }
      enqueued.push(result.job);
    }

    return { wakeJobs: enqueued, inserted };
  }

  public async listQueued(thread: string, agent?: string): Promise<SharedWakeAgentJob[]> {
    return this.wakeQueue.listQueued(thread, agent);
  }

  public async close(): Promise<void> {
    await this.wakeQueue.close?.();
  }
}

export function normalizeAgentUris(value: unknown): string[] {
  if (typeof value === 'string' && value.length > 0) {
    return [ value ];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0)));
}

function selectWakeTargets(input: {
  mentions?: string[];
  routeTargetAgent?: string;
  participants?: string[];
}): Array<{ agent: string; reason: WakeAgentReason }> {
  if (input.routeTargetAgent) {
    return [{ agent: input.routeTargetAgent, reason: 'manual' }];
  }

  const participants = new Set(normalizeAgentUris(input.participants));
  return normalizeAgentUris(input.mentions)
    .filter((agent) => participants.size === 0 || participants.has(agent))
    .map((agent) => ({ agent, reason: 'mention' }));
}

function createWakeJob(input: {
  thread: string;
  triggerMessage: string;
  agent: string;
  reason: WakeAgentReason;
  createdAt: string;
}): SharedWakeAgentJob {
  return {
    id: sharedWakeAgentJobId(input),
    thread: input.thread,
    triggerMessage: input.triggerMessage,
    agent: input.agent,
    reason: input.reason,
    status: 'queued',
    createdAt: input.createdAt,
  };
}
