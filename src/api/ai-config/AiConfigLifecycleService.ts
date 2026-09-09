import { randomUUID } from 'node:crypto';
import type {
  AiConfigOwner,
  AiConfigLifecycleService,
  AiConfigLifecycleSnapshot,
  AiConfigRebuildJob,
  AiConfigRebuildTarget,
} from '../handlers/AiConfigHandler';

type Owner = { webId: string; podUrl: string };
type RebuildExecutor = (owner: Owner) => Promise<void>;

export interface RuntimeAiConfigLifecycleServiceOptions {
  executors: Partial<Record<AiConfigRebuildTarget, RebuildExecutor>>;
  now?: () => Date;
  id?: () => string;
  configurationVersion?: (owner: AiConfigOwner) => Promise<string | undefined>;
  recentLimit?: number;
}

export class RuntimeAiConfigLifecycleService implements AiConfigLifecycleService {
  private readonly jobs = new Map<string, AiConfigRebuildJob[]>();
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly recentLimit: number;

  public constructor(private readonly options: RuntimeAiConfigLifecycleServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.recentLimit = options.recentLimit ?? 20;
  }

  public supportedTargets(): AiConfigRebuildTarget[] {
    return (['fts', 'vector', 'all'] as const).filter((target) => Boolean(this.options.executors[target]));
  }

  public async status(owner: AiConfigOwner): Promise<AiConfigLifecycleSnapshot> {
    const recent = (this.jobs.get(ownerKey(owner)) ?? []).map(cloneJob);
    return {
      configurationVersion: await this.options.configurationVersion?.(owner),
      pending: recent.filter((job) => job.status === 'queued' || job.status === 'running').length,
      recent,
    };
  }

  public async schedule(input: AiConfigOwner & { target: AiConfigRebuildTarget }): Promise<AiConfigRebuildJob> {
    const executor = this.options.executors[input.target];
    if (!executor) throw new Error('rebuild_target_unsupported');
    const job: AiConfigRebuildJob = {
      id: this.id(), target: input.target, status: 'queued', createdAt: this.now().toISOString(), progress: 0,
    };
    const key = ownerKey(input);
    this.jobs.set(key, [job, ...(this.jobs.get(key) ?? [])].slice(0, this.recentLimit));
    queueMicrotask(() => { void this.execute(job, { webId: input.webId, podUrl: input.podUrl }, executor); });
    return cloneJob(job);
  }

  private async execute(job: AiConfigRebuildJob, owner: Owner, executor: RebuildExecutor): Promise<void> {
    job.status = 'running';
    job.startedAt = this.now().toISOString();
    job.progress = 1;
    try {
      await executor(owner);
      job.status = 'succeeded';
      job.progress = 100;
    } catch {
      job.status = 'failed';
      job.error = 'Rebuild failed';
    } finally {
      job.completedAt = this.now().toISOString();
    }
  }
}

function ownerKey(owner: Owner): string { return `${owner.webId}\n${owner.podUrl}`; }
function cloneJob(job: AiConfigRebuildJob): AiConfigRebuildJob { return { ...job }; }
