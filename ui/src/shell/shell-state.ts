import type { SolidDatabase } from '@undefineds.co/drizzle-solid';
import { approvalResource, decideApprovalRequest, inboxNotificationResource, runResource, taskResource } from '@undefineds.co/models';
import type { ShellAttentionSnapshot } from '@undefineds.co/extension-sdk';

type DateValue = Date | string | null;
interface Approval { toolCallId?: string; thread?: string | null; id: string; status: string; toolName?: string; risk?: string; expiresAt?: DateValue }
interface Inbox { id: string; actor?: string | null; object: string; createdAt: DateValue }
interface Run { metadata?: unknown; thread?: string | null; id: string; status: string; task?: string | null; prompt?: string | null }
interface Task { id: string; title?: string | null; createdAt: DateValue }
export const emptyShellSnapshot = (): ShellAttentionSnapshot => ({ attention: [], activity: [], inProgress: [], inbox: [] });
export function isActionableApproval(approval: { status: string; expiresAt?: DateValue }, now = Date.now()): boolean {
  return ['pending', 'handling'].includes(approval.status) && (!approval.expiresAt || new Date(approval.expiresAt).getTime() > now);
}
const dateString = (value?: DateValue) => value ? new Date(value).toISOString() : '';
const runHref = (run: Run) => `/tasks?run=${encodeURIComponent(run.id)}`;
function runWaitingToolCallId(run: Run): string | undefined {
  if (!run.metadata || typeof run.metadata !== 'object') return undefined;
  const waiting = (run.metadata as { waitingTool?: unknown }).waitingTool;
  if (!waiting || typeof waiting !== 'object') return undefined;
  const requestId = (waiting as { requestId?: unknown }).requestId;
  return typeof requestId === 'string' ? requestId : undefined;
}
function approvalMatchesCheckpoint(approval: Approval, run: Run): boolean {
  return Boolean(approval.thread && approval.toolCallId
    && approval.thread === run.thread && approval.toolCallId === runWaitingToolCallId(run));
}
function approvalMatchesRun(approval: Approval, run: Run): boolean {
  return run.status === 'waiting_input' && approvalMatchesCheckpoint(approval, run);
}
function approvalHref(approval: Approval, inbox: Inbox[], runs: Run[]): string {
  const request = `approval=${encodeURIComponent(approval.id)}`;
  if (inbox.some(item => item.object === approval.id)) return `/inbox?${request}`;
  const run = runs.find(item => approvalMatchesRun(approval, item));
  return run ? `${runHref(run)}&${request}` : `/inbox?${request}`;
}
export function projectShellState({ approvals, inbox, runs, tasks }: { approvals: Approval[]; inbox: Inbox[]; runs: Run[]; tasks: Task[] }): ShellAttentionSnapshot {
  const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
  const pending = approvals.filter(row => {
    if (!isActionableApproval(row)) return false;
    const relatedRuns = runs.filter(run => approvalMatchesCheckpoint(row, run));
    // A terminal run hides its obsolete request without changing the decision.
    // Reused checkpoint IDs remain visible while any matching run is active.
    return relatedRuns.length === 0 || relatedRuns.some(run => !terminalStatuses.has(run.status));
  });
  return {
    attention: [
      ...pending.map(row => ({ id: row.id, approvalId: row.id, thread: row.thread || undefined, run: runs.find(run => approvalMatchesRun(row, run))?.id, title: row.toolName || '访问申请', kind: 'approval' as const, href: approvalHref(row, inbox, runs), risk: row.risk, toolName: row.toolName, expiresAt: dateString(row.expiresAt) || undefined })),
      ...runs.filter(row => ['failed', 'waiting_input'].includes(row.status)).map(row => {
        const decided = approvals.find(approval => ['approved', 'rejected'].includes(approval.status) && approvalMatchesRun(approval, row));
        return { id: row.id, run: row.id, thread: row.thread || undefined, resumeApproval: decided?.id,
          title: row.status === 'failed' ? '运行失败' : decided ? '审批已保存，运行待处理' : '运行在等你确认', kind: 'run' as const, href: runHref(row) };
      }),
    ],
    activity: tasks.map(row => ({ id: `task:${row.id}`, title: `新建任务：${row.title || '未命名任务'}`, href: `/tasks?task=${encodeURIComponent(row.id)}`, createdAt: dateString(row.createdAt) })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    inProgress: runs.filter(row => row.status === 'running').map(row => ({ id: row.id, title: row.prompt || '任务运行中', href: runHref(row) })),
    inbox: inbox.map(row => ({ id: row.id, actor: row.actor || undefined, object: row.object, createdAt: dateString(row.createdAt), approvalId: pending.find(approval => approval.id === row.object)?.id })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}
export function markActivitiesRead(snapshot: ShellAttentionSnapshot): ShellAttentionSnapshot {
  return { ...snapshot, activity: snapshot.activity.map(item => ({ ...item, read: true })) };
}
export async function readShellSnapshot(db: SolidDatabase): Promise<ShellAttentionSnapshot> {
  const [approvals, inbox, runs, tasks] = await Promise.all([
    db.select().from(approvalResource), db.select().from(inboxNotificationResource), db.select().from(runResource), db.select().from(taskResource),
  ]);
  return projectShellState({
    approvals: (approvals as Approval[]).map(row => ({ ...row, id: db.resolveRowIri(approvalResource, { ...row }) })),
    inbox: (inbox as Inbox[]).map(row => ({ ...row, id: db.resolveRowIri(inboxNotificationResource, { ...row }) })),
    runs: (runs as Run[]).map(row => ({ ...row, id: db.resolveRowIri(runResource, { ...row }) })),
    tasks: (tasks as Task[]).map(row => ({ ...row, id: db.resolveRowIri(taskResource, { ...row }) })),
  });
}
export async function decideApproval(authenticatedFetch: typeof fetch, iri: string, webId: string, decision: 'approved' | 'rejected', isCurrent = () => true): Promise<void> {
  const result = await decideApprovalRequest({ approval: iri, decisionBy: webId, decision, authenticatedFetch, isCurrent });
  if (result.status === 'decided') return;
  const messages = {
    conflict: '申请已被其他入口处理，请刷新后查看。',
    not_found: '申请不存在，请刷新。',
    not_actionable: '申请已处理、过期或当前身份无权处理，请刷新。',
    unavailable: '此 Pod 尚不支持安全审批，请稍后重试。',
  };
  throw new Error(messages[result.status]);
}
