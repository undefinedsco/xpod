import {
  TaskStatus,
  TaskTriggerKind,
  taskResource,
  type TaskRow,
  type TaskStatusType,
  type TaskTriggerKindType,
} from '@undefineds.co/models';

export const Task = taskResource;

export { TaskStatus, TaskTriggerKind };

export type TaskRecord = TaskRow;
export type {
  TaskStatusType,
  TaskTriggerKindType,
};
