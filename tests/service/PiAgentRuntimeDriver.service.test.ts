import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { StreamFn } from '@mariozechner/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage } from '@mariozechner/pi-ai';
import * as pi from '@mariozechner/pi-coding-agent';
import { approvalResource, sessionResource, type ApprovalInsert, type SessionInsert } from '@undefineds.co/models';
import { PiAgentRuntimeDriver, classifyAssistantFailure } from '../../src/api/runs/PiAgentRuntimeDriver';
import type { AgentRuntimeEvent } from '../../src/api/runs/AgentRuntimeTypes';
import type { RunExecutionInput } from '../../src/api/runs/RunExecutionBackend';
import { InMemoryStore, type StoreContext } from '../../src/api/chatkit/store';
import { TaskService } from '../../src/api/tasks/TaskService';
import { cancelRun } from '../../src/api/runs/RunCancellation';
import type { SolidFS } from '../../src/solidfs';

const privateProviderError = 'Synthetic upstream refusal; credential=fixture-only';
const owner = 'https://pod.test/alice/profile/card#me';

class ApprovalStore extends InMemoryStore<StoreContext> {
  approvals: ApprovalInsert[] = [];
  approvalSessions: SessionInsert[] = [];
  async writeTaskApproval(approval: ApprovalInsert) {
    this.approvals.push(approval);
    return approvalResource.buildIri(owner, { id: approval.id! });
  }
  async saveRunApprovalSession(session: SessionInsert) {
    this.approvalSessions.push(session);
    return sessionResource.buildIri(owner, { id: session.id! });
  }
}

function response(stopReason: AssistantMessage['stopReason'], text = '', errorMessage?: string,
  content: AssistantMessage['content'] = [{ type: 'text', text }]): StreamFn {
  return (model, _context, options) => {
    const reason = options?.signal?.aborted ? 'aborted' : stopReason;
    const message: AssistantMessage = {
      role: 'assistant', content: options?.signal?.aborted ? [] : content,
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: reason, errorMessage, timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    if (reason === 'error' || reason === 'aborted') {
      stream.push({ type: 'error', reason, error: message });
    } else {
      stream.push({ type: 'done', reason, message });
    }
    return stream;
  };
}

async function fixture(streamFn: StreamFn, configureSession?: (session: pi.AgentSession) => void) {
  const root = path.join(process.cwd(), '.test-data', 'pi-terminal-error');
  fs.mkdirSync(root, { recursive: true });
  const workdir = fs.mkdtempSync(path.join(root, 'session-'));
  const workspace = pathToFileURL(workdir).href;
  const manifest = { workspace, cwd: workdir, projection: 'copy' as const, entries: [] };
  const commit = vi.fn(async () => manifest);
  const rollback = vi.fn(async () => undefined);
  const solidfs: SolidFS = { prepare: async () => ({ cwd: workdir, manifest, commit, rollback }) };
  const lifecycle: string[] = [];
  const sessions: pi.AgentSession[] = [];
  let resolvedPrompts = 0;
  let resolvePrompt!: () => void;
  const promptResolved = new Promise<void>(resolve => { resolvePrompt = resolve; });
  let streamCalls = 0;
  // Use the installed SDK lifecycle without reading developer Pi configuration or making HTTP calls.
  class IsolatedModelRegistry extends pi.ModelRegistry {
    constructor(auth: pi.AuthStorage) { super(auth, path.join(workdir, 'models.json')); }
  }
  class IsolatedResourceLoader extends pi.DefaultResourceLoader {
    constructor(options: NonNullable<ConstructorParameters<typeof pi.DefaultResourceLoader>[0]>) {
      super({ ...options, agentDir: workdir, agentsFilesOverride: () => ({ agentsFiles: [] }) });
    }
  }
  const sdk: typeof pi = { ...pi, ModelRegistry: IsolatedModelRegistry,
    DefaultResourceLoader: IsolatedResourceLoader,
    createAgentSession: async options => {
      const result = await pi.createAgentSession({ ...options, settingsManager: pi.SettingsManager.inMemory({
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false },
      }) });
      sessions.push(result.session);
      result.session.agent.streamFn = (...args) => ++streamCalls > 4
        ? response('aborted')(...args) : streamFn(...args);
      configureSession?.(result.session);
      result.session.subscribe(event => lifecycle.push(event.type));
      const prompt = result.session.prompt.bind(result.session);
      result.session.prompt = async (...args) => { await prompt(...args); resolvedPrompts += 1; resolvePrompt(); };
      return result;
    },
  };
  const driver = new PiAgentRuntimeDriver({ piSdk: sdk, solidfs, solidfsProjection: 'copy' });
  const input: RunExecutionInput = { runId: 'run_pi_terminal', threadId: 'thread_pi_terminal',
    prompt: 'Complete the task', conversation: [], config: { workspace,
      runner: { type: 'pi', protocol: 'pi' },
      aiConnection: { baseUrl: 'https://gateway.invalid/v1', apiKey: 'fixture-only', model: 'fixture-model' },
    } };
  return { driver, input, commit, rollback, lifecycle, sessions,
    resolvedPrompts: () => resolvedPrompts, promptResolved,
    cleanup: async () => {
      for (const session of sessions) { await session.abort(); session.dispose(); }
      fs.rmSync(workdir, { recursive: true, force: true });
      expect(streamCalls).toBeLessThanOrEqual(4);
    },
  };
}

async function drain(app: Awaited<ReturnType<typeof fixture>>) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of app.driver.start(app.input)) events.push(event);
  return events;
}

async function runTask(app: Awaited<ReturnType<typeof fixture>>) {
  const store = new ApprovalStore();
  const context: StoreContext = { userId: owner,
    auth: { type: 'solid', webId: owner }, aiConnection: app.input.config.aiConnection };
  const service = new TaskService({ store, executionBackend: app.driver });
  const { task } = await service.createTask({ prompt: 'Ask approval before writing', workspace: app.input.config.workspace,
    runner: 'pi:pi', triggerKind: 'interval', intervalSeconds: 3600,
    authBinding: { id: 'fixture-credential', kind: 'solid-client-credentials', webId: owner,
      clientId: 'fixture-client', status: 'active', createdAt: 1 },
  }, context);
  const { run } = await service.runNow(task.id, context);
  return { store, context, run };
}

describe('Pi assistant terminal status', () => {
  describe('provider failure classification', () => {
    it.each([
      ['{"error":{"message":"Unauthorized","status":401}}', 'auth'],
      ['openai-completions 403 Forbidden: invalid api key', 'auth'],
      ['429 Too Many Requests: rate limit exceeded', 'rate_limited'],
      ['model_not_found: unknown model xpod-gateway/model', 'model_unavailable'],
      ['400 Bad Request: malformed tool schema', 'client_400'],
      ['502 Bad Gateway from upstream', 'server_502'],
      ['request timed out after 30000ms', 'timeout'],
      ['fetch failed', 'transport'],
      ['upstream produced an unexpected stop', 'provider_error'],
      ['', 'unclassified'],
      [undefined, 'unclassified'],
    ])('classifies %j as %s without returning message text', (message, expected) => {
      expect(classifyAssistantFailure(message)).toBe(expected);
    });
  });

  it.each(['error', 'aborted'] as const)('fails a resolved SDK prompt with final stopReason %s without exposing upstream prose', async stopReason => {
    const app = await fixture(response(stopReason, '', privateProviderError));
    try {
      const events = await drain(app);
      expect(app.resolvedPrompts()).toBe(1);
      expect(app.lifecycle).toEqual(expect.arrayContaining(['message_end', 'turn_end', 'agent_end']));
      expect(events).toEqual([{ type: 'error', message: expect.stringContaining(`Pi assistant ended with ${stopReason}`) }]);
      expect(JSON.stringify(events)).not.toContain(privateProviderError);
      expect(app.commit).not.toHaveBeenCalled();
      expect(app.rollback).toHaveBeenCalledOnce();
    } finally { await app.cleanup(); }
  });

  it('fails the SDK catch path that resolves with only agent_end for its error assistant', async () => {
    const app = await fixture(response('stop'), session => {
      session.agent.subscribe(event => {
        if (event.type === 'message_end' && event.message.role === 'user') throw new Error(privateProviderError);
      });
    });
    try {
      expect(await drain(app)).toEqual([{ type: 'error', message: expect.stringContaining('Pi assistant ended with error') }]);
      expect(app.resolvedPrompts()).toBe(1);
      expect(app.lifecycle).toContain('agent_end');
      // The user message ends normally; the SDK catch path never emits an assistant message_end.
      expect(app.sessions[0].messages.slice(-1)[0]).toMatchObject({ role: 'assistant', stopReason: 'error' });
      expect(app.lifecycle.filter(type => type === 'message_end')).toHaveLength(1);
      expect(app.commit).not.toHaveBeenCalled();
      expect(app.rollback).toHaveBeenCalledOnce();
    } finally { await app.cleanup(); }
  });

  it('keeps a real SDK automatic retry that recovers to normal assistant text successful', async () => {
    let calls = 0;
    const app = await fixture((...args) => ++calls === 1
      ? response('error', '', '429 synthetic refusal')(...args)
      : response('stop', 'Recovered successfully')(...args));
    try {
      expect(await drain(app)).toEqual([{ type: 'text', text: 'Recovered successfully' }]);
      expect(calls).toBe(2);
      expect(app.lifecycle).toEqual(expect.arrayContaining(['auto_retry_start', 'auto_retry_end']));
      expect(app.resolvedPrompts()).toBe(1);
      expect(app.commit).toHaveBeenCalledOnce();
      expect(app.rollback).not.toHaveBeenCalled();
    } finally { await app.cleanup(); }
  });

  it('reports one safe failure after the real SDK exhausts its internal retry', async () => {
    const app = await fixture(response('error', '', '429 synthetic refusal; credential=fixture-only'));
    try {
      expect(await drain(app)).toEqual([{ type: 'error', message: expect.stringContaining('Pi assistant ended with error') }]);
      expect(app.lifecycle.filter(type => type === 'agent_end')).toHaveLength(2);
      expect(app.lifecycle).toContain('auto_retry_end');
      expect(app.commit).not.toHaveBeenCalled();
      expect(app.rollback).toHaveBeenCalledOnce();
    } finally { await app.cleanup(); }
  });

  it('keeps the real SDK approval tool paused without executing its requested action', async () => {
    const approval = { target: 'https://pod.test/work/output.txt', action: 'http://www.w3.org/ns/odrl/2/write',
      risk: 'low' as const, description: 'Write the approved confirmation file' };
    const app = await fixture(response('toolUse', '', undefined,
      [{ type: 'toolCall', id: 'approval-fixture', name: 'request_approval', arguments: approval }]));
    try {
      const { store, context, run } = await runTask(app);
      await vi.waitFor(async () => expect((await store.loadRun(run.id, context)).status).toBe('waiting_input'));
      expect(await store.loadRun(run.id, context)).toMatchObject({ status: 'waiting_input', metadata: { waitingTool: { requestId: 'approval-fixture' } } });
      expect(store.approvals).toEqual([expect.objectContaining({ status: 'pending', target: approval.target,
        action: approval.action, toolName: 'request_approval', toolCallId: 'approval-fixture' })]);
      expect(store.approvalSessions).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'paused' })]));
      await vi.waitFor(() => expect(app.sessions[0].isStreaming).toBe(false));
      expect(app.commit).toHaveBeenCalledOnce();
      expect(app.rollback).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(new URL(app.input.config.workspace).pathname, 'output.txt'))).toBe(false);
    } finally { await app.cleanup(); }
  });

  it('preserves caller cancellation while the real SDK produces an aborted assistant', async () => {
    let calls = 0;
    let started!: () => void;
    const streaming = new Promise<void>(resolve => { started = resolve; });
    const app = await fixture((model, context, options) => {
      if (++calls === 1) return response('error', '', '429 synthetic refusal')(model, context, options);
      if (calls === 2) return response('toolUse', '', undefined,
        [{ type: 'toolCall', id: 'read-before-cancel', name: 'read', arguments: { path: 'README.md' } }])(model, context, options);
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener('abort', async () => {
        for await (const event of await response('aborted', '', privateProviderError)(model, context, options)) stream.push(event);
      }, { once: true });
      started();
      return stream;
    });
    fs.writeFileSync(path.join(new URL(app.input.config.workspace).pathname, 'README.md'), 'Read fixture only');
    try {
      const { store, context, run } = await runTask(app);
      await app.promptResolved;
      await streaming;
      await cancelRun({ store, context, runId: run.id, resourceIri: () => 'https://pod.test/run' });
      await vi.waitFor(async () => expect((await store.loadRun(run.id, context)).status).toBe('cancelled'));
      await vi.waitFor(() => expect(app.rollback).toHaveBeenCalledOnce());
      expect((await store.loadRun(run.id, context)).error).not.toBe('Pi assistant ended with aborted');
      expect(app.commit).not.toHaveBeenCalled();
      expect(app.rollback).toHaveBeenCalledOnce();
      expect(calls).toBe(3);
    } finally { await app.cleanup(); }
  });

  it('persists an actual Task producer failure instead of completed when the SDK resolves an assistant error', async () => {
    const app = await fixture(response('error', '', privateProviderError));
    try {
      const { store, context, run } = await runTask(app);
      await vi.waitFor(async () => expect((await store.loadRun(run.id, context)).status).toBe('failed'));
      expect(await store.loadRun(run.id, context)).toMatchObject({ status: 'failed', error: expect.stringContaining('Pi assistant ended with error') });
      expect(app.commit).not.toHaveBeenCalled();
      expect(app.rollback).toHaveBeenCalledOnce();
    } finally { await app.cleanup(); }
  });

  it('persists completed for a Task after the SDK recovers from its first assistant error', async () => {
    let calls = 0;
    const app = await fixture((...args) => ++calls === 1
      ? response('error', '', '429 synthetic refusal')(...args)
      : response('stop', 'Recovered successfully')(...args));
    try {
      const { store, context, run } = await runTask(app);
      await vi.waitFor(async () => expect((await store.loadRun(run.id, context)).status).toBe('completed'));
      expect(calls).toBe(2);
      expect((await store.loadRun(run.id, context)).error).toBeUndefined();
      expect(app.commit).toHaveBeenCalledOnce();
      expect(app.rollback).not.toHaveBeenCalled();
    } finally { await app.cleanup(); }
  });

  it('waits for a retry tool and subsequent assistant error before finalizing the actual Task', async () => {
    let calls = 0;
    let enteredFinalStream!: () => void;
    const finalStreamStarted = new Promise<void>(resolve => { enteredFinalStream = resolve; });
    let finishFinalStream!: () => Promise<void>;
    const app = await fixture((model, context, options) => {
      if (++calls === 1) return response('error', '', '429 synthetic refusal')(model, context, options);
      if (calls === 2) return response('toolUse', '', undefined,
        [{ type: 'toolCall', id: 'read-after-retry', name: 'read', arguments: { path: 'README.md' } }])(model, context, options);
      const stream = createAssistantMessageEventStream();
      const finish = async (reason: 'error' | 'aborted') => {
        for await (const event of await response(reason, '', privateProviderError)(model, context, options)) stream.push(event);
      };
      finishFinalStream = () => finish('error');
      options?.signal?.addEventListener('abort', () => { void finish('aborted'); }, { once: true });
      enteredFinalStream();
      return stream;
    });
    fs.writeFileSync(path.join(new URL(app.input.config.workspace).pathname, 'README.md'), 'Read fixture only');
    try {
      const { store, context, run } = await runTask(app);
      await app.promptResolved;
      await finalStreamStarted;
      expect(app.sessions[0].isStreaming).toBe(true);
      await finishFinalStream();
      await vi.waitFor(async () => expect((await store.loadRun(run.id, context)).status).toBe('failed'));
      expect(await store.loadRun(run.id, context)).toMatchObject({ status: 'failed', error: expect.stringContaining('Pi assistant ended with error') });
      expect(calls).toBe(3);
      expect(app.commit).not.toHaveBeenCalled();
      expect(app.rollback).toHaveBeenCalledOnce();
    } finally { await app.cleanup(); }
  });

  it('keeps the approval requested after an SDK retry instead of closing the Task as completed', async () => {
    let calls = 0;
    const approval = { target: 'https://pod.test/work/output.txt', action: 'http://www.w3.org/ns/odrl/2/write',
      risk: 'low' as const, description: 'Write the approved confirmation file' };
    const app = await fixture((...args) => ++calls === 1
      ? response('error', '', '429 synthetic refusal')(...args)
      : response('toolUse', '', undefined,
        [{ type: 'toolCall', id: 'approval-after-retry', name: 'request_approval', arguments: approval }])(...args));
    try {
      const { store, context, run } = await runTask(app);
      await vi.waitFor(async () => expect((await store.loadRun(run.id, context)).status).toBe('waiting_input'));
      expect(store.approvals).toEqual([expect.objectContaining({ toolCallId: 'approval-after-retry', status: 'pending' })]);
      expect(app.commit).toHaveBeenCalledOnce();
      expect(app.rollback).not.toHaveBeenCalled();
    } finally { await app.cleanup(); }
  });

  it('waits through another retry after a real tool until the SDK exhausts that retry', async () => {
    let calls = 0;
    const app = await fixture((...args) => ++calls === 2
      ? response('toolUse', '', undefined,
        [{ type: 'toolCall', id: 'read-before-exhaustion', name: 'read', arguments: { path: 'README.md' } }])(...args)
      : response('error', '', '429 synthetic refusal')(...args));
    fs.writeFileSync(path.join(new URL(app.input.config.workspace).pathname, 'README.md'), 'Read fixture only');
    try {
      const { store, context, run } = await runTask(app);
      await vi.waitFor(async () => expect((await store.loadRun(run.id, context)).status).toBe('failed'));
      expect((await store.loadRun(run.id, context)).error).toContain('Pi assistant ended with error');
      expect(calls).toBe(4);
      expect(app.lifecycle.filter(type => type === 'auto_retry_start')).toHaveLength(2);
      expect(app.commit).not.toHaveBeenCalled();
      expect(app.rollback).toHaveBeenCalledOnce();
    } finally { await app.cleanup(); }
  });

  it('releases the SDK lifecycle wait when its owner cancels during the retry gap after a tool', async () => {
    let calls = 0;
    let retries = 0;
    const controller = new AbortController();
    const gaps: Array<{ streaming: boolean; retrying: boolean }> = [];
    const app = await fixture((...args) => ++calls === 2
      ? response('toolUse', '', undefined,
        [{ type: 'toolCall', id: 'read-before-gap-cancel', name: 'read', arguments: { path: 'README.md' } }])(...args)
      : response('error', '', '429 synthetic refusal')(...args), session => {
      session.subscribe(event => {
        if (event.type === 'auto_retry_start' && ++retries === 2) {
          // Cancel after the SDK installs its retry abort controller, before its delay completes.
          queueMicrotask(() => {
            gaps.push({ streaming: session.isStreaming, retrying: session.isRetrying });
            controller.abort();
          });
        }
      });
    });
    fs.writeFileSync(path.join(new URL(app.input.config.workspace).pathname, 'README.md'), 'Read fixture only');
    app.input.signal = controller.signal;
    try {
      expect(await drain(app)).toEqual([]);
      expect(gaps).toEqual([{ streaming: false, retrying: true }]);
      expect(calls).toBe(3);
      expect(app.commit).not.toHaveBeenCalled();
      expect(app.rollback).toHaveBeenCalledOnce();
    } finally { await app.cleanup(); }
  });
});
