import { createHash } from 'node:crypto';
import { approvalResource, sessionResource, type ApprovalInsert, type SessionInsert, type SessionStatus } from '@undefineds.co/models';
import type { AgentRuntimeEvent } from './AgentRuntimeTypes';
import type { RunRecordData } from './store';

export interface RunApprovalStore<TContext> {
  writeTaskApproval?(approval: ApprovalInsert, context: TContext): Promise<string>;
  saveRunApprovalSession?(session: SessionInsert, context: TContext): Promise<string>;
}

/** Persist the human-authority request only after its client-tool checkpoint exists. */
export async function persistRunApproval<TContext>(input: {
  store: RunApprovalStore<TContext>; run: RunRecordData;
  event: Extract<AgentRuntimeEvent, { type: 'tool_call' }>; context: TContext;
}): Promise<string | undefined> {
  const { store, run, event, context } = input;
  if (!event.approval) return undefined;
  if (event.name !== 'request_approval' || !store.writeTaskApproval || !store.saveRunApprovalSession) {
    throw new Error('Durable approval storage is unavailable');
  }
  const owner = approvalOwner(context);
  const now = new Date();
  const key = `approval_${createHash('sha256').update(`${run.id}\0${event.requestId}`).digest('hex').slice(0, 32)}`;
  run.metadata = { ...run.metadata, approvalSessionKey: `run_${createHash('sha256').update(run.id).digest('hex').slice(0, 32)}` };
  const session = await updateRunApprovalSession(store, run, 'paused', context);
  const id = approvalResource.buildId({ id: key, createdAt: now });
  return store.writeTaskApproval({
    id, session: session!, thread: run.thread, toolCallId: event.requestId, toolName: event.name,
    target: event.approval.target, action: event.approval.action, risk: event.approval.risk,
    context: event.approval.description, assignedTo: owner, status: 'pending',
    createdAt: now, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  }, context);
}

export async function updateRunApprovalSession<TContext>(
  store: RunApprovalStore<TContext>, run: RunRecordData, status: SessionStatus, context: TContext,
): Promise<string | undefined> {
  const key = run.metadata?.approvalSessionKey;
  if (typeof key !== 'string') return undefined;
  if (!store.saveRunApprovalSession) throw new Error('Durable approval session storage is unavailable');
  const owner = approvalOwner(context);
  const createdAt = new Date(run.createdAt * 1000);
  const id = sessionResource.buildId({ id: key, createdAt });
  return store.saveRunApprovalSession({ id, owner, thread: run.thread, tool: 'pi', status, createdAt, updatedAt: new Date() }, context);
}

function approvalOwner<TContext>(context: TContext): string {
  const auth = (context as { auth?: { webId?: unknown } }).auth;
  if (typeof auth?.webId !== 'string' || !/^https?:\/\//.test(auth.webId)) throw new Error('Approval requires an authenticated Pod owner');
  return auth.webId;
}
