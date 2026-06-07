import type { WorkspaceRef } from '../workspace/types';
import type { TaskAuthBindingSnapshot } from './TaskAuthBinding';
import type { TaskStatusType, TaskTriggerKindType } from './schema';

export interface TaskRecordData {
  /** Base-relative Solid resource id, e.g. `index.ttl#task_x`. */
  id: string;
  surfaceId: string;
  title?: string;
  prompt: string;
  thread: string;
  workspace: WorkspaceRef;
  runner: string;
  status: TaskStatusType;
  triggerKind: TaskTriggerKindType;
  cron?: string;
  intervalSeconds?: number;
  eventName?: string;
  nextRunAt?: number;
  lastRunAt?: number;
  authBinding?: TaskAuthBindingSnapshot;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface TaskListOptions {
  status?: TaskStatusType;
  triggerKind?: TaskTriggerKindType;
  eventName?: string;
  dueAt?: number;
  limit?: number;
}

export interface TaskStore<TContext> {
  saveTask(task: TaskRecordData, context: TContext): Promise<void>;
  loadTask(taskId: string, context: TContext): Promise<TaskRecordData>;
  listTasks(options: TaskListOptions, context: TContext): Promise<TaskRecordData[]>;
}

export function isTaskResourceId(value: string | null | undefined): value is string {
  return typeof value === 'string'
    && /^index\.ttl#[^#/]+$/.test(value);
}

export function buildTaskResourceId(id: string): string {
  if (!isTaskResourceId(id)) {
    throw new Error(`Task id must be a complete Task resource id under index.ttl: ${id}`);
  }
  return id;
}

export function generateTaskResourceId(input: string | {
  key: string;
  surfaceId: string;
  createdAt?: number;
}): string {
  const key = typeof input === 'string' ? input : input.key;
  if (/^index\.ttl#[^#/]+$/.test(key)) {
    throw new Error(`Task id generator requires a local key, got resource id: ${key}`);
  }
  if (/\.ttl(?:#|$)/i.test(key) || key.includes('/') || key.includes('#')) {
    throw new Error(`Task id generator requires a local key: ${key}`);
  }
  return `index.ttl#${key}`;
}

export function generateDefaultTaskResourceId(key: string): string {
  return generateTaskResourceId(key);
}

export function resolveTaskResource(podBaseUrl: string, taskId: string): string {
  if (/^https?:\/\//.test(taskId)) {
    return taskId;
  }
  const base = podBaseUrl.replace(/\/$/, '');
  const relative = buildTaskResourceId(taskId).replace(/^\/+/, '');
  return `${base}/.data/task/${relative}`;
}

export function resolveTaskUrn(taskId: string): string {
  return `urn:xpod:task:${encodeURIComponent(buildTaskResourceId(taskId))}`;
}
