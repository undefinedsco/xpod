/**
 * Task module - 任务系统
 *
 * 简化模型：消息 + Agent
 */

// Schema
export { Task as TaskTable, TaskStatus, getTodayTaskPath, getTaskPathForDate } from './schema';
export type { TaskStatusType } from './schema';

// Types
export type {
  Task,
  TaskStatus as TaskStatusString,
  CreateTaskInput,
  Agent,
  AgentContext,
  AgentResult,
  ListTasksOptions,
  TaskQueue,
  TaskQueueStats,
  TaskExecutor as ITaskExecutor,
} from './types';

// Implementations
export { DrizzleTaskQueue, type DrizzleTaskQueueOptions } from './DrizzleTaskQueue';
export { TaskExecutor, type TaskExecutorOptions } from './TaskExecutor';
