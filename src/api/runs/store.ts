import type { WorkspaceRef } from '../workspace/types';
import type { RunStatusType, RunStepTypeValue } from './schema';

export interface RunRecordData {
  /** Base-relative Solid resource id, e.g. `chat/default/2026/05/18/runs.ttl#run_x`. */
  id: string;
  commandKind: 'chat' | 'task';
  surfaceId: string;
  task?: string;
  thread: string;
  workspace: WorkspaceRef;
  status: RunStatusType;
  runner: string;
  prompt?: string;
  externalRunId?: string;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  heartbeatAt?: number;
  cancelRequestedAt?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  updatedAt: number;
}

export interface RunStepRecordData {
  /** Base-relative Solid resource id, e.g. `chat/default/2026/05/18/runs.ttl#step_x`. */
  id: string;
  commandKind: 'chat' | 'task';
  surfaceId: string;
  /** Denormalized Run resource id for lookup; semantic relation is `run`. */
  runId: string;
  run: string;
  type: RunStepTypeValue | string;
  message?: string;
  data?: Record<string, unknown>;
  createdAt: number;
}

export interface RunListOptions {
  task?: string;
  thread?: string;
  workspace?: WorkspaceRef;
  commandKind?: 'chat' | 'task';
  status?: RunStatusType;
  limit?: number;
}

export interface RunStore<TContext> {
  saveRun(run: RunRecordData, context: TContext): Promise<void>;
  loadRun(id: string, context: TContext): Promise<RunRecordData>;
  listRuns(options: RunListOptions, context: TContext): Promise<RunRecordData[]>;
  appendRunStep(event: RunStepRecordData, context: TContext): Promise<void>;
  loadRunSteps(runId: string, context: TContext): Promise<RunStepRecordData[]>;
  claimRun?(input: {
    runId: string;
    leaseOwner: string;
    leaseExpiresAt: number;
    now: number;
  }, context: TContext): Promise<RunRecordData | undefined>;
}

export function isClaimableRunStatus(status: RunRecordData['status']): boolean {
  return status === 'queued' || status === 'running';
}

export function hasActiveRunLease(
  run: Pick<RunRecordData, 'leaseOwner' | 'leaseExpiresAt'>,
  now: number,
): boolean {
  return Boolean(run.leaseOwner && run.leaseExpiresAt && run.leaseExpiresAt > now);
}

export function canClaimRun(
  run: Pick<RunRecordData, 'status' | 'leaseOwner' | 'leaseExpiresAt'>,
  input: {
    leaseOwner: string;
    now: number;
  },
): boolean {
  if (!isClaimableRunStatus(run.status)) {
    return false;
  }
  return !hasActiveRunLease(run, input.now) || run.leaseOwner === input.leaseOwner;
}

export function isBaseRelativeResourceId(value: string | null | undefined): value is string {
  if (!value || /^https?:\/\//.test(value) || value.startsWith('/') || value.startsWith('#')) {
    return false;
  }
  return /\.(ttl|jsonld|json)(?:#[^#]+)?$/i.test(value);
}

export function isRunResourceId(value: string | null | undefined): value is string {
  return isBaseRelativeResourceId(value)
    && /^(chat|task)\/[^/]+\/\d{4}\/\d{2}\/\d{2}\/runs\.ttl#[^#/]+$/.test(value);
}

function assertLocalKey(value: string, label: string): void {
  if (value.includes('/') || value.includes('#') || /\.(ttl|jsonld|json)(?:#|$)/i.test(value)) {
    throw new Error(`${label} requires a local key: ${value}`);
  }
}

/**
 * Extracts the local template fragment for display or protocol compatibility.
 * Do not use this to turn a canonical resource id back into the durable `id`.
 */
export function extractResourceLocalId(resourceId: string): string {
  const hashIndex = resourceId.lastIndexOf('#');
  if (hashIndex >= 0 && hashIndex < resourceId.length - 1) {
    return resourceId.slice(hashIndex + 1);
  }
  const slashIndex = resourceId.lastIndexOf('/');
  return slashIndex >= 0 && slashIndex < resourceId.length - 1
    ? resourceId.slice(slashIndex + 1)
    : resourceId;
}

export function datePathFromTimestamp(timestamp: number | undefined): { yyyy: string; MM: string; dd: string } {
  const date = typeof timestamp === 'number' ? new Date(timestamp * 1000) : new Date();
  return {
    yyyy: String(date.getUTCFullYear()),
    MM: String(date.getUTCMonth() + 1).padStart(2, '0'),
    dd: String(date.getUTCDate()).padStart(2, '0'),
  };
}

export function generateRunResourceId(input: {
  key: string;
  commandKind: 'chat' | 'task';
  surfaceId: string;
  createdAt?: number;
}): string {
  if (isBaseRelativeResourceId(input.key)) {
    throw new Error(`Run id generator requires a local key, got resource id: ${input.key}`);
  }
  assertLocalKey(input.key, 'Run id generator');
  const { yyyy, MM, dd } = datePathFromTimestamp(input.createdAt);
  return `${input.commandKind}/${input.surfaceId}/${yyyy}/${MM}/${dd}/runs.ttl#${input.key}`;
}

export function generateRunStepResourceId(input: {
  key: string;
  runId?: string;
  commandKind: 'chat' | 'task';
  surfaceId: string;
  createdAt?: number;
}): string {
  if (isBaseRelativeResourceId(input.key)) {
    throw new Error(`RunStep id generator requires a local key, got resource id: ${input.key}`);
  }
  assertLocalKey(input.key, 'RunStep id generator');

  if (input.runId && isRunResourceId(input.runId)) {
    const runDoc = input.runId.slice(0, input.runId.lastIndexOf('#'));
    return `${runDoc}#${input.key}`;
  }

  const { yyyy, MM, dd } = datePathFromTimestamp(input.createdAt);
  return `${input.commandKind}/${input.surfaceId}/${yyyy}/${MM}/${dd}/runs.ttl#${input.key}`;
}

export function buildRunResourceId(input: {
  id: string;
  commandKind: 'chat' | 'task';
  surfaceId: string;
  createdAt?: number;
}): string {
  void input.commandKind;
  void input.surfaceId;
  void input.createdAt;
  if (!isRunResourceId(input.id)) {
    throw new Error(`Run id must be a complete Run resource id: ${input.id}`);
  }
  return input.id;
}

export function buildRunStepResourceId(input: {
  id: string;
  runId?: string;
  commandKind: 'chat' | 'task';
  surfaceId: string;
  createdAt?: number;
}): string {
  void input.runId;
  void input.commandKind;
  void input.surfaceId;
  void input.createdAt;
  if (!isRunResourceId(input.id)) {
    throw new Error(`RunStep id must be a complete RunStep resource id: ${input.id}`);
  }
  return input.id;
}

export function resolveRunUrn(runId: string): string {
  return `urn:xpod:run:${encodeURIComponent(runId)}`;
}

export function resolveDataResource(podBaseUrl: string, resourceId: string): string {
  if (/^https?:\/\//.test(resourceId)) {
    return resourceId;
  }
  const base = podBaseUrl.replace(/\/$/, '');
  const relative = resourceId.replace(/^\/+/, '');
  if (relative.startsWith('.data/')) {
    return `${base}/${relative}`;
  }
  return `${base}/.data/${relative}`;
}
