import {
  TaskStatus,
  taskResource,
  type TaskRow,
  type TaskStatusType,
} from '@undefineds.co/models';

export const Task = taskResource;

export const TaskTriggerKind = {
  ONCE: 'once',
  INTERVAL: 'interval',
  CRON: 'cron',
  EVENT: 'event',
} as const;

export type TaskTriggerKindType = (typeof TaskTriggerKind)[keyof typeof TaskTriggerKind];

export { TaskStatus };

export type TaskRecord = TaskRow;
export type {
  TaskStatusType,
};
