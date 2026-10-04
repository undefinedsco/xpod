import type { TaskMaterializer } from '../../src/api/tasks/TaskMaterializer';
import { getTaskResumeStage } from '../../src/api/tasks/TaskResumeDiagnostics';
import { describe, expect, it, vi } from 'vitest';
import { approvalResource, sessionResource, type ApprovalRow, type ApprovalInsert, type SessionInsert } from '@undefineds.co/models';
import { InMemoryStore, type StoreContext } from '../../src/api/chatkit/store';
import { toThreadRef } from '../../src/api/chatkit/types';
import { TaskService } from '../../src/api/tasks/TaskService';
import { ChatKitService } from '../../src/api/chatkit/service';
import { RunStateCenter } from '../../src/api/runs/RunStateCenter';
import type { RunExecutionInput } from '../../src/api/runs/RunExecutionBackend';
import type { RunRecordData } from '../../src/api/runs/store';
type ResumeTestMaterializer = Pick<TaskMaterializer<StoreContext>, 'resumeClientToolOutput'> & {
  continuation: RunStateCenter<StoreContext>;
  withInvocationAiConnections(context: StoreContext): Promise<StoreContext>;
};
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
  it.each(['run_read', 'approval_validation', 'checkpoint_validation', 'task_lookup', 'task_auth_restore', 'invocation_issue', 'continuation_prepare', 'continuation_complete', 'continuation_release', 'run_result_read'] as const)('preserves original failure at %s', async stage => {
    const app = await setup();
    const error = Object.freeze(new Error('generic failure'));
    const materializer = (app.service as unknown as { materializer: ResumeTestMaterializer }).materializer;
    const continuation = materializer.continuation;
    let resume = app.resume;
    if (stage === 'run_read') vi.spyOn(app.store, 'loadRun').mockRejectedValueOnce(error);
    if (stage === 'approval_validation') vi.spyOn(app.store, 'readTaskApproval').mockRejectedValueOnce(error);
    if (stage === 'checkpoint_validation') vi.spyOn(app.store, 'loadThreadItems').mockRejectedValueOnce(error);
    if (stage === 'task_lookup') vi.spyOn(app.store, 'listTasks').mockRejectedValueOnce(error);
    if (stage === 'task_auth_restore') resume = () => app.service.resumeApprovedRun({ runId: app.run.id, owner, approval: 'https://pod.test/alice/.data/approvals/test.ttl#a' }, context, async () => { throw error; });
    if (stage === 'invocation_issue') vi.spyOn(materializer, 'withInvocationAiConnections').mockRejectedValueOnce(error);
    if (stage === 'continuation_prepare') vi.spyOn(continuation, 'prepareClientToolOutput').mockRejectedValueOnce(error);
    if (stage === 'continuation_complete' || stage === 'continuation_release') vi.spyOn(continuation, 'completePreparedClientToolOutput').mockImplementationOnce(async function* () { yield* []; throw stage === 'continuation_release' ? new Error('initial failure') : error; });
    if (stage === 'continuation_release') vi.spyOn(continuation, 'releaseClientToolOutput').mockRejectedValueOnce(error);
    if (stage === 'run_result_read') {
      vi.spyOn(materializer, 'resumeClientToolOutput').mockResolvedValueOnce(true);
      const original = app.store.loadRun.bind(app.store);
      vi.spyOn(app.store, 'loadRun').mockImplementationOnce(original).mockRejectedValueOnce(error);
    }
    await expect(resume()).rejects.toBe(error);
    expect(getTaskResumeStage(error)).toBe(stage);
    expect(error.message).toBe('generic failure');
  });
  it('classifies a frozen prepared item assignment as preparation without entering continuation cleanup', async () => {
    const app = await setup();
    const continuation = (app.service as unknown as { materializer: ResumeTestMaterializer }).materializer.continuation;
    const prepare = continuation.prepareClientToolOutput.bind(continuation);
    vi.spyOn(continuation, 'prepareClientToolOutput').mockImplementationOnce(async input => {
      const prepared = await prepare(input);
      if (prepared) Object.freeze(prepared.claim.item);
      return prepared;
    });
    const complete = vi.spyOn(continuation, 'completePreparedClientToolOutput');
    const release = vi.spyOn(continuation, 'releaseClientToolOutput');
    const error = await app.resume().catch(value => value);
    expect(error).toBeInstanceOf(TypeError);
    expect(getTaskResumeStage(error)).toBe('continuation_prepare');
    expect(complete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
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
  it('carries the original run instruction into the continuation so exact requirements survive', async () => {
    const app = await setup();
    const result = await app.resume();
    expect(result.run.status).toBe('completed');
    expect(app.inputs).toHaveLength(2);
    const continuation = app.inputs[1];
    const carriedInstruction = [continuation.prompt, ...continuation.conversation.map(message => message.text)].join('\n');
    expect(carriedInstruction).toContain('Prepare and publish');
  });
  it('acknowledges a repeat decision when the completed checkpoint metadata loses runId in the Pod round-trip', async () => {
    const app = await setup();
    await app.resume();
    expect(app.inputs).toHaveLength(2);
    const threadRef = toThreadRef({ thread_id: app.run.thread });
    const items = await app.store.loadThreadItems(threadRef, undefined, 1000, 'asc', context);
    const tool = items.data.find(item => item.type === 'client_tool_call');
    expect(tool).toBeDefined();
    // The checkpoint binds to the Run through the durable waitingTool receipt, not the
    // free-form item metadata, so a store that cannot round-trip metadata still resolves it.
    delete (tool!.metadata as Record<string, unknown> | undefined)?.runId;
    expect(await app.resume()).toMatchObject({ duplicate: true, resumed: false, run: { status: 'completed' } });
    expect(app.inputs).toHaveLength(2);
  });
  it('still rejects a repeat decision whose call id no longer matches the run checkpoint', async () => {
    const app = await setup();
    await app.resume();
    const threadRef = toThreadRef({ thread_id: app.run.thread });
    const items = await app.store.loadThreadItems(threadRef, undefined, 1000, 'asc', context);
    delete (items.data.find(item => item.type === 'client_tool_call')!.metadata as Record<string, unknown> | undefined)?.runId;
    app.store.approval!.toolCallId = 'call_other';
    await expect(app.resume()).rejects.toThrow('checkpoint');
    expect(app.inputs).toHaveLength(2);
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
