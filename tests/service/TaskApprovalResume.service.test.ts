import { describe, expect, it, vi } from 'vitest';
import { approvalResource, sessionResource, type ApprovalRow, type ApprovalInsert, type SessionInsert } from '@undefineds.co/models';
import { InMemoryStore, type StoreContext } from '../../src/api/chatkit/store';
import { TaskService } from '../../src/api/tasks/TaskService';
import { ChatKitService } from '../../src/api/chatkit/service';
import { RunStateCenter } from '../../src/api/runs/RunStateCenter';
import type { RunExecutionInput } from '../../src/api/runs/RunExecutionBackend';
import type { RunRecordData } from '../../src/api/runs/store';
const owner = 'https://pod.test/alice/profile/card#me';
const context: StoreContext = { userId: owner, auth: { type: 'solid', webId: owner } };
class ApprovalStore extends InMemoryStore<StoreContext> {
  approval: ApprovalRow | null = null;
  sessions: SessionInsert[] = [];
  async readTaskApproval() { return this.approval; }
  async writeTaskApproval(approval: ApprovalInsert) { this.approval = approval as ApprovalRow; return approvalResource.buildIri(owner, { id: approval.id! }); }
  async saveRunApprovalSession(session: SessionInsert) { this.sessions.push({ ...session }); return sessionResource.buildIri(owner, { id: session.id! }); }
}
async function setup(silentContinuation = false, producer = false, chat = false) {
  const store = new ApprovalStore(); const inputs: RunExecutionInput[] = [];
  const backend = { async *start(input: RunExecutionInput) {
    inputs.push(input);
    if (inputs.length === 1) yield { type: 'tool_call' as const, requestId: 'tool-1', name: producer ? 'request_approval' : 'publish', arguments: '{"target":"draft"}',
      ...(producer ? { approval: { target: 'https://pod.test/alice/draft.txt', action: 'http://www.w3.org/ns/odrl/2/write', risk: 'low' as const, description: 'Write the approved draft' } } : {}),
    };
    else if (silentContinuation) {
      await new Promise<void>(resolve => input.signal!.addEventListener('abort', () => resolve(), { once: true }));
    } else yield { type: 'text' as const, text: 'Published approved draft' };
  } };
  const service = new TaskService({ store, executionBackend: backend });
  let run: RunRecordData;
  if (chat) {
    const chatService = new ChatKitService({ store, enableAgentRuntime: true, runExecutionBackend: backend });
    const response = await chatService.process(JSON.stringify({ type: 'threads.create', params: {
      workspace: 'https://pod.test/work/', input: { content: [{ type: 'input_text', text: 'Prepare and publish' }] },
    }, metadata: { runtime: { runner: { type: 'pi', protocol: 'pi' } } } }), context);
    if (response.type === 'streaming') for await (const _chunk of response.stream()) { /* Persist real Chat checkpoint. */ }
    [run] = await store.listRuns({}, context);
  } else {
    const { task } = await service.createTask({ prompt: 'Prepare and publish', workspace: 'https://pod.test/work/', triggerKind: 'interval', intervalSeconds: 3600,
      authBinding: { id: 'credential', kind: 'solid-client-credentials', webId: owner, clientId: 'agent-key', status: 'active', createdAt: 1 },
    }, context);
    ({ run } = await service.runNow(task.id, context));
    await vi.waitFor(async () => expect((await store.loadRun(run.id, context)).status).toBe('waiting_input'));
    run = await store.loadRun(run.id, context);
  }
  const pendingApproval = store.approval;
  store.approval = { id: 'approval', ...pendingApproval, status: 'approved', decisionBy: owner, resolvedAt: new Date(), thread: run.thread, toolCallId: 'tool-1', toolName: producer ? 'request_approval' : 'publish' } as ApprovalRow;
  const resume = () => service.resumeApprovedRun({ runId: run.id, owner, approval: 'https://pod.test/alice/.data/approvals/test.ttl#a' }, context, async () => context);
  return { store, inputs, service, run, resume, pendingApproval };
}
describe('task approval checkpoint continuation', () => {
  it('disposes the continuation monitor when its initial cancellation check fails', async () => {
    const app = await setup();
    const check = vi.spyOn(RunStateCenter.prototype as unknown as { checkCancellation(): Promise<unknown> }, 'checkCancellation')
      .mockRejectedValue(new Error('cancellation read failed'));
    vi.useFakeTimers();
    try {
      await expect(app.resume()).rejects.toThrow('cancellation read failed');
      expect(vi.getTimerCount()).toBe(0);
      expect(app.inputs).toHaveLength(1);
    } finally { check.mockRestore(); vi.useRealTimers(); }
  });
  it('resumes an ordinary Chat approval through the same continuation without requiring a Task', async () => {
    const app = await setup(false, true, true);
    expect(app.run.task).toBeUndefined();
    expect(app.run.status).toBe('waiting_input');
    const result = await app.service.resumeApprovedRun({ runId: app.run.id, owner, approval: 'https://pod.test/alice/.data/approvals/test.ttl#a' }, context);
    expect(result.run).toMatchObject({ id: app.run.id, status: 'completed' });
    expect(app.inputs).toHaveLength(2);
    expect(app.inputs[1].continuation?.kind).toBe('client_tool_output');
    expect(await app.resume()).toMatchObject({ duplicate: true });
    expect(app.inputs).toHaveLength(2);
  });
  it('continues the same run once with an explicit authorization decision, not a fake tool result', async () => {
    const app = await setup(); expect(app.run.status).toBe('waiting_input');
    const result = await app.resume();
    expect(result.run.id).toBe(app.run.id); expect(result.run.status).toBe('completed');
    expect(app.inputs).toHaveLength(2); expect(app.inputs[1].runId).toBe(app.run.id);
    expect(app.inputs[1].continuation?.kind).toBe('client_tool_output');
    expect(app.inputs[1].prompt).toContain('NOT been executed');
    expect(await app.resume()).toMatchObject({ duplicate: true, resumed: false });
    expect(app.inputs).toHaveLength(2); expect(await app.store.listRuns({}, context)).toHaveLength(1);
  });
  it('claims simultaneous decisions once', async () => {
    const app = await setup();
    await Promise.all([app.resume(), app.resume()]);
    expect(app.inputs).toHaveLength(2);
  });
  it('aborts a silent resumed runtime and preserves the cancellation audit', async () => {
    const app = await setup(true);
    const resumed = app.resume();
    while (app.inputs.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
    const { cancelRun } = await import('../../src/api/runs/RunCancellation');
    await cancelRun({ store: app.store, runId: app.run.id, context, resourceIri: () => 'https://pod.test/run' });
    expect(await resumed).toMatchObject({ run: { id: app.run.id, status: 'cancelled' } });
    expect((await app.store.loadRun(app.run.id, context)).cancelRequestedAt).toBeTypeOf('number');
  });
  it.each(['thread', 'toolCallId', 'decisionBy'] as const)('rejects a mismatched %s', async field => {
    const app = await setup(); app.store.approval![field] = 'https://foreign.test/value';
    await expect(app.resume()).rejects.toThrow('Approval'); expect(app.inputs).toHaveLength(1);
  });
  it('persists an owner-assigned expiring request and real Session before pausing, then advances the same Session lifecycle', async () => {
    const app = await setup(false, true);
    expect(app.pendingApproval).toMatchObject({ status: 'pending', assignedTo: owner, thread: app.run.thread, toolCallId: 'tool-1', toolName: 'request_approval' });
    expect(app.pendingApproval!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(app.pendingApproval!.session).toContain('/.data/sessions/');
    expect(app.pendingApproval!.session).not.toBe(app.run.thread);
    expect(app.store.sessions[0]).toMatchObject({ owner, thread: app.run.thread, status: 'paused', tool: 'pi' });
    expect(app.run.metadata?.waitingTool).toMatchObject({ requestId: 'tool-1' });
    await app.resume();
    expect(app.store.sessions.map(session => session.status)).toEqual(expect.arrayContaining(['paused', 'active', 'completed']));
    expect(new Set(app.store.sessions.map(session => session.id)).size).toBe(1);
  });
  it('retries cancellation when rejection was saved but the run write failed', async () => {
    const app = await setup(); app.store.approval!.status = 'rejected';
    vi.spyOn(app.store, 'saveRun').mockRejectedValueOnce(new Error('temporary write failure'));
    await expect(app.resume()).rejects.toThrow('temporary write failure');
    expect(await app.resume()).toMatchObject({ resumed: false, duplicate: true, run: { status: 'cancelled' } });
    expect(app.inputs).toHaveLength(1);
  });
  it('does not execute an expired approval', async () => {
    const app = await setup(); app.store.approval!.expiresAt = new Date(0);
    await expect(app.resume()).rejects.toThrow('expired');
    expect(app.inputs).toHaveLength(1);
  });
  it('denial stops the waiting run without executing the action', async () => {
    const app = await setup(); app.store.approval!.status = 'rejected';
    expect(await app.resume()).toMatchObject({ resumed: false, run: { status: 'cancelled' } });
    expect(app.inputs).toHaveLength(1);
    expect(await app.resume()).toMatchObject({ duplicate: true });
  });
});
