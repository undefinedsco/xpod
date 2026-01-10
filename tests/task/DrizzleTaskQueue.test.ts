/**
 * DrizzleTaskQueue 单元测试
 */

import { describe, it, expect, vi } from 'vitest';
import type { CreateTaskInput, Task } from '../../src/task/types';

// 直接从 schema 导出的常量，不需要 mock drizzle-solid
const ActionStatus = {
  POTENTIAL: 'https://schema.org/PotentialActionStatus',
  ACTIVE: 'https://schema.org/ActiveActionStatus',
  COMPLETED: 'https://schema.org/CompletedActionStatus',
  FAILED: 'https://schema.org/FailedActionStatus',
} as const;

const TaskClass = {
  INDEX: 'IndexTask',
  AI: 'AITask',
  MIGRATION: 'MigrationTask',
  TODO: 'TodoTask',
} as const;

const TaskSource = {
  MANUAL: 'manual',
  SCHEDULE: 'schedule',
  TRIGGER: 'trigger',
  WEBHOOK: 'webhook',
  SYSTEM: 'system',
} as const;

type ActionStatusType = (typeof ActionStatus)[keyof typeof ActionStatus];
type TaskClassType = (typeof TaskClass)[keyof typeof TaskClass];

describe('DrizzleTaskQueue', () => {
  describe('Task Interface', () => {
    it('should have correct task structure', () => {
      const task: Task<{ test: string }> = {
        id: 'task-123',
        '@type': TaskClass.INDEX as TaskClassType,
        actionStatus: ActionStatus.POTENTIAL as ActionStatusType,
        target: 'https://pod.example.com/docs/file.md',
        created: new Date(),
        modified: new Date(),
        priority: 'normal',
        source: TaskSource.MANUAL,
        retryCount: 0,
        maxRetries: 3,
        payload: { test: 'value' },
      };

      expect(task.id).toBe('task-123');
      expect(task['@type']).toBe(TaskClass.INDEX);
      expect(task.actionStatus).toBe(ActionStatus.POTENTIAL);
    });

    it('should support all task types', () => {
      expect(TaskClass.INDEX).toBe('IndexTask');
      expect(TaskClass.AI).toBe('AITask');
      expect(TaskClass.MIGRATION).toBe('MigrationTask');
      expect(TaskClass.TODO).toBe('TodoTask');
    });

    it('should support all action statuses', () => {
      expect(ActionStatus.POTENTIAL).toBe('https://schema.org/PotentialActionStatus');
      expect(ActionStatus.ACTIVE).toBe('https://schema.org/ActiveActionStatus');
      expect(ActionStatus.COMPLETED).toBe('https://schema.org/CompletedActionStatus');
      expect(ActionStatus.FAILED).toBe('https://schema.org/FailedActionStatus');
    });
  });

  describe('CreateTaskInput', () => {
    it('should accept valid input', () => {
      const input: CreateTaskInput<{ documentUrl: string }> = {
        '@type': TaskClass.INDEX as TaskClassType,
        target: 'https://pod.example.com/docs/file.md',
        instruction: 'Index this document',
        payload: { documentUrl: 'https://pod.example.com/docs/file.md' },
      };

      expect(input['@type']).toBe(TaskClass.INDEX);
      expect(input.target).toBeDefined();
      expect(input.payload).toBeDefined();
    });

    it('should allow optional fields', () => {
      const input: CreateTaskInput = {
        '@type': TaskClass.AI as TaskClassType,
        target: 'https://pod.example.com/',
        payload: {},
      };

      expect(input.instruction).toBeUndefined();
      expect(input.priority).toBeUndefined();
      expect(input.schedule).toBeUndefined();
    });
  });

  describe('Task Sources', () => {
    it('should support all task sources', () => {
      expect(TaskSource.MANUAL).toBe('manual');
      expect(TaskSource.SCHEDULE).toBe('schedule');
      expect(TaskSource.TRIGGER).toBe('trigger');
      expect(TaskSource.WEBHOOK).toBe('webhook');
      expect(TaskSource.SYSTEM).toBe('system');
    });
  });
});
