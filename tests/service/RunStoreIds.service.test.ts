import { describe, expect, it } from 'vitest';
import {
  buildRunResourceId,
  buildRunStepResourceId,
  generateRunResourceId,
  generateRunStepResourceId,
  isBaseRelativeResourceId,
  isRunResourceId,
} from '../../src/api/runs/store';
import { buildTaskResourceId, generateTaskResourceId } from '../../src/api/tasks/store';
import { Chat, Message, Thread } from '../../src/api/chatkit/schema';
import { Run, RunStep } from '../../src/api/runs/schema';
import { Task } from '../../src/api/tasks/schema';

describe('Run and Task resource ids', () => {
  it('does not treat fragment ids as complete base-relative resource ids', () => {
    expect(isBaseRelativeResourceId('#run_1')).toBe(false);
    expect(isBaseRelativeResourceId('run_1')).toBe(false);
    expect(isBaseRelativeResourceId('task/default/2026/05/18/runs.ttl#run_1')).toBe(true);
    expect(isRunResourceId('#run_1')).toBe(false);
    expect(isRunResourceId('task/default/2026/05/18/runs.ttl#run_1')).toBe(true);
  });

  it('generates complete date-bucketed Run and RunStep resource ids', () => {
    const createdAt = Date.UTC(2026, 4, 18, 1, 2, 3) / 1000;
    const runId = generateRunResourceId({
      key: 'run_1',
      parentKind: 'task',
      parentKey: 'secretary',
      createdAt,
    });

    expect(runId).toBe('task/secretary/2026/05/18/runs.ttl#run_1');
    expect(generateRunStepResourceId({
      key: 'step_1',
      runId,
      createdAt,
    })).toBe('task/secretary/2026/05/18/runs.ttl#step_1');
  });

  it('keeps build helpers exact and rejects non-complete resource ids', () => {
    expect(buildRunResourceId({
      id: 'task/secretary/2026/05/18/runs.ttl#run_1',
    })).toBe('task/secretary/2026/05/18/runs.ttl#run_1');

    expect(() => buildRunResourceId({
      id: '#run_1',
    })).toThrow('Run id must be a complete Run resource id');

    expect(() => generateRunResourceId({
      key: 'task/secretary/2026/05/18/messages.ttl#run_1',
      parentKind: 'task',
      parentKey: 'secretary',
    })).toThrow('Run id generator requires a local key');

    expect(() => generateRunResourceId({
      key: '#run_1',
      parentKind: 'task',
      parentKey: 'secretary',
    })).toThrow('Run id generator requires a local key');

    expect(() => buildRunStepResourceId({
      id: '#step_1',
    })).toThrow('RunStep id must be a complete RunStep resource id');
  });

  it('generates Task ids separately from exact Task id validation', () => {
    expect(generateTaskResourceId('task_1')).toBe('index.ttl#task_1');
    expect(() => generateTaskResourceId('#task_1'))
      .toThrow('Task id generator requires a local key');
    expect(buildTaskResourceId('index.ttl#task_1')).toBe('index.ttl#task_1');
    expect(() => buildTaskResourceId('task_1'))
      .toThrow('Task id must be a complete Task resource id under index.ttl');
    expect(() => buildTaskResourceId('other.ttl#task_1'))
      .toThrow('Task id must be a complete Task resource id under index.ttl');
  });

  it('does not define custom subjectTemplate for complete-id resources', () => {
    expect(Chat.hasCustomTemplate()).toBe(false);
    expect(Thread.hasCustomTemplate()).toBe(false);
    expect(Message.hasCustomTemplate()).toBe(false);
    expect(Run.hasCustomTemplate()).toBe(false);
    expect(RunStep.hasCustomTemplate()).toBe(false);
    expect(Task.hasCustomTemplate()).toBe(false);
    expect(Task.config.base).toBe('/.data/task/');
  });
});
