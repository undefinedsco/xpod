import type { TaskSummary } from './client';
export type TaskFilter = 'all' | 'mine' | 'ai';
export const isEnded = (task: TaskSummary): boolean => ['completed', 'failed', 'cancelled'].includes(task.status);
export const isMine = (task: TaskSummary, webId: string): boolean => task.assignedTo === webId;
export function groupTasks(tasks: readonly TaskSummary[], webId: string, filter: TaskFilter, now: number) {
  const visible = tasks.filter(task => filter === 'all' || (filter === 'mine' ? isMine(task, webId) : Boolean(task.assignedTo) && !isMine(task, webId)));
  const active = visible.filter(task => !isEnded(task));
  return {
    waiting: active.filter(task => task.waiting),
    mine: active.filter(task => !task.waiting && isMine(task, webId)).sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.createdAt - b.createdAt),
    ai: active.filter(task => !task.waiting && Boolean(task.assignedTo) && !isMine(task, webId)),
    unassigned: active.filter(task => !task.waiting && !task.assignedTo),
    recent: visible.filter(task => isEnded(task) && task.completedAt !== undefined && task.completedAt >= now - 7 * 86400),
    ended: visible.filter(isEnded),
  };
}
/** Uses local calendar boundaries, so a DST transition does not shift tomorrow. */
export function agendaTasks(tasks: readonly TaskSummary[], webId: string, now: Date) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const afterTomorrow = new Date(today); afterTomorrow.setDate(afterTomorrow.getDate() + 2);
  const weekEnd = new Date(today); weekEnd.setDate(weekEnd.getDate() + (7 - (today.getDay() + 6) % 7));
  const groups: Record<'overdue' | 'today' | 'tomorrow' | 'week' | 'later', TaskSummary[]> = { overdue: [], today: [], tomorrow: [], week: [], later: [] };
  for (const task of tasks.filter(task => !isEnded(task))) {
    const timestamp = isMine(task, webId) ? task.dueAt : task.schedule?.kind === 'cron' || task.schedule?.kind === 'once' ? task.schedule.nextRunAt : undefined;
    if (timestamp === undefined) continue;
    const date = timestamp * 1000;
    const group = date < +today ? 'overdue' : date < +tomorrow ? 'today' : date < +afterTomorrow ? 'tomorrow' : date < +weekEnd ? 'week' : 'later';
    groups[group].push(task);
  }
  for (const group of Object.values(groups)) group.sort((a, b) => (a.dueAt ?? a.schedule?.nextRunAt ?? 0) - (b.dueAt ?? b.schedule?.nextRunAt ?? 0));
  return groups;
}
