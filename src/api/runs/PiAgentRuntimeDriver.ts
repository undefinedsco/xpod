import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { createInterface } from 'node:readline';
import type { WorkspaceRef } from '../workspace/types';
import { getDefaultBaseUrl } from '../service/provider-registry';
import { getPlatformApiBaseUrl, getPlatformApiKey, getPlatformDefaultModel, getPlatformProviderId } from '../service/platform-ai-config';
import { GitWorktreeService } from '../chatkit/runtime/GitWorktreeService';
import { SandboxFactory } from '../../terminal/sandbox';
import { LocalSolidFS, PodSolidFsHydrator, PodSolidFsSyncer, SolidFsNotFoundError, type MaterializedWorkspace, type SolidFS, type SolidFsProjection } from '../../solidfs';
import type {
  AgentRuntimeConfig,
  AgentRuntimeEvent,
} from './AgentRuntimeTypes';
import type { RunConversationMessage, RunExecutionBackend, RunExecutionInput } from './RunExecutionBackend';

type PiSdk = typeof import('@mariozechner/pi-coding-agent');
type AgentSessionEvent = import('@mariozechner/pi-coding-agent').AgentSessionEvent;
type CreateAgentSessionOptions = NonNullable<Parameters<PiSdk['createAgentSession']>[0]>;
type PiTool = ReturnType<PiSdk['createCodingTools']>[number];
type PiReadOperations = import('@mariozechner/pi-coding-agent').ReadOperations;
type PiEditOperations = import('@mariozechner/pi-coding-agent').EditOperations;
type PiWriteOperations = import('@mariozechner/pi-coding-agent').WriteOperations;
type PiApi = string;
type PiModel = {
  id: string;
  name: string;
  api: PiApi;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
};
type PiMessage =
  | {
    role: 'user';
    content: Array<{ type: 'text'; text: string }>;
    timestamp: number;
  }
  | {
    role: 'assistant';
    content: Array<{ type: 'text'; text: string }>;
    api: PiApi;
    provider: string;
    model: string;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
    };
    stopReason: 'stop';
    timestamp: number;
  };

export interface PiAgentRuntimeDriverOptions {
  /**
   * local: run pi's full Agent Loop in the API process.
   * cloud: run the entire pi Agent Loop in a sandboxed worker process.
   */
  agentLoopIsolation?: 'in-process' | 'sandboxed-process';
  /**
   * Cloud defaults to strict sandboxing: do not fall back to an unsandboxed
   * process if sandbox-exec/bubblewrap is unavailable.
   */
  requireSandbox?: boolean;
  workerPath?: string;
  sandboxedLoopRunner?: (input: RunExecutionInput, workdir: string) => AsyncIterable<AgentRuntimeEvent>;
  sessionRootDir?: string;
  /**
   * Off by default: pi sessions are request-scoped implementation detail. When
   * enabled, the JSONL session is a diagnostic copy only; Xpod still restores
   * authoritative state from Run/Thread/Message before each execution.
   */
  persistPiSessions?: boolean;
  piSdk?: PiSdk;
  solidfs?: SolidFS;
  solidfsProjection?: SolidFsProjection;
}

type WarmRuntime = {
  pi: PiSdk;
  workdir: string;
  piConfig: {
    provider: string;
    apiKey: string;
    api: PiApi;
    baseUrl: string;
    model: PiModel;
  };
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  authStorage: NonNullable<CreateAgentSessionOptions['authStorage']>;
  modelRegistry: NonNullable<CreateAgentSessionOptions['modelRegistry']>;
  settingsManager: ReturnType<PiSdk['SettingsManager']['inMemory']>;
  resourceLoader: NonNullable<CreateAgentSessionOptions['resourceLoader']>;
  tools: PiTool[];
};

/**
 * Request-scoped adapter around pi's AgentSession primitives.
 *
 * Xpod restores durable conversation state into pi with replaceMessages() on
 * every run. pi owns the atomic agent loop, tools and streaming events for the
 * current invocation only; its SessionManager is not the Xpod state center.
 */
export class PiAgentRuntimeDriver implements RunExecutionBackend {
  private static sdkPromise?: Promise<PiSdk>;

  private readonly git = new GitWorktreeService();
  private readonly warmRuntimes = new Map<string, Promise<WarmRuntime>>();
  private readonly solidfs: SolidFS;

  public constructor(private readonly options: PiAgentRuntimeDriverOptions = {}) {
    this.solidfs = options.solidfs ?? new LocalSolidFS({
      syncer: new PodSolidFsSyncer(),
      hydrator: new PodSolidFsHydrator(),
    });
  }

  public async *start(input: RunExecutionInput): AsyncIterable<AgentRuntimeEvent> {
    if (this.options.agentLoopIsolation === 'sandboxed-process') {
      let workspace: MaterializedWorkspace | undefined;
      let completed = false;
      try {
        workspace = await this.prepareWorkspace(input);
        const runner = this.options.sandboxedLoopRunner
          ?? ((runInput, runWorkdir) => this.startSandboxedAgentLoop(runInput, runWorkdir));
        for await (const event of runner(input, workspace.cwd)) {
          yield event;
          if (event.type === 'error') {
            return;
          }
        }
        await workspace.commit();
        completed = true;
      } catch (error) {
        yield this.startupErrorToEvent(error);
      } finally {
        if (!completed) {
          await workspace?.rollback().catch((error) => {
            this.logWorkspaceRollbackError(error);
          });
        }
      }
      return;
    }

    yield* this.startInProcess(input);
  }

  private async *startInProcess(input: RunExecutionInput): AsyncIterable<AgentRuntimeEvent> {
    const queue = new AsyncPushQueue<AgentRuntimeEvent>();
    let session: Awaited<ReturnType<PiSdk['createAgentSession']>>['session'] | undefined;
    let workspace: MaterializedWorkspace | undefined;
    let completed = false;
    let failed = false;

    try {
      workspace = await this.prepareWorkspace(input);
      const runtime = await this.getWarmRuntime(input, workspace);
      const sessionManager = this.createSessionManager(runtime.pi, input.runId, runtime.workdir);
      const result = await runtime.pi.createAgentSession({
        cwd: runtime.workdir,
        authStorage: runtime.authStorage,
        modelRegistry: runtime.modelRegistry,
        settingsManager: runtime.settingsManager,
        sessionManager,
        resourceLoader: runtime.resourceLoader,
        model: runtime.piConfig.model,
        thinkingLevel: runtime.thinkingLevel,
        tools: runtime.tools,
      });
      session = result.session;
      session.agent.replaceMessages(this.toPiMessages(input.conversation, runtime.piConfig));

      const streamState = {
        lastAssistantText: '',
        assistantTextStreamed: false,
      };
      const unsubscribe = session.subscribe((event) => {
        this.projectPiEvent(event, queue, streamState);
      });

      void session.prompt(input.prompt, { expandPromptTemplates: false, source: 'rpc' }).then(() => {
        if (!streamState.assistantTextStreamed && streamState.lastAssistantText.length > 0) {
          queue.push({ type: 'text', text: streamState.lastAssistantText });
        }
        queue.close();
      }).catch((error) => {
        queue.push({ type: 'error', message: this.formatError(error) });
        queue.close();
      }).finally(() => {
        unsubscribe();
        session?.dispose();
      });

      for await (const event of queue.iterate()) {
        if (event.type === 'error') {
          failed = true;
        }
        yield event;
      }
      if (!failed) {
        await workspace.commit();
        completed = true;
      }
    } catch (error) {
      session?.dispose();
      yield this.startupErrorToEvent(error);
    } finally {
      if (!completed) {
        await workspace?.rollback().catch((error) => {
          this.logWorkspaceRollbackError(error);
        });
      }
    }
  }

  private startSandboxedAgentLoop(input: RunExecutionInput, workdir: string): AsyncIterable<AgentRuntimeEvent> {
    const queue = new AsyncPushQueue<AgentRuntimeEvent>();
    const requireSandbox = this.options.requireSandbox ?? true;

    if (requireSandbox && !SandboxFactory.isAvailable()) {
      queue.push({ type: 'error', message: 'Cloud Agent Runtime requires an OS sandbox, but none is available on this host' });
      queue.close();
      return queue.iterate();
    }

    const child = SandboxFactory.launch({
      workdir,
      command: process.execPath,
      args: [this.resolveWorkerPath()],
      env: this.workerEnv(),
      isolateNetwork: false,
    });

    if (requireSandbox && !child.sandboxed) {
      child.process.kill();
      queue.push({ type: 'error', message: 'Cloud Agent Runtime refused to run without a sandbox' });
      queue.close();
      return queue.iterate();
    }

    const stderrChunks: Buffer[] = [];
    const stderrMaxBytes = 16 * 1024;
    let closed = false;

    const closeOnce = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      queue.close();
    };

    child.process.stdin?.end(JSON.stringify({
      input,
      options: {
        persistPiSessions: this.options.persistPiSessions === true,
        sessionRootDir: this.options.sessionRootDir,
      },
    }));

    const rl = createInterface({ input: child.process.stdout! });
    rl.on('line', (line) => {
      if (!line.startsWith(PI_AGENT_WORKER_EVENT_PREFIX)) {
        return;
      }
      const payload = line.slice(PI_AGENT_WORKER_EVENT_PREFIX.length);
      try {
        queue.push(JSON.parse(payload) as AgentRuntimeEvent);
      } catch (error) {
        queue.push({ type: 'error', message: `Invalid Agent Runtime worker event: ${this.formatError(error)}` });
      }
    });

    child.process.stderr?.on('data', (chunk: Buffer) => {
      if (Buffer.concat(stderrChunks).length < stderrMaxBytes) {
        stderrChunks.push(chunk);
      }
    });

    child.process.on('error', (error) => {
      queue.push({ type: 'error', message: `Agent Runtime worker failed to start: ${this.formatError(error)}` });
      closeOnce();
    });

    child.process.on('close', (code, signal) => {
      rl.close();
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
        const suffix = stderr ? `: ${stderr}` : signal ? ` (signal ${signal})` : '';
        queue.push({ type: 'error', message: `Agent Runtime worker exited with code ${code ?? 'null'}${suffix}` });
      }
      closeOnce();
    });

    return queue.iterate();
  }

  private projectPiEvent(
    event: AgentSessionEvent,
    queue: AsyncPushQueue<AgentRuntimeEvent>,
    state: {
      lastAssistantText: string;
      assistantTextStreamed: boolean;
    },
  ): void {
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      queue.push({ type: 'text', text: event.assistantMessageEvent.delta });
      state.assistantTextStreamed = true;
      return;
    }

    if (event.type === 'message_update' && event.message.role === 'assistant') {
      state.lastAssistantText = this.extractText(event.message.content);
      return;
    }

    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const finalText = this.extractText(event.message.content);
      const alreadyStreamed = state.assistantTextStreamed;
      state.lastAssistantText = '';
      state.assistantTextStreamed = false;
      if (!alreadyStreamed && finalText.length > 0) {
        queue.push({ type: 'text', text: finalText });
      }
      return;
    }

    // pi emits tool_execution_start for its own read/bash/edit/write tools.
    // Those are internal runtime activity, not client-side tool requests.
  }

  private resolvePiConfig(config: AgentRuntimeConfig): {
    provider: string;
    apiKey: string;
    api: PiApi;
    baseUrl: string;
    model: PiModel;
  } {
    const baseUrl = config.agentConfig?.baseUrl || getPlatformApiBaseUrl();
    const provider = this.resolveProviderId(baseUrl);
    const apiKey = config.agentConfig?.apiKey || getPlatformApiKey();
    if (!apiKey) {
      throw new Error('No API key configured for pi Agent Runtime. Store the agent credential in the Pod or set DEFAULT_API_KEY for local development.');
    }
    const resolvedBaseUrl = baseUrl || getDefaultBaseUrl(provider);
    const modelId = config.agentConfig?.model || getPlatformDefaultModel();
    const api = this.resolveApiForBaseUrl(resolvedBaseUrl);

    return {
      provider,
      apiKey,
      api,
      baseUrl: resolvedBaseUrl,
      model: {
        id: modelId,
        name: modelId,
        api,
        provider,
        baseUrl: resolvedBaseUrl,
        reasoning: false,
        input: ['text'],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 128_000,
        maxTokens: 8192,
        compat: api === 'openai-completions'
          ? {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          }
          : undefined,
      },
    };
  }

  private resolveProviderId(baseUrl: string | undefined): string {
    const configured = getPlatformProviderId();
    if (configured && configured !== 'undefineds') {
      return configured;
    }
    if (!baseUrl) {
      return 'xpod';
    }
    try {
      const host = new URL(baseUrl).hostname;
      if (host.includes('openai.com')) return 'openai';
      if (host.includes('anthropic.com')) return 'anthropic';
      if (host.includes('openrouter.ai')) return 'openrouter';
      if (host.includes('deepseek.com')) return 'deepseek';
      if (host.includes('mistral.ai')) return 'mistral';
      if (host === 'localhost' || host === '127.0.0.1') return 'ollama';
    } catch {
      // fall through to xpod
    }
    return 'xpod';
  }

  private resolveApiForBaseUrl(baseUrl: string): PiApi {
    try {
      const host = new URL(baseUrl).hostname;
      return host === 'api.openai.com' ? 'openai-responses' : 'openai-completions';
    } catch {
      return 'openai-completions';
    }
  }

  private resolveThinkingLevel(config: AgentRuntimeConfig): 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
    const level = (config.agentConfig as any)?.thinkingLevel;
    return level === 'minimal' || level === 'low' || level === 'medium' || level === 'high' || level === 'xhigh'
      ? level
      : 'off';
  }

  private resolveTools(pi: PiSdk, workspace: MaterializedWorkspace, config: AgentRuntimeConfig): PiTool[] {
    const workdir = workspace.cwd;
    const permissionMode = config.agentConfig?.permissionMode;
    const allowed = new Set(config.agentConfig?.allowedTools?.map((tool) => tool.toLowerCase()) ?? []);
    const disallowed = new Set(config.agentConfig?.disallowedTools?.map((tool) => tool.toLowerCase()) ?? []);
    const baseTools = permissionMode === 'plan' || allowed.size > 0
      ? this.createSolidFsReadOnlyTools(pi, workspace)
      : this.createSolidFsCodingTools(pi, workspace);

    return baseTools.filter((tool) => {
      const name = tool.name.toLowerCase();
      if (disallowed.has(name)) {
        return false;
      }
      return allowed.size === 0 || allowed.has(name);
    }) as PiTool[];
  }

  private async getWarmRuntime(input: RunExecutionInput, workspace: MaterializedWorkspace): Promise<WarmRuntime> {
    const pi = await this.loadPiSdk();
    const workdir = workspace.cwd;
    const key = this.warmRuntimeKey(workdir, input.config);
    const existing = this.warmRuntimes.get(key);
    if (existing) {
      return existing;
    }

    const created = this.createWarmRuntime(pi, workspace, input.config).catch((error) => {
      this.warmRuntimes.delete(key);
      throw error;
    });
    this.warmRuntimes.set(key, created);
    return created;
  }

  private async createWarmRuntime(pi: PiSdk, workspace: MaterializedWorkspace, config: AgentRuntimeConfig): Promise<WarmRuntime> {
    const workdir = workspace.cwd;
    const piConfig = this.resolvePiConfig(config);
    const authStorage = pi.AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(piConfig.provider, piConfig.apiKey);

    const modelRegistry = new pi.ModelRegistry(authStorage, undefined);
    modelRegistry.registerProvider(piConfig.provider, {
      baseUrl: piConfig.baseUrl,
      apiKey: piConfig.apiKey,
      api: piConfig.api,
      models: [ piConfig.model ],
    });

    const thinkingLevel = this.resolveThinkingLevel(config);
    const settingsManager = pi.SettingsManager.inMemory({
      defaultProvider: piConfig.provider,
      defaultModel: piConfig.model.id,
      defaultThinkingLevel: thinkingLevel,
    });

    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: workdir,
      settingsManager,
      systemPrompt: config.agentConfig?.systemPrompt,
      appendSystemPrompt: config.agentConfig?.skillsContent,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await resourceLoader.reload();

    return {
      pi,
      workdir,
      piConfig,
      thinkingLevel,
      authStorage,
      modelRegistry,
      settingsManager,
      resourceLoader,
      tools: this.resolveTools(pi, workspace, config),
    };
  }

  private createSolidFsCodingTools(pi: PiSdk, workspace: MaterializedWorkspace): PiTool[] {
    if (!this.canHydrateWorkspace(workspace)) {
      return pi.createCodingTools(workspace.cwd);
    }

    return [
      pi.createReadTool(workspace.cwd, { operations: this.createSolidFsReadOperations(workspace) }) as PiTool,
      pi.createBashTool(workspace.cwd) as PiTool,
      pi.createEditTool(workspace.cwd, { operations: this.createSolidFsEditOperations(workspace) }) as PiTool,
      pi.createWriteTool(workspace.cwd, { operations: this.createSolidFsWriteOperations(workspace) }) as PiTool,
    ];
  }

  private createSolidFsReadOnlyTools(pi: PiSdk, workspace: MaterializedWorkspace): PiTool[] {
    if (!this.canHydrateWorkspace(workspace)) {
      return pi.createReadOnlyTools(workspace.cwd);
    }

    return [
      pi.createReadTool(workspace.cwd, { operations: this.createSolidFsReadOperations(workspace) }) as PiTool,
      ...pi.createReadOnlyTools(workspace.cwd).filter((tool) => tool.name !== 'read'),
    ];
  }

  private createSolidFsReadOperations(workspace: MaterializedWorkspace): PiReadOperations {
    return {
      readFile: async (absolutePath) => fs.promises.readFile(await this.ensureSolidFsPath(workspace, absolutePath)),
      access: async (absolutePath) => {
        await fs.promises.access(await this.ensureSolidFsPath(workspace, absolutePath), fs.constants.R_OK);
      },
      detectImageMimeType: async (absolutePath) => this.detectImageMimeType(await this.ensureSolidFsPath(workspace, absolutePath)),
    };
  }

  private createSolidFsEditOperations(workspace: MaterializedWorkspace): PiEditOperations {
    return {
      readFile: async (absolutePath) => fs.promises.readFile(await this.ensureSolidFsPath(workspace, absolutePath)),
      writeFile: async (absolutePath, content) => fs.promises.writeFile(await this.ensureSolidFsWritablePath(workspace, absolutePath), content, 'utf8'),
      access: async (absolutePath) => {
        await fs.promises.access(await this.ensureSolidFsPath(workspace, absolutePath), fs.constants.R_OK | fs.constants.W_OK);
      },
    };
  }

  private createSolidFsWriteOperations(workspace: MaterializedWorkspace): PiWriteOperations {
    return {
      writeFile: async (absolutePath, content) => fs.promises.writeFile(await this.ensureSolidFsWritablePath(workspace, absolutePath), content, 'utf8'),
      mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }).then(() => undefined),
    };
  }

  private async ensureSolidFsWritablePath(workspace: MaterializedWorkspace, absolutePath: string): Promise<string> {
    try {
      return await this.ensureSolidFsPath(workspace, absolutePath);
    } catch (error) {
      if (error instanceof SolidFsNotFoundError) {
        return path.resolve(absolutePath);
      }
      throw error;
    }
  }

  private async ensureSolidFsPath(workspace: MaterializedWorkspace, absolutePath: string): Promise<string> {
    if (!this.canHydrateWorkspace(workspace)) {
      return absolutePath;
    }

    const resolved = path.resolve(absolutePath);
    const root = path.resolve(workspace.cwd);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      return absolutePath;
    }

    try {
      await fs.promises.access(resolved, fs.constants.F_OK);
      return resolved;
    } catch {
      const relativePath = path.relative(root, resolved);
      await workspace.hydrate(relativePath);
      return resolved;
    }
  }

  private canHydrateWorkspace(workspace: MaterializedWorkspace): workspace is MaterializedWorkspace & Required<Pick<MaterializedWorkspace, 'hydrate'>> {
    return workspace.manifest.projection === 'hydrated-object' && typeof workspace.hydrate === 'function';
  }

  private async detectImageMimeType(absolutePath: string): Promise<string | null> {
    const handle = await fs.promises.open(absolutePath, 'r');
    try {
      const buffer = Buffer.alloc(12);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const header = buffer.subarray(0, bytesRead);
      if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
        return 'image/jpeg';
      }
      if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'image/png';
      }
      if (header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a') {
        return 'image/gif';
      }
      if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') {
        return 'image/webp';
      }
      return null;
    } finally {
      await handle.close();
    }
  }

  private warmRuntimeKey(workdir: string, config: AgentRuntimeConfig): string {
    const agent = config.agentConfig;
    return JSON.stringify({
      workdir,
      baseUrl: agent?.baseUrl ?? getPlatformApiBaseUrl(),
      model: agent?.model ?? getPlatformDefaultModel(),
      apiKeyHash: this.hashSecret(agent?.apiKey ?? getPlatformApiKey()),
      systemPrompt: agent?.systemPrompt ?? '',
      skillsContent: agent?.skillsContent ?? '',
      permissionMode: agent?.permissionMode ?? '',
      allowedTools: agent?.allowedTools ?? [],
      disallowedTools: agent?.disallowedTools ?? [],
      persistPiSessions: this.options.persistPiSessions === true,
      agentLoopIsolation: this.options.agentLoopIsolation ?? 'in-process',
      thinkingLevel: this.resolveThinkingLevel(config),
    });
  }

  private hashSecret(value: string | undefined): string {
    return value
      ? crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)
      : '';
  }

  private toPiMessages(
    conversation: RunConversationMessage[],
    config: { api: PiApi; provider: string; model: PiModel },
  ): PiMessage[] {
    return conversation.map((message) => {
      if (message.role === 'user') {
        return {
          role: 'user',
          content: [{ type: 'text', text: message.text }],
          timestamp: message.createdAt * 1000,
        };
      }
      return {
        role: 'assistant',
        content: [{ type: 'text', text: message.text }],
        api: config.api,
        provider: config.provider,
        model: config.model.id,
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
        timestamp: message.createdAt * 1000,
      };
    });
  }

  private async prepareWorkspace(input: RunExecutionInput): Promise<MaterializedWorkspace> {
    const source = await this.resolveWorkspaceSource(input.threadId, input.config.workspace, input.config);
    return this.solidfs.prepare({
      run: {
        id: input.runId,
        workspace: input.config.workspace,
      },
      workspace: input.config.workspace,
      sourcePath: source.sourcePath,
      projection: this.options.solidfsProjection ?? 'direct',
      context: input.context,
    });
  }

  private async resolveWorkspaceSource(
    threadId: string,
    workspace: WorkspaceRef,
    config?: AgentRuntimeConfig,
  ): Promise<{ sourcePath?: string }> {
    const url = new URL(workspace);
    let sourcePath: string | undefined;

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const mapped = this.mapPodUrlToLocalPath(workspace);
      if (!mapped || !fs.existsSync(mapped)) {
        throw new WaitingRunnerError(workspace, `Workspace is not mounted on this runner: ${workspace}`);
      }
      sourcePath = mapped;
    } else if (url.protocol === 'file:') {
      if (!this.canResolveFileWorkspace(url)) {
        throw new WaitingRunnerError(workspace, `Waiting for a runner that can resolve workspace ${workspace}`);
      }
      sourcePath = decodeURIComponent(url.pathname);
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`workspace reference does not exist on this runner: ${workspace}`);
      }
    } else {
      throw new Error(`Unsupported workspace reference protocol: ${url.protocol}`);
    }

    const worktree = config?.worktree;
    if (!worktree) {
      return { sourcePath };
    }

    const repoRoot = sourcePath;
    if (!repoRoot) {
      throw new Error(`Cannot create worktree without a local workspace source: ${workspace}`);
    }

    if (worktree.mode === 'existing') {
      if (!fs.existsSync(worktree.path)) {
        throw new Error(`worktree.path not found: ${worktree.path}`);
      }
      return { sourcePath: worktree.path };
    }

    await this.git.assertGitRepo(repoRoot);

    const root = path.join(repoRoot, '.xpod-worktrees');
    const worktreePath = path.join(root, threadId);

    if (fs.existsSync(worktreePath)) {
      return { sourcePath: worktreePath };
    }

    await this.git.createWorktree({
      repoPath: repoRoot,
      worktreePath,
      baseRef: worktree.baseRef ?? 'main',
      branch: worktree.branch,
    });

    return { sourcePath: worktreePath };
  }

  private canResolveFileWorkspace(url: URL): boolean {
    const authority = url.hostname;
    if (!authority || authority === 'localhost') {
      return true;
    }
    const configured = process.env.XPOD_RUNNER_AUTHORITY?.trim();
    return authority === configured || authority === os.hostname();
  }

  private mapPodUrlToLocalPath(rootUrl: string): string | undefined {
    const rootFilePath = process.env.CSS_ROOT_FILE_PATH;
    const baseUrl = process.env.CSS_BASE_URL;
    if (!rootFilePath || !baseUrl) {
      return undefined;
    }

    try {
      const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
      const pod = new URL(rootUrl.endsWith('/') ? rootUrl : `${rootUrl}/`);
      if (base.origin !== pod.origin) {
        return undefined;
      }
      if (!pod.pathname.startsWith(base.pathname)) {
        return undefined;
      }
      const relativePath = decodeURIComponent(pod.pathname.slice(base.pathname.length)).replace(/\/+$/, '');
      const resolvedRoot = path.resolve(rootFilePath);
      const resolved = path.resolve(resolvedRoot, relativePath);
      if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
        return undefined;
      }
      return resolved;
    } catch {
      return undefined;
    }
  }

  private createSessionManager(pi: PiSdk, runId: string, workdir: string): ReturnType<PiSdk['SessionManager']['inMemory']> {
    if (this.options.persistPiSessions) {
      return pi.SessionManager.create(workdir, this.resolveSessionDir(runId, workdir));
    }
    return pi.SessionManager.inMemory(workdir);
  }

  private resolveSessionDir(runId: string, workdir: string): string {
    const root = this.options.sessionRootDir ?? path.join(os.tmpdir(), 'xpod-pi-sessions');
    const hash = crypto.createHash('sha256').update(`${workdir}:${runId}`).digest('hex').slice(0, 20);
    return path.join(root, hash);
  }

  private resolveWorkerPath(): string {
    if (this.options.workerPath) {
      return this.options.workerPath;
    }
    return path.join(__dirname, `PiAgentRuntimeWorker${path.extname(__filename)}`);
  }

  private workerEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
    env.XPOD_AGENT_LOOP_WORKER = '1';
    return env;
  }

  private extractText(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    if (!Array.isArray(content)) {
      return '';
    }
    return content
      .map((part) => {
        if (part && typeof part === 'object' && (part as any).type === 'text') {
          return typeof (part as any).text === 'string' ? (part as any).text : '';
        }
        return '';
      })
      .join('');
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private startupErrorToEvent(error: unknown): AgentRuntimeEvent {
    if (error instanceof WaitingRunnerError) {
      return {
        type: 'waiting_runner',
        workspace: error.workspace,
        message: error.message,
      };
    }
    return { type: 'error', message: this.formatError(error) };
  }

  private logWorkspaceRollbackError(error: unknown): void {
    console.warn(`SolidFS rollback failed: ${this.formatError(error)}`);
  }

  private async loadPiSdk(): Promise<PiSdk> {
    if (this.options.piSdk) {
      return this.options.piSdk;
    }
    if (PiAgentRuntimeDriver.sdkPromise) {
      return PiAgentRuntimeDriver.sdkPromise;
    }
    // Keep a native dynamic import so the CommonJS build can lazily load pi's
    // ESM-only package instead of requiring it during CSS component discovery.
    const nativeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<PiSdk>;
    PiAgentRuntimeDriver.sdkPromise = nativeImport('@mariozechner/pi-coding-agent');
    return PiAgentRuntimeDriver.sdkPromise;
  }
}

export const PI_AGENT_WORKER_EVENT_PREFIX = 'XPOD_AGENT_EVENT ';

class WaitingRunnerError extends Error {
  public constructor(
    public readonly workspace: WorkspaceRef,
    message: string,
  ) {
    super(message);
  }
}

class AsyncPushQueue<T> {
  private readonly items: T[] = [];
  private resolvers: Array<() => void> = [];
  private closed = false;

  public push(item: T): void {
    if (this.closed) {
      return;
    }
    this.items.push(item);
    const resolver = this.resolvers.shift();
    resolver?.();
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const resolver of this.resolvers) {
      resolver();
    }
    this.resolvers = [];
  }

  public async *iterate(): AsyncIterable<T> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve) => this.resolvers.push(resolve));
    }
  }
}
