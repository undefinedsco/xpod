import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { ChatKitService } from '../../src/api/chatkit/service';
import { InMemoryStore, type StoreContext } from '../../src/api/chatkit/store';
import {
  InngestRunExecutionBackend,
  XPOD_RUN_CONTINUE_REQUESTED_EVENT,
  XPOD_RUN_REQUESTED_EVENT,
} from '../../src/api/runs/InngestRunExecutionBackend';
import { PiAgentRuntimeDriver } from '../../src/api/runs/PiAgentRuntimeDriver';
import { RunAuthContextRegistry } from '../../src/api/runs/RunAuthContextRegistry';
import { RunStepType, RunStatus, XpodRunStepType } from '../../src/api/runs/schema';
import { extractResourceLocalId, generateRunResourceId, generateRunStepResourceId, resolveRunUrn } from '../../src/api/runs/store';
import type { RunExecutionBackend, RunExecutionInput } from '../../src/api/runs/RunExecutionBackend';
import type { AgentRuntimeEvent } from '../../src/api/runs/AgentRuntimeTypes';
import type { AiProvider } from '../../src/api/chatkit/service';
import { generateId, nowTimestamp, toThreadRef } from '../../src/api/chatkit/types';
import { TaskAuthBindingService } from '../../src/api/tasks';
import { LocalSolidFS, type MaterializedWorkspace, type SolidFS, type SolidFsPrepareInput } from '../../src/solidfs';

const workspaceRef = `file://localhost${process.cwd()}`;

const {
  piSdkMock,
  createAgentSessionMock,
  createCodingToolsMock,
  createReadOnlyToolsMock,
  reloadMock,
  replaceMessagesMock,
  promptMock,
  subscribeMock,
  disposeMock,
  sessionManagerInMemoryMock,
  sessionManagerCreateMock,
} = vi.hoisted(() => {
  const replaceMessagesMock = vi.fn();
  const promptMock = vi.fn(async () => undefined);
  const subscribeMock = vi.fn(() => () => undefined);
  const disposeMock = vi.fn();

  const createAgentSessionMock = vi.fn(async () => ({
      session: {
        agent: { replaceMessages: replaceMessagesMock },
        subscribe: subscribeMock,
        prompt: promptMock,
        dispose: disposeMock,
      },
    }));
  const createCodingToolsMock = vi.fn(() => [{ name: 'read' }, { name: 'bash' }, { name: 'edit' }, { name: 'write' }]);
  const createReadOnlyToolsMock = vi.fn(() => [{ name: 'read' }, { name: 'grep' }, { name: 'find' }, { name: 'ls' }]);
  const reloadMock = vi.fn(async () => undefined);
  const sessionManagerInMemoryMock = vi.fn(() => ({ kind: 'memory-session' }));
  const sessionManagerCreateMock = vi.fn(() => ({ kind: 'file-session' }));

  class AuthStorageMock {
    static inMemory() {
      return new AuthStorageMock();
    }

    setRuntimeApiKey() {}
  }

  class ModelRegistryMock {
    constructor() {}

    registerProvider() {}
  }

  class SettingsManagerMock {
    static inMemory(settings?: unknown) {
      return { settings };
    }
  }

  class DefaultResourceLoaderMock {
    public readonly options: unknown;

    constructor(options: unknown) {
      this.options = options;
    }

    reload = reloadMock;
  }

  const joinPath = (cwd: string, filePath: string): string => `${cwd.replace(/\/+$/u, '')}/${filePath.replace(/^\/+/u, '')}`;
  const dirname = (filePath: string): string => {
    const slash = filePath.lastIndexOf('/');
    return slash <= 0 ? '/' : filePath.slice(0, slash);
  };

  const piSdkMock = {
    AuthStorage: AuthStorageMock,
    DefaultResourceLoader: DefaultResourceLoaderMock,
    ModelRegistry: ModelRegistryMock,
    SessionManager: {
      inMemory: sessionManagerInMemoryMock,
      create: sessionManagerCreateMock,
    },
    SettingsManager: SettingsManagerMock,
    createCodingTools: createCodingToolsMock,
    createReadOnlyTools: createReadOnlyToolsMock,
    createReadTool: vi.fn((cwd: string, options?: any) => ({
      name: 'read',
      cwd,
      options,
      execute: async (_id: string, params: { path: string }, _signal?: AbortSignal) => ({
        content: [{
          type: 'text',
          text: (await options.operations.readFile(joinPath(cwd, params.path))).toString('utf8'),
        }],
      }),
    })),
    createBashTool: vi.fn((cwd: string) => ({ name: 'bash', cwd })),
    createEditTool: vi.fn((cwd: string, options?: any) => ({ name: 'edit', cwd, options })),
    createWriteTool: vi.fn((cwd: string, options?: any) => ({
      name: 'write',
      cwd,
      options,
      execute: async (_id: string, params: { path: string; content: string }, _signal?: AbortSignal) => {
        const target = joinPath(cwd, params.path);
        await options.operations.mkdir(dirname(target));
        await options.operations.writeFile(target, params.content);
        return { content: [{ type: 'text', text: 'written' }] };
      },
    })),
    createAgentSession: createAgentSessionMock,
  };

  return {
    piSdkMock,
    createAgentSessionMock,
    createCodingToolsMock,
    createReadOnlyToolsMock,
    reloadMock,
    replaceMessagesMock,
    promptMock,
    subscribeMock,
    disposeMock,
    sessionManagerInMemoryMock,
    sessionManagerCreateMock,
  };
});

class RecordingInngestClient {
  public sent: unknown[] = [];

  public async send(payload: unknown): Promise<{ ids: string[] }> {
    this.sent.push(payload);
    return { ids: ['evt-test'] };
  }

  public createFunction(options: unknown, handler: unknown): { options: unknown; handler: unknown } {
    return { options, handler };
  }
}

class WorkspaceAgentDriver implements RunExecutionBackend {
  public inputs: RunExecutionInput[] = [];

  public async *start(input: RunExecutionInput): AsyncIterable<AgentRuntimeEvent> {
    this.inputs.push(input);
    yield { type: 'text', text: `workspace:${input.config.workspace}:` };
    yield { type: 'text', text: input.prompt };
  }
}

class ToolCallThenTextDriver implements RunExecutionBackend {
  public inputs: RunExecutionInput[] = [];

  public async *start(input: RunExecutionInput): AsyncIterable<AgentRuntimeEvent> {
    this.inputs.push(input);
    if (!input.continuation) {
      yield {
        type: 'tool_call',
        requestId: 'client_tool_1',
        name: 'pick_file',
        arguments: JSON.stringify({ prompt: 'choose file' }),
      };
      return;
    }
    yield { type: 'text', text: `resumed:${input.continuation.itemId}` };
  }
}

class SlowTextDriver implements RunExecutionBackend {
  public inputs: RunExecutionInput[] = [];
  private releaseText?: () => void;

  public async *start(input: RunExecutionInput): AsyncIterable<AgentRuntimeEvent> {
    this.inputs.push(input);
    yield { type: 'text', text: 'before-cancel' };
    await new Promise<void>((resolve) => {
      this.releaseText = resolve;
    });
    yield { type: 'text', text: 'after-cancel' };
  }

  public release(): void {
    this.releaseText?.();
  }
}

class RecordingSolidFS implements SolidFS {
  public prepareInputs: SolidFsPrepareInput[] = [];
  public commits = 0;
  public rollbacks = 0;
  public hydrated: string[] = [];

  public constructor(
    private readonly cwd: string,
    private readonly projection: SolidFsPrepareInput['projection'] = 'direct',
  ) {}

  public async prepare(input: SolidFsPrepareInput): Promise<MaterializedWorkspace> {
    this.prepareInputs.push(input);
    const projection = input.projection ?? this.projection ?? 'direct';
    const workspace: MaterializedWorkspace = {
      cwd: this.cwd,
      manifest: {
        workspace: input.workspace,
        cwd: this.cwd,
        projection,
        entries: [],
      },
      hydrate: projection === 'hydrated-object'
        ? async (relativePath: string) => {
          this.hydrated.push(relativePath);
          fs.mkdirSync(path.dirname(path.join(this.cwd, relativePath)), { recursive: true });
          fs.writeFileSync(path.join(this.cwd, relativePath), `hydrated:${relativePath}`, 'utf8');
          return {
            path: relativePath,
            source: 'object',
            sourcePath: path.join(this.cwd, relativePath),
            projection,
            state: 'clean',
          };
        }
        : undefined,
      commit: async () => {
        this.commits += 1;
        return {
          workspace: input.workspace,
          cwd: this.cwd,
          projection,
          entries: [],
        };
      },
      rollback: async () => {
        this.rollbacks += 1;
      },
    };
    return workspace;
  }
}

function parseSseDataLines(chunks: Uint8Array[]): any[] {
  const text = Buffer.concat(chunks).toString('utf-8');
  const events: any[] = [];
  for (const block of text.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data:')) continue;
    const json = line.slice('data:'.length).trim();
    if (json) events.push(JSON.parse(json));
  }
  return events;
}

function assistantText(events: any[]): string {
  return events
    .filter((event) => event.type === 'thread.item.updated')
    .map((event) => event.update?.delta ?? '')
    .join('');
}

describe('Managed Agents Inngest Chat backend', () => {
  beforeEach(() => {
    createAgentSessionMock.mockClear();
    createCodingToolsMock.mockClear();
    createReadOnlyToolsMock.mockClear();
    reloadMock.mockClear();
    replaceMessagesMock.mockClear();
    promptMock.mockClear();
    subscribeMock.mockClear();
    disposeMock.mockClear();
    sessionManagerInMemoryMock.mockClear();
    sessionManagerCreateMock.mockClear();
  });

  it('routes a workspace agent chat through Inngest before executing the runtime driver', async () => {
    const store = new InMemoryStore<StoreContext>();
    const driver = new WorkspaceAgentDriver();
    const inngestClient = new RecordingInngestClient();
    const backend = new InngestRunExecutionBackend({
      client: inngestClient as any,
      runtimeDriver: driver,
      executeInline: true,
    });
    const aiProvider: AiProvider = {
      async *streamResponse() {
        throw new Error('aiProvider should not be used for workspace agent chat');
      },
    };
    const service = new ChatKitService<StoreContext>({
      store,
      aiProvider,
      enableAgentRuntime: true,
      runExecutionBackend: backend,
    });

    const result = await service.process(JSON.stringify({
      type: 'threads.create',
      params: {
        workspace: workspaceRef,
        input: {
          content: [{ type: 'input_text', text: 'hello managed agents' }],
        },
      },
      metadata: {
        runtime: {
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
    }), { userId: 'u1' });

    expect(result.type).toBe('streaming');
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.type === 'streaming' ? result.stream() : []) {
      chunks.push(chunk);
    }
    const events = parseSseDataLines(chunks);

    expect(inngestClient.sent).toHaveLength(1);
    expect((inngestClient.sent[0] as any).name).toBe('xpod/run.requested');
    expect((inngestClient.sent[0] as any).data.runId).toMatch(/^chat\/default\/\d{4}\/\d{2}\/\d{2}\/runs\.ttl#run_/);
    expect(driver.inputs).toHaveLength(1);
    expect(driver.inputs[0].runId).toBe((inngestClient.sent[0] as any).data.runId);
    expect(driver.inputs[0].prompt).toBe('hello managed agents');
    expect(driver.inputs[0].config.workspace).toBe(workspaceRef);
    expect(assistantText(events)).toBe(`workspace:${workspaceRef}:hello managed agents`);
    expect(events.some((event) => event.type === 'thread.item.done' && event.item?.type === 'assistant_message')).toBe(true);
  });

  it('does not start the pending inline runtime twice for duplicate callbacks', async () => {
    const driver = new WorkspaceAgentDriver();
    const backend = new InngestRunExecutionBackend({
      client: new RecordingInngestClient() as any,
      runtimeDriver: driver,
      executeInline: true,
    });
    const input: RunExecutionInput = {
      runId: 'chat/default/2026/05/18/runs.ttl#run_pending_dup',
      threadId: 'thread_pending_dup',
      prompt: 'pending duplicate',
      conversation: [],
      config: {
        workspace: workspaceRef,
        runner: { type: 'codex', protocol: 'acp' },
      },
    };
    const events: AgentRuntimeEvent[] = [];
    const stream = (async () => {
      for await (const event of backend.start(input)) {
        events.push(event);
      }
    })();
    const ctx = {
      event: {
        id: input.runId,
        name: 'xpod/run.requested',
        data: { runId: input.runId, threadId: input.threadId },
      },
      runId: `test:${input.runId}`,
      step: { run: async (_id: string, fn: Function) => fn() },
    };

    while ((backend as any).pendingRuns?.size !== 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const first = await (backend.agentRunFunction as any).handler(ctx);
    const second = await (backend.agentRunFunction as any).handler(ctx);
    await stream;

    expect(first).toEqual({ runId: input.runId, status: 'completed' });
    expect(second).toEqual({ runId: input.runId, status: 'skipped' });
    expect(driver.inputs).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(['text', 'text']);
  });

  it('persists Run and RunStep facts for a chat runtime execution', async () => {
    const store = new InMemoryStore<StoreContext>();
    const driver = new WorkspaceAgentDriver();
    const inngestClient = new RecordingInngestClient();
    const backend = new InngestRunExecutionBackend({
      client: inngestClient as any,
      runtimeDriver: driver,
      executeInline: true,
    });
    const service = new ChatKitService<StoreContext>({
      store,
      enableAgentRuntime: true,
      runExecutionBackend: backend,
    });
    const context = {
      userId: 'u1',
      auth: {
        type: 'solid',
        webId: 'http://localhost/alice/profile/card#me',
      },
    };

    const result = await service.process(JSON.stringify({
      type: 'threads.create',
      params: {
        workspace: workspaceRef,
        input: {
          content: [{ type: 'input_text', text: 'persist run facts' }],
        },
      },
      metadata: {
        runtime: {
          runner: { type: 'codex', protocol: 'pi' },
        },
      },
    }), context);

    for await (const _chunk of result.type === 'streaming' ? result.stream() : []) {
      // drain
    }

    const runId = (inngestClient.sent[0] as any).data.runId as string;
    const run = await store.loadRun(runId, context);
    const events = await store.loadRunSteps(runId, context);

    expect(run).toMatchObject({
      id: runId,
      commandKind: 'chat',
      status: RunStatus.COMPLETED,
      workspace: workspaceRef,
      runner: 'pi:codex',
      prompt: 'persist run facts',
      thread: 'http://localhost/alice/.data/' + (run.metadata?.threadId as string),
    });
    expect(extractResourceLocalId(run.id)).toMatch(/^run_/);
    expect(events.map((event) => event.type)).toEqual([
      RunStepType.CREATED,
      RunStepType.STARTED,
      RunStepType.TEXT_DELTA,
      RunStepType.TEXT_DELTA,
      RunStepType.COMPLETED,
    ]);
    expect(events[2].data).toEqual({ delta: `workspace:${workspaceRef}:` });
  });

  it('continues inline execution when local durable Inngest delivery is unavailable', async () => {
    const store = new InMemoryStore<StoreContext>();
    const driver = new WorkspaceAgentDriver();
    const inngestClient = new RecordingInngestClient();
    const backend = new InngestRunExecutionBackend({
      client: inngestClient as any,
      runtimeDriver: driver,
      durableDelivery: false,
      executeInline: true,
    });
    const service = new ChatKitService<StoreContext>({
      store,
      aiProvider: {
        async *streamResponse() {
          throw new Error('aiProvider should not be used for workspace agent chat');
        },
      },
      enableAgentRuntime: true,
      runExecutionBackend: backend,
    });

    const result = await service.process(JSON.stringify({
      type: 'threads.create',
      params: {
        workspace: workspaceRef,
        input: {
          content: [{ type: 'input_text', text: 'local fallback' }],
        },
      },
      metadata: {
        runtime: {
          runner: { type: 'codex', protocol: 'pi' },
        },
      },
    }), { userId: 'u1' });

    const chunks: Uint8Array[] = [];
    for await (const chunk of result.type === 'streaming' ? result.stream() : []) {
      chunks.push(chunk);
    }

    expect(inngestClient.sent).toHaveLength(0);
    expect(driver.inputs).toHaveLength(1);
    expect(assistantText(parseSseDataLines(chunks))).toBe(`workspace:${workspaceRef}:local fallback`);
  });

  it('sends a continuation event for a paused Run without allocating a new Run id', async () => {
    const driver = new WorkspaceAgentDriver();
    const inngestClient = new RecordingInngestClient();
    const backend = new InngestRunExecutionBackend({
      client: inngestClient as any,
      runtimeDriver: driver,
      durableDelivery: true,
      executeInline: false,
    });
    const input: RunExecutionInput = {
      runId: 'chat/default/2026/05/19/runs.ttl#run_continue',
      threadId: 'chat/default/index.ttl#thread_continue',
      prompt: 'Continue the previous run after client tool output.',
      conversation: [],
      config: {
        workspace: workspaceRef,
        runner: { type: 'codex', protocol: 'acp' },
      },
      continuation: {
        kind: 'client_tool_output',
        itemId: 'client_tool_call_1',
      },
    };

    const events: AgentRuntimeEvent[] = [];
    for await (const event of backend.start(input)) {
      events.push(event);
    }

    expect(events).toEqual([]);
    expect(driver.inputs).toHaveLength(0);
    expect(inngestClient.sent).toHaveLength(1);
    const payload = inngestClient.sent[0] as any;
    expect(payload.name).toBe(XPOD_RUN_CONTINUE_REQUESTED_EVENT);
    expect(payload.name).not.toBe(XPOD_RUN_REQUESTED_EVENT);
    expect(payload.data).toMatchObject({
      runId: input.runId,
      threadId: input.threadId,
      continuation: input.continuation,
    });
    expect(payload.id).toBe(`run:${input.runId}:continue:client_tool_output:client_tool_call_1`);
    expect(payload.data.executionKey).toBe(payload.id);
  });

  it('does not serialize Pod access secrets into durable Inngest run events', async () => {
    const driver = new WorkspaceAgentDriver();
    const inngestClient = new RecordingInngestClient();
    const backend = new InngestRunExecutionBackend({
      client: inngestClient as any,
      runtimeDriver: driver,
      durableDelivery: true,
      executeInline: false,
    });

    for await (const _event of backend.start({
      runId: 'chat/default/2026/05/19/runs.ttl#run_no_secret',
      threadId: 'chat/default/index.ttl#thread_no_secret',
      prompt: 'no secret',
      conversation: [],
      config: {
        workspace: workspaceRef,
        runner: { type: 'codex', protocol: 'acp' },
      },
      context: {
        userId: 'alice',
        auth: {
          type: 'solid',
          webId: 'http://localhost/alice/profile/card#me',
          clientId: 'client-id',
          clientSecret: 'client-secret',
          accessToken: 'access-token',
        },
      },
    } as RunExecutionInput)) {
      // no inline events
    }

    const payload = inngestClient.sent[0] as any;
    expect(payload.data.webId).toBe('http://localhost/alice/profile/card#me');
    expect(JSON.stringify(payload)).not.toContain('client-secret');
    expect(JSON.stringify(payload)).not.toContain('access-token');
    expect(payload.data.storeAuth).toBeUndefined();
  });

  it('serializes only auth binding ids for durable task Run events', async () => {
    const driver = new WorkspaceAgentDriver();
    const inngestClient = new RecordingInngestClient();
    const backend = new InngestRunExecutionBackend({
      client: inngestClient as any,
      runtimeDriver: driver,
      durableDelivery: true,
      executeInline: false,
    });

    for await (const _event of backend.start({
      runId: 'task/secretary/2026/05/19/runs.ttl#run_auth_binding',
      threadId: 'task/secretary/index.ttl#thread_auth_binding',
      prompt: 'use binding',
      conversation: [],
      config: {
        workspace: workspaceRef,
        runner: { type: 'codex', protocol: 'acp' },
      },
      authBindingId: 'task-auth-existing',
      context: {
        userId: 'alice',
        auth: {
          type: 'solid',
          webId: 'http://localhost/alice/profile/card#me',
          clientId: 'client-id',
          clientSecret: 'client-secret',
          accessToken: 'access-token',
        },
      },
    } as RunExecutionInput)) {
      // no inline events
    }

    const payload = inngestClient.sent[0] as any;
    expect(payload.data).toMatchObject({
      runId: 'task/secretary/2026/05/19/runs.ttl#run_auth_binding',
      threadId: 'task/secretary/index.ttl#thread_auth_binding',
      authBindingId: 'task-auth-existing',
      webId: 'http://localhost/alice/profile/card#me',
    });
    expect(JSON.stringify(payload)).not.toContain('client-secret');
    expect(JSON.stringify(payload)).not.toContain('access-token');
  });

  it('restores durable Run callbacks through the server auth context registry without queue secrets', async () => {
    const store = new InMemoryStore<StoreContext>();
    const driver = new WorkspaceAgentDriver();
    const registry = new RunAuthContextRegistry();
    const context: StoreContext = {
      userId: 'alice',
      auth: {
        type: 'solid',
        webId: 'http://localhost/alice/profile/card#me',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        accessToken: 'access-token',
      },
    };
    const inngestClient = new RecordingInngestClient();
    const backend = new InngestRunExecutionBackend({
      client: inngestClient as any,
      runtimeDriver: driver,
      store,
      contextRecorder: (ctx) => registry.remember(ctx),
      contextResolver: (data) => registry.resolve({ webId: data.webId }),
      durableDelivery: true,
      executeInline: false,
    });
    const now = nowTimestamp();
    const thread = {
      id: 'chat/default/index.ttl#thread_registry_restore',
      status: { type: 'active' as const },
      workspace: workspaceRef,
      created_at: now,
      updated_at: now,
      metadata: {
        runtime: {
          workspace: workspaceRef,
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
    };
    const threadRef = toThreadRef({ thread_id: thread.id });
    await store.saveThread(thread, context);
    await store.addThreadItem(threadRef, {
      id: 'user_msg_registry_restore',
      thread_id: thread.id,
      type: 'user_message',
      content: [{ type: 'input_text', text: 'registry restore' }],
      created_at: now,
    }, context);
    const runId = generateRunResourceId({
      key: generateId('run'),
      commandKind: 'chat',
      surfaceId: 'default',
      createdAt: now,
    });
    await store.saveRun({
      id: runId,
      commandKind: 'chat',
      surfaceId: 'default',
      thread: thread.id,
      workspace: workspaceRef,
      status: RunStatus.QUEUED,
      runner: 'acp:codex',
      prompt: 'registry restore',
      metadata: {
        userMessageId: 'user_msg_registry_restore',
        runtimeConfig: {
          workspace: workspaceRef,
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
      createdAt: now,
      updatedAt: now,
    }, context);

    for await (const _event of backend.start({
      runId,
      threadId: thread.id,
      prompt: 'registry restore',
      conversation: [],
      config: {
        workspace: workspaceRef,
        runner: { type: 'codex', protocol: 'acp' },
      },
      context,
    } as RunExecutionInput)) {
      // durable-only send path
    }

    const payload = inngestClient.sent[0] as any;
    expect(payload.data.webId).toBe(context.auth.webId);
    expect(JSON.stringify(payload)).not.toContain('client-secret');
    expect(JSON.stringify(payload)).not.toContain('access-token');

    const result = await (backend.agentRunFunction as any).handler({
      event: {
        id: payload.id,
        name: payload.name,
        data: payload.data,
      },
      runId: `test:${payload.id}`,
      step: { run: async (_id: string, fn: Function) => fn() },
    });

    expect(result).toEqual({ runId, status: RunStatus.COMPLETED });
    expect(driver.inputs).toHaveLength(1);
    expect((await store.loadRun(runId, context)).status).toBe(RunStatus.COMPLETED);
  });

  it('restores durable Run callbacks through Pod task auth credentials', async () => {
    const store = new InMemoryStore<StoreContext>();
    const driver = new WorkspaceAgentDriver();
    const authService = new TaskAuthBindingService({ repository: store });
    const context: StoreContext = {
      userId: 'alice',
      auth: {
        type: 'solid',
        webId: 'http://localhost/alice/profile/card#me',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        accessToken: 'access-token',
      },
    };
    const authBinding = await authService.createBinding({
      id: 'task-auth-durable',
      displayName: 'Durable task key',
    }, context);
    const registry = new RunAuthContextRegistry();
    registry.remember(context);
    const inngestClient = new RecordingInngestClient();
    const backend = new InngestRunExecutionBackend({
      client: inngestClient as any,
      runtimeDriver: driver,
      store,
      contextRecorder: (ctx) => registry.remember(ctx),
      contextResolver: async (data) => {
        const fallback = registry.resolve({ webId: data.webId });
        if (data.authBindingId && fallback) {
          return await authService.resolveRunContext(data.authBindingId, fallback) ?? fallback;
        }
        return fallback;
      },
      durableDelivery: true,
      executeInline: false,
    });
    const now = nowTimestamp();
    const thread = {
      id: 'task/secretary/index.ttl#thread_auth_restore',
      status: { type: 'active' as const },
      workspace: workspaceRef,
      created_at: now,
      updated_at: now,
      metadata: {
        commandKind: 'task',
        runtime: {
          workspace: workspaceRef,
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
    };
    const threadRef = toThreadRef({ thread_id: thread.id });
    await store.saveThread(thread, context);
    await store.addThreadItem(threadRef, {
      id: 'user_msg_auth_restore',
      thread_id: thread.id,
      type: 'user_message',
      content: [{ type: 'input_text', text: 'auth restore' }],
      created_at: now,
    }, context);
    const runId = generateRunResourceId({
      key: generateId('run'),
      commandKind: 'task',
      surfaceId: 'secretary',
      createdAt: now,
    });
    await store.saveRun({
      id: runId,
      commandKind: 'task',
      surfaceId: 'secretary',
      thread: thread.id,
      workspace: workspaceRef,
      status: RunStatus.QUEUED,
      runner: 'acp:codex',
      prompt: 'auth restore',
      metadata: {
        authBinding,
        authBindingId: authBinding.id,
        userMessageId: 'user_msg_auth_restore',
        runtimeConfig: {
          workspace: workspaceRef,
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
      createdAt: now,
      updatedAt: now,
    }, context);

    for await (const _event of backend.start({
      runId,
      threadId: thread.id,
      prompt: 'auth restore',
      conversation: [],
      config: {
        workspace: workspaceRef,
        runner: { type: 'codex', protocol: 'acp' },
      },
      authBindingId: authBinding.id,
      context,
    } as RunExecutionInput)) {
      // durable-only send path
    }

    const payload = inngestClient.sent[0] as any;
    expect(payload.data.authBindingId).toBe(authBinding.id);
    expect(JSON.stringify(payload)).not.toContain('client-secret');
    expect(JSON.stringify(payload)).not.toContain('access-token');

    const result = await (backend.agentRunFunction as any).handler({
      event: {
        id: payload.id,
        name: payload.name,
        data: payload.data,
      },
      runId: `test:${payload.id}`,
      step: { run: async (_id: string, fn: Function) => fn() },
    });

    expect(result).toEqual({ runId, status: RunStatus.COMPLETED });
    expect(driver.inputs).toHaveLength(1);
    expect(driver.inputs[0].context?.auth).toMatchObject({
      type: 'solid',
      webId: 'http://localhost/alice/profile/card#me',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      viaApiKey: true,
    });
  });

  it('restores and executes an Inngest run from store without a pending stream', async () => {
    const store = new InMemoryStore<StoreContext>();
    const driver = new WorkspaceAgentDriver();
    const context = { userId: 'u1' };
    const backend = new InngestRunExecutionBackend({
      client: new RecordingInngestClient() as any,
      runtimeDriver: driver,
      store,
      contextResolver: () => context,
      durableDelivery: true,
      executeInline: false,
    });

    const now = nowTimestamp();
    const thread = {
      id: 'chat/default/index.ttl#thread_store_restore',
      status: { type: 'active' as const },
      workspace: workspaceRef,
      created_at: now,
      updated_at: now,
      metadata: {
        runtime: {
          workspace: workspaceRef,
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
    };
    const threadRef = toThreadRef({ thread_id: thread.id });
    await store.saveThread(thread, context);
    const userMessage = {
      id: 'user_msg_store_restore',
      thread_id: thread.id,
      type: 'user_message' as const,
      content: [{ type: 'input_text' as const, text: 'stored callback' }],
      created_at: now,
    };
    await store.addThreadItem(threadRef, userMessage, context);
    const runId = generateRunResourceId({
      key: generateId('run'),
      commandKind: 'chat',
      surfaceId: 'default',
      createdAt: now,
    });
    await store.saveRun({
      id: runId,
      commandKind: 'chat',
      surfaceId: 'default',
      thread: thread.id,
      workspace: workspaceRef,
      status: RunStatus.QUEUED,
      runner: 'acp:codex',
      prompt: 'stored callback',
      metadata: {
        threadId: thread.id,
        userMessageId: userMessage.id,
        runtimeConfig: {
          workspace: workspaceRef,
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
      createdAt: now,
      updatedAt: now,
    }, context);
    await store.appendRunStep({
      id: generateRunStepResourceId({
        key: 'run-step_created',
        runId,
        commandKind: 'chat',
        surfaceId: 'default',
        createdAt: now,
      }),
      commandKind: 'chat',
      surfaceId: 'default',
      runId,
      run: resolveRunUrn(runId),
      type: RunStepType.CREATED,
      message: 'Run created',
      createdAt: now,
    }, context);
    const run = await store.loadRun(runId, context);

    expect(driver.inputs).toHaveLength(0);
    expect(run.status).toBe(RunStatus.QUEUED);

    const handlerResult = await (backend.agentRunFunction as any).handler({
      event: {
        id: run.id,
        name: 'xpod/run.requested',
        data: {
          runId: run.id,
          threadId: thread.id,
        },
      },
      runId: `test:${run.id}`,
      step: {
        run: async (_id: string, fn: Function) => fn(),
      },
    });

    expect(handlerResult).toEqual({ runId: run.id, status: RunStatus.COMPLETED });
    expect(driver.inputs).toHaveLength(1);
    expect(driver.inputs[0]).toMatchObject({
      runId: run.id,
      threadId: thread.id,
      prompt: 'stored callback',
      config: {
        workspace: workspaceRef,
        runner: { type: 'codex', protocol: 'acp' },
      },
      conversation: [],
    });

    const completedRun = await store.loadRun(run.id, context);
    expect(completedRun.status).toBe(RunStatus.COMPLETED);
    const steps = await store.loadRunSteps(run.id, context);
    expect(steps.map((event) => event.type)).toEqual([
      RunStepType.CREATED,
      RunStepType.STARTED,
      RunStepType.TEXT_DELTA,
      RunStepType.TEXT_DELTA,
      RunStepType.COMPLETED,
    ]);
    const items = await store.loadThreadItems(threadRef, undefined, 50, 'asc', context);
    const assistant = items.data.find((item) => item.type === 'assistant_message') as any;
    expect(assistant?.content?.[0]?.text).toBe(`workspace:${workspaceRef}:stored callback`);
  });

  it('claims a stored Run so duplicate Inngest callbacks do not execute twice', async () => {
    const store = new InMemoryStore<StoreContext>();
    const driver = new WorkspaceAgentDriver();
    const context = { userId: 'u1' };
    const backend = new InngestRunExecutionBackend({
      client: new RecordingInngestClient() as any,
      runtimeDriver: driver,
      store,
      contextResolver: () => context,
      durableDelivery: true,
      executeInline: false,
    });
    const now = nowTimestamp();
    const thread = {
      id: 'chat/default/index.ttl#thread_claim',
      status: { type: 'active' as const },
      workspace: workspaceRef,
      created_at: now,
      updated_at: now,
      metadata: {
        runtime: {
          workspace: workspaceRef,
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
    };
    const threadRef = toThreadRef({ thread_id: thread.id });
    await store.saveThread(thread, context);
    await store.addThreadItem(threadRef, {
      id: 'user_msg_claim',
      thread_id: thread.id,
      type: 'user_message',
      content: [{ type: 'input_text', text: 'claim once' }],
      created_at: now,
    }, context);
    const runId = generateRunResourceId({
      key: generateId('run'),
      commandKind: 'chat',
      surfaceId: 'default',
      createdAt: now,
    });
    await store.saveRun({
      id: runId,
      commandKind: 'chat',
      surfaceId: 'default',
      thread: thread.id,
      workspace: workspaceRef,
      status: RunStatus.QUEUED,
      runner: 'acp:codex',
      prompt: 'claim once',
      metadata: {
        userMessageId: 'user_msg_claim',
        runtimeConfig: {
          workspace: workspaceRef,
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
      createdAt: now,
      updatedAt: now,
    }, context);

    const ctx = {
      event: {
        id: runId,
        name: 'xpod/run.requested',
        data: { runId, threadId: thread.id },
      },
      runId: `test:${runId}`,
      step: { run: async (_id: string, fn: Function) => fn() },
    };

    const first = await (backend.agentRunFunction as any).handler(ctx);
    const second = await (backend.agentRunFunction as any).handler(ctx);

    expect(first).toEqual({ runId, status: RunStatus.COMPLETED });
    expect(second).toEqual({ runId, status: 'skipped' });
    expect(driver.inputs).toHaveLength(1);
  });

  it('recovers a stored running Run without an active lease from a durable Inngest callback', async () => {
    const store = new InMemoryStore<StoreContext>();
    const driver = new WorkspaceAgentDriver();
    const context = { userId: 'u1' };
    const backend = new InngestRunExecutionBackend({
      client: new RecordingInngestClient() as any,
      runtimeDriver: driver,
      store,
      contextResolver: () => context,
      durableDelivery: true,
      executeInline: false,
    });
    const now = nowTimestamp();
    const thread = {
      id: 'chat/default/index.ttl#thread_running_recover',
      status: { type: 'active' as const },
      workspace: workspaceRef,
      created_at: now,
      updated_at: now,
      metadata: {
        runtime: {
          workspace: workspaceRef,
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
    };
    const threadRef = toThreadRef({ thread_id: thread.id });
    await store.saveThread(thread, context);
    await store.addThreadItem(threadRef, {
      id: 'user_msg_running_recover',
      thread_id: thread.id,
      type: 'user_message',
      content: [{ type: 'input_text', text: 'recover running' }],
      created_at: now,
    }, context);
    const runId = generateRunResourceId({
      key: generateId('run'),
      commandKind: 'chat',
      surfaceId: 'default',
      createdAt: now,
    });
    await store.saveRun({
      id: runId,
      commandKind: 'chat',
      surfaceId: 'default',
      thread: thread.id,
      workspace: workspaceRef,
      status: RunStatus.RUNNING,
      runner: 'acp:codex',
      prompt: 'recover running',
      metadata: {
        userMessageId: 'user_msg_running_recover',
        runtimeConfig: {
          workspace: workspaceRef,
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
      createdAt: now,
      startedAt: now,
      heartbeatAt: now,
      updatedAt: now,
    }, context);

    const result = await (backend.agentRunFunction as any).handler({
      event: {
        id: runId,
        name: 'xpod/run.requested',
        data: { runId, threadId: thread.id },
      },
      runId: `test:${runId}`,
      step: { run: async (_id: string, fn: Function) => fn() },
    });

    expect(result).toEqual({ runId, status: RunStatus.COMPLETED });
    expect(driver.inputs).toHaveLength(1);
    const completed = await store.loadRun(runId, context);
    expect(completed.status).toBe(RunStatus.COMPLETED);
  });

  it('does not steal a running Run that still has an active worker lease', async () => {
    const store = new InMemoryStore<StoreContext>();
    const driver = new WorkspaceAgentDriver();
    const context = { userId: 'u1' };
    const backend = new InngestRunExecutionBackend({
      client: new RecordingInngestClient() as any,
      runtimeDriver: driver,
      store,
      contextResolver: () => context,
      durableDelivery: true,
      executeInline: false,
    });
    const now = nowTimestamp();
    const thread = {
      id: 'chat/default/index.ttl#thread_running_leased',
      status: { type: 'active' as const },
      workspace: workspaceRef,
      created_at: now,
      updated_at: now,
      metadata: {
        runtime: {
          workspace: workspaceRef,
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
    };
    const threadRef = toThreadRef({ thread_id: thread.id });
    await store.saveThread(thread, context);
    await store.addThreadItem(threadRef, {
      id: 'user_msg_running_leased',
      thread_id: thread.id,
      type: 'user_message',
      content: [{ type: 'input_text', text: 'do not steal' }],
      created_at: now,
    }, context);
    const runId = generateRunResourceId({
      key: generateId('run'),
      commandKind: 'chat',
      surfaceId: 'default',
      createdAt: now,
    });
    await store.saveRun({
      id: runId,
      commandKind: 'chat',
      surfaceId: 'default',
      thread: thread.id,
      workspace: workspaceRef,
      status: RunStatus.RUNNING,
      runner: 'acp:codex',
      prompt: 'do not steal',
      leaseOwner: 'other-worker',
      leaseExpiresAt: now + 300,
      heartbeatAt: now,
      metadata: {
        userMessageId: 'user_msg_running_leased',
        runtimeConfig: {
          workspace: workspaceRef,
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
      createdAt: now,
      startedAt: now,
      updatedAt: now,
    }, context);

    const result = await (backend.agentRunFunction as any).handler({
      event: {
        id: runId,
        name: 'xpod/run.requested',
        data: { runId, threadId: thread.id },
      },
      runId: `test:${runId}`,
      step: { run: async (_id: string, fn: Function) => fn() },
    });

    expect(result).toEqual({ runId, status: 'skipped' });
    expect(driver.inputs).toHaveLength(0);
    expect((await store.loadRun(runId, context)).status).toBe(RunStatus.RUNNING);
  });

  it('stops a stored Run when cancellation is requested during execution', async () => {
    const store = new InMemoryStore<StoreContext>();
    const driver = new SlowTextDriver();
    const context = { userId: 'u1' };
    const backend = new InngestRunExecutionBackend({
      client: new RecordingInngestClient() as any,
      runtimeDriver: driver,
      store,
      contextResolver: () => context,
      durableDelivery: true,
      executeInline: false,
    });
    const now = nowTimestamp();
    const thread = {
      id: 'chat/default/index.ttl#thread_cancel',
      status: { type: 'active' as const },
      workspace: workspaceRef,
      created_at: now,
      updated_at: now,
      metadata: {
        runtime: {
          workspace: workspaceRef,
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
    };
    const threadRef = toThreadRef({ thread_id: thread.id });
    await store.saveThread(thread, context);
    await store.addThreadItem(threadRef, {
      id: 'user_msg_cancel',
      thread_id: thread.id,
      type: 'user_message',
      content: [{ type: 'input_text', text: 'cancel me' }],
      created_at: now,
    }, context);
    const runId = generateRunResourceId({
      key: generateId('run'),
      commandKind: 'chat',
      surfaceId: 'default',
      createdAt: now,
    });
    await store.saveRun({
      id: runId,
      commandKind: 'chat',
      surfaceId: 'default',
      thread: thread.id,
      workspace: workspaceRef,
      status: RunStatus.QUEUED,
      runner: 'acp:codex',
      prompt: 'cancel me',
      metadata: {
        userMessageId: 'user_msg_cancel',
        runtimeConfig: {
          workspace: workspaceRef,
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
      createdAt: now,
      updatedAt: now,
    }, context);

    const execution = (backend.agentRunFunction as any).handler({
      event: {
        id: runId,
        name: 'xpod/run.requested',
        data: { runId, threadId: thread.id },
      },
      runId: `test:${runId}`,
      step: { run: async (_id: string, fn: Function) => fn() },
    });

    while (driver.inputs.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const running = await store.loadRun(runId, context);
    running.cancelRequestedAt = nowTimestamp();
    await store.saveRun(running, context);
    driver.release();

    const result = await execution;
    expect(result).toEqual({ runId, status: RunStatus.CANCELLED });
    const cancelled = await store.loadRun(runId, context);
    expect(cancelled.status).toBe(RunStatus.CANCELLED);
    const steps = await store.loadRunSteps(runId, context);
    expect(steps.map((step) => step.type)).toContain(RunStepType.CANCELLED);
    expect(steps.some((step) => step.type === RunStepType.TEXT_DELTA && step.message === 'after-cancel')).toBe(false);
  });

  it('honors cancellation during an inline ChatKit Run', async () => {
    const store = new InMemoryStore<StoreContext>();
    const driver = new SlowTextDriver();
    const backend = new InngestRunExecutionBackend({
      client: new RecordingInngestClient() as any,
      runtimeDriver: driver,
      durableDelivery: false,
      executeInline: true,
    });
    const service = new ChatKitService<StoreContext>({
      store,
      enableAgentRuntime: true,
      runExecutionBackend: backend,
    });
    const context = { userId: 'u1' };

    const result = await service.process(JSON.stringify({
      type: 'threads.create',
      params: {
        workspace: workspaceRef,
        input: {
          content: [{ type: 'input_text', text: 'cancel inline' }],
        },
      },
      metadata: {
        runtime: {
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
    }), context);

    const chunks: Uint8Array[] = [];
    const stream = (async () => {
      for await (const chunk of result.type === 'streaming' ? result.stream() : []) {
        chunks.push(chunk);
      }
    })();

    while (driver.inputs.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    const runId = driver.inputs[0].runId;
    const running = await store.loadRun(runId, context);
    running.cancelRequestedAt = nowTimestamp();
    await store.saveRun(running, context);
    driver.release();
    await stream;

    const events = parseSseDataLines(chunks);
    const cancelled = await store.loadRun(runId, context);
    expect(cancelled.status).toBe(RunStatus.CANCELLED);
    expect(assistantText(events)).toBe('before-cancel');
    expect(events.some((event) => event.type === 'error' && event.error?.code === 'runtime_cancelled')).toBe(true);
    const steps = await store.loadRunSteps(runId, context);
    expect(steps.some((step) => step.type === RunStepType.TEXT_DELTA && step.message === 'after-cancel')).toBe(false);
  });

  it('requires an explicit workspace on the thread', async () => {
    const store = new InMemoryStore<StoreContext>();
    const driver = new WorkspaceAgentDriver();
    const backend = new InngestRunExecutionBackend({
      client: new RecordingInngestClient() as any,
      runtimeDriver: driver,
      executeInline: true,
    });
    const service = new ChatKitService<StoreContext>({
      store,
      enableAgentRuntime: true,
      runExecutionBackend: backend,
    });

    const result = await service.process(JSON.stringify({
      type: 'threads.create',
      metadata: {
        runtime: {
          runner: { type: 'pi', protocol: 'pi' },
        },
      },
      params: {
        input: {
          content: [{ type: 'input_text', text: 'missing workspace' }],
        },
      },
    }), {
      userId: 'alice',
      auth: {
        type: 'solid',
        webId: 'http://localhost:5739/alice/profile/card#me',
      },
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of result.type === 'streaming' ? result.stream() : []) {
      chunks.push(chunk);
    }
    const events = parseSseDataLines(chunks);

    expect(driver.inputs).toHaveLength(0);
    expect(events.some((event) => event.type === 'error' && event.error?.message.includes('workspace reference is required'))).toBe(true);
  });

  it('projects resumed client tool output back into the assistant message and completes the same Run', async () => {
    const store = new InMemoryStore<StoreContext>();
    const driver = new ToolCallThenTextDriver();
    const backend = new InngestRunExecutionBackend({
      client: new RecordingInngestClient() as any,
      runtimeDriver: driver,
      durableDelivery: false,
      executeInline: true,
    });
    const service = new ChatKitService<StoreContext>({
      store,
      enableAgentRuntime: true,
      runExecutionBackend: backend,
    });
    const context = { userId: 'u1' };

    const first = await service.process(JSON.stringify({
      type: 'threads.create',
      params: {
        workspace: workspaceRef,
        input: {
          content: [{ type: 'input_text', text: 'needs client tool' }],
        },
      },
      metadata: {
        runtime: {
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
    }), context);
    const firstChunks: Uint8Array[] = [];
    for await (const chunk of first.type === 'streaming' ? first.stream() : []) {
      firstChunks.push(chunk);
    }
    const firstEvents = parseSseDataLines(firstChunks);
    const thread = firstEvents.find((event) => event.type === 'thread.created')?.thread;
    const toolItem = firstEvents.find((event) => event.type === 'thread.item.added' && event.item?.type === 'client_tool_call')?.item;
    expect(toolItem?.id).toBeTruthy();

    const runId = toolItem.metadata.runId as string;
    expect((await store.loadRun(runId, context)).status).toBe(RunStatus.WAITING_INPUT);

    const continued = await service.process(JSON.stringify({
      type: 'threads.add_client_tool_output',
      params: {
        thread_id: thread.id,
        item_id: toolItem.id,
        output: 'selected README.md',
      },
    }), context);
    const continuedChunks: Uint8Array[] = [];
    for await (const chunk of continued.type === 'streaming' ? continued.stream() : []) {
      continuedChunks.push(chunk);
    }
    const continuedEvents = parseSseDataLines(continuedChunks);

    expect(driver.inputs).toHaveLength(2);
    expect(driver.inputs[1].runId).toBe(runId);
    expect(driver.inputs[1].continuation).toEqual({
      kind: 'client_tool_output',
      itemId: toolItem.id,
    });
    expect(assistantText(continuedEvents)).toBe(`resumed:${toolItem.id}`);
    expect((await store.loadRun(runId, context)).status).toBe(RunStatus.COMPLETED);
    const steps = await store.loadRunSteps(runId, context);
    expect(steps.map((step) => step.type)).toContain(XpodRunStepType.CONTINUE_REQUESTED);
    expect(steps.map((step) => step.type)).toContain(RunStepType.CLIENT_TOOL_OUTPUT);
    expect(steps.map((step) => step.type)).toContain(RunStepType.COMPLETED);
  });

  it('restores runtime input from persisted thread history on each run', async () => {
    const store = new InMemoryStore<StoreContext>();
    const driver = new WorkspaceAgentDriver();
    const backend = new InngestRunExecutionBackend({
      client: new RecordingInngestClient() as any,
      runtimeDriver: driver,
      executeInline: true,
    });
    const service = new ChatKitService<StoreContext>({
      store,
      aiProvider: {
        async *streamResponse() {
          throw new Error('aiProvider should not be used for workspace agent chat');
        },
      },
      enableAgentRuntime: true,
      runExecutionBackend: backend,
    });
    const context = { userId: 'u1' };

    const first = await service.process(JSON.stringify({
      type: 'threads.create',
      params: {
        workspace: workspaceRef,
        input: {
          content: [{ type: 'input_text', text: 'first' }],
        },
      },
      metadata: {
        runtime: {
          runner: { type: 'codex', protocol: 'acp' },
        },
      },
    }), context);
    const firstChunks: Uint8Array[] = [];
    for await (const chunk of first.type === 'streaming' ? first.stream() : []) {
      firstChunks.push(chunk);
    }
    const firstEvents = parseSseDataLines(firstChunks);
    const thread = firstEvents.find((event) => event.type === 'thread.created')?.thread;
    expect(thread?.id).toBeTruthy();

    const second = await service.process(JSON.stringify({
      type: 'threads.add_user_message',
      params: {
        thread_id: thread.id,
        input: {
          content: [{ type: 'input_text', text: 'second' }],
        },
      },
    }), context);
    const secondChunks: Uint8Array[] = [];
    for await (const chunk of second.type === 'streaming' ? second.stream() : []) {
      secondChunks.push(chunk);
    }

    expect(driver.inputs).toHaveLength(2);
    expect(driver.inputs[1].prompt).toBe('second');
    expect(driver.inputs[1].conversation).toEqual([
      { role: 'user', text: 'first', createdAt: expect.any(Number) },
      { role: 'assistant', text: `workspace:${workspaceRef}:first`, createdAt: expect.any(Number) },
    ]);
  });

  it('fails pi runtime explicitly when no agent credential is configured', async () => {
    const originalKey = process.env.DEFAULT_API_KEY;
    const originalProvider = process.env.DEFAULT_PROVIDER;
    const originalBase = process.env.DEFAULT_API_BASE;
    try {
      delete process.env.DEFAULT_API_KEY;
      delete process.env.DEFAULT_PROVIDER;
      delete process.env.DEFAULT_API_BASE;

      const driver = new PiAgentRuntimeDriver({ piSdk: piSdkMock as any });
      const events: AgentRuntimeEvent[] = [];
      for await (
        const event of driver.start({
          runId: 'run_no_key',
          threadId: 'thread_no_key',
          prompt: 'hello',
          conversation: [],
          config: {
            workspace: workspaceRef,
            runner: { type: 'codex', protocol: 'acp' },
            agentConfig: {
              id: 'agent-no-key',
              displayName: 'Agent Without Key',
              systemPrompt: '',
              executorType: 'claude',
              apiKey: '',
              mcpServers: {},
              enabled: true,
            },
          },
        })
      ) {
        events.push(event);
      }

      expect(events).toEqual([
        {
          type: 'error',
          message: expect.stringContaining('No API key configured for pi Agent Runtime'),
        },
      ]);
    } finally {
      if (originalKey === undefined) delete process.env.DEFAULT_API_KEY;
      else process.env.DEFAULT_API_KEY = originalKey;
      if (originalProvider === undefined) delete process.env.DEFAULT_PROVIDER;
      else process.env.DEFAULT_PROVIDER = originalProvider;
      if (originalBase === undefined) delete process.env.DEFAULT_API_BASE;
      else process.env.DEFAULT_API_BASE = originalBase;
    }
  });

  it('restores Xpod conversation into a fresh pi session for each run', async () => {
    const originalKey = process.env.DEFAULT_API_KEY;
    const originalProvider = process.env.DEFAULT_PROVIDER;
    const originalBase = process.env.DEFAULT_API_BASE;
    const originalModel = process.env.DEFAULT_MODEL;
    try {
      process.env.DEFAULT_API_KEY = 'sk-test';
      process.env.DEFAULT_PROVIDER = 'openai';
      process.env.DEFAULT_API_BASE = 'https://api.openai.com/v1';
      process.env.DEFAULT_MODEL = 'gpt-test';

      const driver = new PiAgentRuntimeDriver({ piSdk: piSdkMock as any });
      const events: AgentRuntimeEvent[] = [];
      for await (
        const event of driver.start({
          runId: 'run_restore',
          threadId: 'thread_restore',
          prompt: 'current prompt',
          conversation: [
            { role: 'user', text: 'previous user', createdAt: 10 },
            { role: 'assistant', text: 'previous assistant', createdAt: 11 },
          ],
          config: {
            workspace: workspaceRef,
            runner: { type: 'codex', protocol: 'acp' },
          },
        })
      ) {
        events.push(event);
      }

      expect(events).toEqual([]);
      expect(sessionManagerInMemoryMock).toHaveBeenCalledWith(process.cwd());
      expect(sessionManagerCreateMock).not.toHaveBeenCalled();
      expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
      expect(replaceMessagesMock).toHaveBeenCalledWith([
        {
          role: 'user',
          content: [{ type: 'text', text: 'previous user' }],
          timestamp: 10_000,
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'previous assistant' }],
          api: 'openai-responses',
          provider: 'openai',
          model: 'gpt-test',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'stop',
          timestamp: 11_000,
        },
      ]);
      expect(promptMock).toHaveBeenCalledWith('current prompt', {
        expandPromptTemplates: false,
        source: 'rpc',
      });
      expect(disposeMock).toHaveBeenCalledTimes(1);
    } finally {
      if (originalKey === undefined) delete process.env.DEFAULT_API_KEY;
      else process.env.DEFAULT_API_KEY = originalKey;
      if (originalProvider === undefined) delete process.env.DEFAULT_PROVIDER;
      else process.env.DEFAULT_PROVIDER = originalProvider;
      if (originalBase === undefined) delete process.env.DEFAULT_API_BASE;
      else process.env.DEFAULT_API_BASE = originalBase;
      if (originalModel === undefined) delete process.env.DEFAULT_MODEL;
      else process.env.DEFAULT_MODEL = originalModel;
    }
  });

  it('materializes pi runtime workspaces through SolidFS and commits successful runs', async () => {
    const originalKey = process.env.DEFAULT_API_KEY;
    const originalProvider = process.env.DEFAULT_PROVIDER;
    const originalBase = process.env.DEFAULT_API_BASE;
    const originalModel = process.env.DEFAULT_MODEL;
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-solidfs-driver-'));
    const solidfs = new RecordingSolidFS(workdir);
    try {
      process.env.DEFAULT_API_KEY = 'sk-test';
      process.env.DEFAULT_PROVIDER = 'openai';
      process.env.DEFAULT_API_BASE = 'https://api.openai.com/v1';
      process.env.DEFAULT_MODEL = 'gpt-test';

      const driver = new PiAgentRuntimeDriver({
        piSdk: piSdkMock as any,
        solidfs,
        solidfsProjection: 'copy',
      });
      const events: AgentRuntimeEvent[] = [];
      for await (
        const event of driver.start({
          runId: 'run_solidfs',
          threadId: 'thread_solidfs',
          prompt: 'use solidfs',
          conversation: [],
          config: {
            workspace: workspaceRef,
            runner: { type: 'pi', protocol: 'pi' },
          },
        })
      ) {
        events.push(event);
      }

      expect(events).toEqual([]);
      expect(solidfs.prepareInputs).toEqual([
        {
          workspace: workspaceRef,
          sourcePath: process.cwd(),
          projection: 'copy',
          run: {
            id: 'run_solidfs',
            workspace: workspaceRef,
          },
        },
      ]);
      expect(createCodingToolsMock).toHaveBeenCalledWith(workdir);
      expect(sessionManagerInMemoryMock).toHaveBeenCalledWith(workdir);
      expect(solidfs.commits).toBe(1);
      expect(solidfs.rollbacks).toBe(0);
    } finally {
      if (originalKey === undefined) delete process.env.DEFAULT_API_KEY;
      else process.env.DEFAULT_API_KEY = originalKey;
      if (originalProvider === undefined) delete process.env.DEFAULT_PROVIDER;
      else process.env.DEFAULT_PROVIDER = originalProvider;
      if (originalBase === undefined) delete process.env.DEFAULT_API_BASE;
      else process.env.DEFAULT_API_BASE = originalBase;
      if (originalModel === undefined) delete process.env.DEFAULT_MODEL;
      else process.env.DEFAULT_MODEL = originalModel;
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('commits pi runtime file changes back to a real LocalSolidFS copy workspace', async () => {
    const originalKey = process.env.DEFAULT_API_KEY;
    const originalProvider = process.env.DEFAULT_PROVIDER;
    const originalBase = process.env.DEFAULT_API_BASE;
    const originalModel = process.env.DEFAULT_MODEL;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-solidfs-driver-real-'));
    const sourceDir = path.join(root, 'source');
    const workRoot = path.join(root, 'work');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'before.txt'), 'before\n', 'utf8');
    const sourceWorkspaceRef = pathToFileURL(sourceDir).href;
    const solidfs = new LocalSolidFS({ workRoot });

    try {
      process.env.DEFAULT_API_KEY = 'sk-test';
      process.env.DEFAULT_PROVIDER = 'openai';
      process.env.DEFAULT_API_BASE = 'https://api.openai.com/v1';
      process.env.DEFAULT_MODEL = 'gpt-test';

      createCodingToolsMock.mockImplementationOnce((cwd: string) => [{
        name: 'write',
        execute: async (_id: string, params: { path: string; content: string }) => {
          const target = path.join(cwd, params.path);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, params.content, 'utf8');
          return { content: [{ type: 'text', text: 'written' }] };
        },
      }]);
      createAgentSessionMock.mockImplementationOnce(async (options: any) => {
        return {
          session: {
            agent: { replaceMessages: replaceMessagesMock },
            subscribe: subscribeMock,
            prompt: async () => {
              const writeTool = options.tools.find((tool: any) => tool.name === 'write');
              await writeTool.execute('tool_write_1', {
                path: 'after.txt',
                content: 'created by runtime\n',
              });
            },
            dispose: disposeMock,
          },
        };
      });

      const driver = new PiAgentRuntimeDriver({
        piSdk: piSdkMock as any,
        solidfs,
        solidfsProjection: 'copy',
      });
      const events: AgentRuntimeEvent[] = [];

      for await (
        const event of driver.start({
          runId: 'run_solidfs_real_copy',
          threadId: 'thread_solidfs_real_copy',
          prompt: 'write a file',
          conversation: [],
          config: {
            workspace: sourceWorkspaceRef,
            runner: { type: 'pi', protocol: 'pi' },
          },
        })
      ) {
        events.push(event);
      }

      expect(events).toEqual([]);
      expect(fs.readFileSync(path.join(sourceDir, 'before.txt'), 'utf8')).toBe('before\n');
      expect(fs.readFileSync(path.join(sourceDir, 'after.txt'), 'utf8')).toBe('created by runtime\n');

      const nextWorkspace = await solidfs.prepare({
        workspace: sourceWorkspaceRef,
        projection: 'direct',
      });
      expect(fs.readFileSync(path.join(nextWorkspace.cwd, 'after.txt'), 'utf8')).toBe('created by runtime\n');
    } finally {
      if (originalKey === undefined) delete process.env.DEFAULT_API_KEY;
      else process.env.DEFAULT_API_KEY = originalKey;
      if (originalProvider === undefined) delete process.env.DEFAULT_PROVIDER;
      else process.env.DEFAULT_PROVIDER = originalProvider;
      if (originalBase === undefined) delete process.env.DEFAULT_API_BASE;
      else process.env.DEFAULT_API_BASE = originalBase;
      if (originalModel === undefined) delete process.env.DEFAULT_MODEL;
      else process.env.DEFAULT_MODEL = originalModel;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('hydrates missing object files through SolidFS before pi read tools run', async () => {
    const originalKey = process.env.DEFAULT_API_KEY;
    const originalProvider = process.env.DEFAULT_PROVIDER;
    const originalBase = process.env.DEFAULT_API_BASE;
    const originalModel = process.env.DEFAULT_MODEL;
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-solidfs-driver-hydrate-'));
    const solidfs = new RecordingSolidFS(workdir);
    try {
      process.env.DEFAULT_API_KEY = 'sk-test';
      process.env.DEFAULT_PROVIDER = 'openai';
      process.env.DEFAULT_API_BASE = 'https://api.openai.com/v1';
      process.env.DEFAULT_MODEL = 'gpt-test';

      createAgentSessionMock.mockImplementationOnce(async (options: any) => {
        const readTool = options.tools.find((tool: any) => tool.name === 'read');
        return {
          session: {
            agent: { replaceMessages: replaceMessagesMock },
            subscribe: subscribeMock,
            prompt: async () => {
              await readTool.execute('tool_read_1', { path: 'objects/report.txt' });
            },
            dispose: disposeMock,
          },
        };
      });

      const driver = new PiAgentRuntimeDriver({
        piSdk: piSdkMock as any,
        solidfs,
        solidfsProjection: 'hydrated-object',
      });
      for await (
        const _event of driver.start({
          runId: 'run_solidfs_hydrate',
          threadId: 'thread_solidfs_hydrate',
          prompt: 'read object',
          conversation: [],
          config: {
            workspace: workspaceRef,
            runner: { type: 'pi', protocol: 'pi' },
          },
        })
      ) {
        // drain
      }

      expect(solidfs.hydrated).toEqual(['objects/report.txt']);
      expect(fs.readFileSync(path.join(workdir, 'objects', 'report.txt'), 'utf8'))
        .toBe('hydrated:objects/report.txt');
      expect(solidfs.commits).toBe(1);
      expect(solidfs.rollbacks).toBe(0);
    } finally {
      if (originalKey === undefined) delete process.env.DEFAULT_API_KEY;
      else process.env.DEFAULT_API_KEY = originalKey;
      if (originalProvider === undefined) delete process.env.DEFAULT_PROVIDER;
      else process.env.DEFAULT_PROVIDER = originalProvider;
      if (originalBase === undefined) delete process.env.DEFAULT_API_BASE;
      else process.env.DEFAULT_API_BASE = originalBase;
      if (originalModel === undefined) delete process.env.DEFAULT_MODEL;
      else process.env.DEFAULT_MODEL = originalModel;
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('rolls back SolidFS workspace when pi runtime emits an error', async () => {
    const originalKey = process.env.DEFAULT_API_KEY;
    const originalProvider = process.env.DEFAULT_PROVIDER;
    const originalBase = process.env.DEFAULT_API_BASE;
    const originalModel = process.env.DEFAULT_MODEL;
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-solidfs-driver-error-'));
    const solidfs = new RecordingSolidFS(workdir);
    try {
      process.env.DEFAULT_API_KEY = 'sk-test';
      process.env.DEFAULT_PROVIDER = 'openai';
      process.env.DEFAULT_API_BASE = 'https://api.openai.com/v1';
      process.env.DEFAULT_MODEL = 'gpt-test';
      promptMock.mockRejectedValueOnce(new Error('runtime failed'));

      const driver = new PiAgentRuntimeDriver({
        piSdk: piSdkMock as any,
        solidfs,
        solidfsProjection: 'copy',
      });
      const events: AgentRuntimeEvent[] = [];
      for await (
        const event of driver.start({
          runId: 'run_solidfs_error',
          threadId: 'thread_solidfs_error',
          prompt: 'fail',
          conversation: [],
          config: {
            workspace: workspaceRef,
            runner: { type: 'pi', protocol: 'pi' },
          },
        })
      ) {
        events.push(event);
      }

      expect(events).toEqual([{ type: 'error', message: 'runtime failed' }]);
      expect(solidfs.commits).toBe(0);
      expect(solidfs.rollbacks).toBe(1);
    } finally {
      if (originalKey === undefined) delete process.env.DEFAULT_API_KEY;
      else process.env.DEFAULT_API_KEY = originalKey;
      if (originalProvider === undefined) delete process.env.DEFAULT_PROVIDER;
      else process.env.DEFAULT_PROVIDER = originalProvider;
      if (originalBase === undefined) delete process.env.DEFAULT_API_BASE;
      else process.env.DEFAULT_API_BASE = originalBase;
      if (originalModel === undefined) delete process.env.DEFAULT_MODEL;
      else process.env.DEFAULT_MODEL = originalModel;
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('does not pause Chat runs for pi internal tool execution events', async () => {
    const originalKey = process.env.DEFAULT_API_KEY;
    const originalProvider = process.env.DEFAULT_PROVIDER;
    const originalBase = process.env.DEFAULT_API_BASE;
    const originalModel = process.env.DEFAULT_MODEL;
    try {
      process.env.DEFAULT_API_KEY = 'sk-test';
      process.env.DEFAULT_PROVIDER = 'openai';
      process.env.DEFAULT_API_BASE = 'https://api.openai.com/v1';
      process.env.DEFAULT_MODEL = 'gpt-test';

      subscribeMock.mockImplementationOnce((handler: Function) => {
        handler({
          type: 'tool_execution_start',
          toolCallId: 'tool-read-1',
          toolName: 'read',
          args: { path: 'README.md' },
        });
        handler({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'done' },
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        });
        return () => undefined;
      });

      const driver = new PiAgentRuntimeDriver({ piSdk: piSdkMock as any });
      const events: AgentRuntimeEvent[] = [];
      for await (
        const event of driver.start({
          runId: 'run_internal_tool',
          threadId: 'thread_internal_tool',
          prompt: 'read then answer',
          conversation: [],
          config: {
            workspace: workspaceRef,
            runner: { type: 'pi', protocol: 'pi' },
          },
        })
      ) {
        events.push(event);
      }

      expect(events).toEqual([{ type: 'text', text: 'done' }]);
      expect(promptMock).toHaveBeenCalledWith('read then answer', expect.any(Object));
    } finally {
      if (originalKey === undefined) delete process.env.DEFAULT_API_KEY;
      else process.env.DEFAULT_API_KEY = originalKey;
      if (originalProvider === undefined) delete process.env.DEFAULT_PROVIDER;
      else process.env.DEFAULT_PROVIDER = originalProvider;
      if (originalBase === undefined) delete process.env.DEFAULT_API_BASE;
      else process.env.DEFAULT_API_BASE = originalBase;
      if (originalModel === undefined) delete process.env.DEFAULT_MODEL;
      else process.env.DEFAULT_MODEL = originalModel;
    }
  });

  it('warms pi runtime resources while keeping sessions request-scoped', async () => {
    const originalKey = process.env.DEFAULT_API_KEY;
    const originalProvider = process.env.DEFAULT_PROVIDER;
    const originalBase = process.env.DEFAULT_API_BASE;
    const originalModel = process.env.DEFAULT_MODEL;
    try {
      process.env.DEFAULT_API_KEY = 'sk-test';
      process.env.DEFAULT_PROVIDER = 'openai';
      process.env.DEFAULT_API_BASE = 'https://api.openai.com/v1';
      process.env.DEFAULT_MODEL = 'gpt-test';

      const driver = new PiAgentRuntimeDriver({ piSdk: piSdkMock as any });
      const input: RunExecutionInput = {
        runId: 'run_warm_1',
        threadId: 'thread_warm',
        prompt: 'first',
        conversation: [],
        config: {
          workspace: workspaceRef,
          runner: { type: 'pi', protocol: 'pi' },
        },
      };

      for await (const _event of driver.start(input)) {
        // drain
      }
      for await (const _event of driver.start({ ...input, runId: 'run_warm_2', prompt: 'second' })) {
        // drain
      }

      expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
      expect(sessionManagerInMemoryMock).toHaveBeenCalledTimes(2);
      expect(reloadMock).toHaveBeenCalledTimes(1);
      expect(createCodingToolsMock).toHaveBeenCalledTimes(1);
    } finally {
      if (originalKey === undefined) delete process.env.DEFAULT_API_KEY;
      else process.env.DEFAULT_API_KEY = originalKey;
      if (originalProvider === undefined) delete process.env.DEFAULT_PROVIDER;
      else process.env.DEFAULT_PROVIDER = originalProvider;
      if (originalBase === undefined) delete process.env.DEFAULT_API_BASE;
      else process.env.DEFAULT_API_BASE = originalBase;
      if (originalModel === undefined) delete process.env.DEFAULT_MODEL;
      else process.env.DEFAULT_MODEL = originalModel;
    }
  });

  it('maps a Pod workspace reference to a local cwd and lets the managed agent read and write files there', async () => {
    const originalCssBaseUrl = process.env.CSS_BASE_URL;
    const originalCssRootFilePath = process.env.CSS_ROOT_FILE_PATH;
    const originalKey = process.env.DEFAULT_API_KEY;
    const originalProvider = process.env.DEFAULT_PROVIDER;
    const originalBase = process.env.DEFAULT_API_BASE;
    const originalModel = process.env.DEFAULT_MODEL;

    const podRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-managed-agent-pod-'));
    const workspaceRef = 'https://pod.example/alice/projects/demo/';
    const mappedWorkspacePath = path.join(podRoot, 'alice/projects/demo');

    try {
      process.env.CSS_BASE_URL = 'https://pod.example/';
      process.env.CSS_ROOT_FILE_PATH = podRoot;
      process.env.DEFAULT_API_KEY = 'sk-test';
      process.env.DEFAULT_PROVIDER = 'openai';
      process.env.DEFAULT_API_BASE = 'https://api.openai.com/v1';
      process.env.DEFAULT_MODEL = 'gpt-test';

      fs.mkdirSync(mappedWorkspacePath, { recursive: true });
      fs.writeFileSync(path.join(mappedWorkspacePath, 'README.md'), 'pod workspace readme\n', 'utf8');

      let activeWorkdir = '';
      let activeSessionHandler: ((event: any) => void) | undefined;

      subscribeMock.mockImplementationOnce((handler: Function) => {
        activeSessionHandler = handler as (event: any) => void;
        return () => undefined;
      });

      createAgentSessionMock.mockImplementationOnce(async (options: any) => {
        activeWorkdir = options.cwd;
        expect(activeWorkdir).toBe(mappedWorkspacePath);
        return {
          session: {
            agent: { replaceMessages: replaceMessagesMock },
            subscribe: subscribeMock,
            prompt: async (prompt: string) => {
              const readmePath = path.join(activeWorkdir, 'README.md');
              const outputPath = path.join(activeWorkdir, 'managed-agent-output.txt');
              const readme = fs.readFileSync(readmePath, 'utf8').trim();
              fs.writeFileSync(outputPath, `processed:${readme}:${prompt}`, 'utf8');
              activeSessionHandler?.({
                type: 'message_update',
                assistantMessageEvent: {
                  type: 'text_delta',
                  delta: `cwd:${path.basename(activeWorkdir)} read:${readme}`,
                },
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: `cwd:${path.basename(activeWorkdir)} read:${readme}` }],
                },
              });
            },
            dispose: disposeMock,
          },
        };
      });

      const driver = new PiAgentRuntimeDriver({ piSdk: piSdkMock as any });
      const backend = new InngestRunExecutionBackend({
        client: new RecordingInngestClient() as any,
        runtimeDriver: driver,
        durableDelivery: false,
        executeInline: true,
      });
      const service = new ChatKitService<StoreContext>({
        store: new InMemoryStore<StoreContext>(),
        aiProvider: {
          async *streamResponse() {
            throw new Error('aiProvider should not be used for managed agent runs');
          },
        },
        enableAgentRuntime: true,
        runExecutionBackend: backend,
      });

      const result = await service.process(JSON.stringify({
        type: 'threads.create',
        params: {
          workspace: workspaceRef,
          input: {
            content: [{ type: 'input_text', text: 'operate pod workspace' }],
          },
        },
        metadata: {
          runtime: {
            runner: { type: 'codex', protocol: 'pi' },
          },
        },
      }), { userId: 'u1' });

      const chunks: Uint8Array[] = [];
      for await (const chunk of result.type === 'streaming' ? result.stream() : []) {
        chunks.push(chunk);
      }
      const events = parseSseDataLines(chunks);

      expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
      expect(createCodingToolsMock).toHaveBeenCalledWith(mappedWorkspacePath);
      expect(createReadOnlyToolsMock).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(mappedWorkspacePath, 'managed-agent-output.txt'), 'utf8'))
        .toBe('processed:pod workspace readme:operate pod workspace');
      expect(assistantText(events)).toBe(`cwd:demo read:pod workspace readme`);
    } finally {
      if (originalCssBaseUrl === undefined) delete process.env.CSS_BASE_URL;
      else process.env.CSS_BASE_URL = originalCssBaseUrl;
      if (originalCssRootFilePath === undefined) delete process.env.CSS_ROOT_FILE_PATH;
      else process.env.CSS_ROOT_FILE_PATH = originalCssRootFilePath;
      if (originalKey === undefined) delete process.env.DEFAULT_API_KEY;
      else process.env.DEFAULT_API_KEY = originalKey;
      if (originalProvider === undefined) delete process.env.DEFAULT_PROVIDER;
      else process.env.DEFAULT_PROVIDER = originalProvider;
      if (originalBase === undefined) delete process.env.DEFAULT_API_BASE;
      else process.env.DEFAULT_API_BASE = originalBase;
      if (originalModel === undefined) delete process.env.DEFAULT_MODEL;
      else process.env.DEFAULT_MODEL = originalModel;
      fs.rmSync(podRoot, { recursive: true, force: true });
    }
  });

  it('replays default journaled Pod sync work on the next runtime start', async () => {
    const originalCssBaseUrl = process.env.CSS_BASE_URL;
    const originalCssRootFilePath = process.env.CSS_ROOT_FILE_PATH;
    const originalKey = process.env.DEFAULT_API_KEY;
    const originalProvider = process.env.DEFAULT_PROVIDER;
    const originalBase = process.env.DEFAULT_API_BASE;
    const originalModel = process.env.DEFAULT_MODEL;
    const originalFetch = globalThis.fetch;

    const podRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-managed-agent-journal-'));
    const journalRoot = path.join(podRoot, 'control');
    const workspaceRef = 'https://pod.example/alice/projects/demo/';
    const mappedWorkspacePath = path.join(podRoot, 'alice/projects/demo');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('remote down', { status: 503 }))
      .mockResolvedValue(new Response('', { status: 200 }));

    try {
      process.env.CSS_BASE_URL = 'https://pod.example/';
      process.env.CSS_ROOT_FILE_PATH = podRoot;
      process.env.DEFAULT_API_KEY = 'sk-test';
      process.env.DEFAULT_PROVIDER = 'openai';
      process.env.DEFAULT_API_BASE = 'https://api.openai.com/v1';
      process.env.DEFAULT_MODEL = 'gpt-test';
      globalThis.fetch = fetchMock as any;

      fs.mkdirSync(mappedWorkspacePath, { recursive: true });
      fs.writeFileSync(path.join(mappedWorkspacePath, 'data.ttl'), '<#me> <https://schema.org/name> "Alice" .\n', 'utf8');

      const driver = new PiAgentRuntimeDriver({
        piSdk: piSdkMock as any,
        solidfsJournalRootDir: journalRoot,
      });
      const input: RunExecutionInput = {
        runId: 'run_journal_1',
        threadId: 'thread_journal',
        prompt: 'sync workspace',
        conversation: [],
        context: {
          auth: {
            type: 'solid',
            webId: 'https://pod.example/alice/profile/card#me',
            accessToken: 'token-1',
          },
        },
        config: {
          workspace: workspaceRef,
          runner: { type: 'pi', protocol: 'pi' },
        },
      };

      for await (const _event of driver.start(input)) {
        // drain
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('https://pod.example/alice/projects/demo/data.ttl');

      for await (const _event of driver.start({ ...input, runId: 'run_journal_2' })) {
        // drain
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toBe('https://pod.example/alice/projects/demo/data.ttl');
      expect(fetchMock.mock.calls[1][1]?.method).toBe('PUT');

      for await (const _event of driver.start({ ...input, runId: 'run_journal_3' })) {
        // drain
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalCssBaseUrl === undefined) delete process.env.CSS_BASE_URL;
      else process.env.CSS_BASE_URL = originalCssBaseUrl;
      if (originalCssRootFilePath === undefined) delete process.env.CSS_ROOT_FILE_PATH;
      else process.env.CSS_ROOT_FILE_PATH = originalCssRootFilePath;
      if (originalKey === undefined) delete process.env.DEFAULT_API_KEY;
      else process.env.DEFAULT_API_KEY = originalKey;
      if (originalProvider === undefined) delete process.env.DEFAULT_PROVIDER;
      else process.env.DEFAULT_PROVIDER = originalProvider;
      if (originalBase === undefined) delete process.env.DEFAULT_API_BASE;
      else process.env.DEFAULT_API_BASE = originalBase;
      if (originalModel === undefined) delete process.env.DEFAULT_MODEL;
      else process.env.DEFAULT_MODEL = originalModel;
      fs.rmSync(podRoot, { recursive: true, force: true });
    }
  });

  it('replays default journaled Pod sync work on the next managed runtime start', async () => {
    const originalCssBaseUrl = process.env.CSS_BASE_URL;
    const originalCssRootFilePath = process.env.CSS_ROOT_FILE_PATH;
    const originalKey = process.env.DEFAULT_API_KEY;
    const originalProvider = process.env.DEFAULT_PROVIDER;
    const originalBase = process.env.DEFAULT_API_BASE;
    const originalModel = process.env.DEFAULT_MODEL;
    const originalFetch = globalThis.fetch;

    const podRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-managed-agent-journal-'));
    const workspaceRef = 'https://pod.example/alice/projects/demo/';
    const mappedWorkspacePath = path.join(podRoot, 'alice/projects/demo');
    const journalRoot = path.join(podRoot, 'control');

    try {
      process.env.CSS_BASE_URL = 'https://pod.example/';
      process.env.CSS_ROOT_FILE_PATH = podRoot;
      process.env.DEFAULT_API_KEY = 'sk-test';
      process.env.DEFAULT_PROVIDER = 'openai';
      process.env.DEFAULT_API_BASE = 'https://api.openai.com/v1';
      process.env.DEFAULT_MODEL = 'gpt-test';

      fs.mkdirSync(mappedWorkspacePath, { recursive: true });
      fs.writeFileSync(path.join(mappedWorkspacePath, 'data.ttl'), '<#me> <https://schema.org/name> "Alice" .\n', 'utf8');

      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
        .mockResolvedValue(new Response('', { status: 200 }));
      globalThis.fetch = fetchMock as any;

      const driver = new PiAgentRuntimeDriver({
        piSdk: piSdkMock as any,
        solidfsJournalRootDir: journalRoot,
      });
      const input: RunExecutionInput = {
        runId: 'run_journal_1',
        threadId: 'thread_journal',
        prompt: 'sync workspace',
        conversation: [],
        context: {
          auth: {
            type: 'solid',
            webId: 'https://pod.example/alice/profile/card#me',
            accessToken: 'test-token',
            tokenType: 'Bearer',
          },
        },
        config: {
          workspace: workspaceRef,
          runner: { type: 'pi', protocol: 'pi' },
        },
      };

      for await (const _event of driver.start(input)) {
        // First run records a retryable journal entry because the Pod sync fails.
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('https://pod.example/alice/projects/demo/data.ttl');

      for await (const _event of driver.start({ ...input, runId: 'run_journal_2' })) {
        // Second run replays the persisted journal entry before the agent loop.
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toBe('https://pod.example/alice/projects/demo/data.ttl');
      expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('PUT');

      for await (const _event of driver.start({ ...input, runId: 'run_journal_3' })) {
        // The checkpoint now covers the file, so prepare should not sync again.
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalCssBaseUrl === undefined) delete process.env.CSS_BASE_URL;
      else process.env.CSS_BASE_URL = originalCssBaseUrl;
      if (originalCssRootFilePath === undefined) delete process.env.CSS_ROOT_FILE_PATH;
      else process.env.CSS_ROOT_FILE_PATH = originalCssRootFilePath;
      if (originalKey === undefined) delete process.env.DEFAULT_API_KEY;
      else process.env.DEFAULT_API_KEY = originalKey;
      if (originalProvider === undefined) delete process.env.DEFAULT_PROVIDER;
      else process.env.DEFAULT_PROVIDER = originalProvider;
      if (originalBase === undefined) delete process.env.DEFAULT_API_BASE;
      else process.env.DEFAULT_API_BASE = originalBase;
      if (originalModel === undefined) delete process.env.DEFAULT_MODEL;
      else process.env.DEFAULT_MODEL = originalModel;
      fs.rmSync(podRoot, { recursive: true, force: true });
    }
  });

  it('runs the whole pi agent loop through a sandboxed worker in cloud isolation mode', async () => {
    const driver = new PiAgentRuntimeDriver({
      agentLoopIsolation: 'sandboxed-process',
      sandboxedLoopRunner: async function *sandboxedLoop(input) {
        yield { type: 'text', text: `sandboxed:${input.prompt}` };
      },
    });

    const events: AgentRuntimeEvent[] = [];
    for await (
      const event of driver.start({
        runId: 'run_sandboxed',
        threadId: 'thread_sandboxed',
        prompt: 'loop',
        conversation: [],
        config: {
          workspace: workspaceRef,
          runner: { type: 'pi', protocol: 'pi' },
        },
      })
    ) {
      events.push(event);
    }

    expect(events).toEqual([{ type: 'text', text: 'sandboxed:loop' }]);
    expect(createAgentSessionMock).not.toHaveBeenCalled();
    expect(createCodingToolsMock).not.toHaveBeenCalled();
  });
});
