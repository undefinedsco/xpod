import { describe, expect, it } from 'vitest';
import { agendaTasks, groupTasks } from '../src/grouping';
import type { TaskSummary } from '../src/client';
const me = 'https://pod.test/me';
const task = (id: string, changes: Partial<TaskSummary> = {}): TaskSummary => ({ id, instruction: id, status: 'open', assignedTo: me, createdAt: 1, updatedAt: 2, ...changes });
describe('task grouping', () => {
  it('uses assignee, prioritizes waiting and sorts todos with undated items last', () => {
    const items = [task('undated'), task('due', { dueAt: 30 }), task('waiting', { waiting: true }), task('ai', { assignedTo: 'urn:agent:one' })];
    const result = groupTasks(items, me, 'all', 100);
    expect(result.mine.map(row => row.id)).toEqual(['due', 'undated']);
    expect(result.waiting.map(row => row.id)).toEqual(['waiting']);
    expect(groupTasks(items, me, 'ai', 100).ai.map(row => row.id)).toEqual(['ai']);
    expect(groupTasks(items, me, 'mine', 100).ai).toEqual([]);
  });
  it('does not guess completion from modified timestamps', () => {
    const result = groupTasks([task('unknown', { status: 'completed', updatedAt: 999999 }), task('recent', { status: 'completed', completedAt: 999990 }), task('old', { status: 'completed', completedAt: 1 })], me, 'all', 1000000);
    expect(result.recent.map(row => row.id)).toEqual(['recent']);
    expect(result.ended).toHaveLength(3);
  });
  it('only schedules dated todos and timed AI tasks, excluding interval and event', () => {
    const now = new Date(2026, 9, 2, 12); const date = +now / 1000;
    const schedule = (kind: 'cron' | 'interval' | 'event') => ({ kind, nextRunAt: date, paused: false });
    const result = agendaTasks([task('todo', { dueAt: date }), task('timed', { assignedTo: 'urn:agent:one', schedule: schedule('cron') }), task('interval', { assignedTo: 'urn:agent:one', schedule: schedule('interval') }), task('event', { assignedTo: 'urn:agent:one', schedule: schedule('event') })], me, now);
    expect(result.today.map(row => row.id)).toEqual(['todo', 'timed']);
  });
});
