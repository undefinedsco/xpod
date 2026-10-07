import type { ShellAttentionItem } from '@undefineds.co/extension-sdk';
import type { TaskRun } from '@undefineds.co/tasks';

/**
 * An approval belongs to a run only after the projection verified its exact tool checkpoint.
 * A run without a thread has no match; the `?approval=` id is a same-thread preference.
 */
export function selectRunApproval(
  items: readonly ShellAttentionItem[],
  run: Pick<TaskRun, 'id' | 'thread'>,
  requestedId?: string | null,
): ShellAttentionItem | undefined {
  if (!run.thread) return undefined;
  const sameThread = items.filter(item => item.approvalId && item.run === run.id && item.thread === run.thread);
  return sameThread.find(item => item.approvalId === requestedId) ?? sameThread[0];
}
