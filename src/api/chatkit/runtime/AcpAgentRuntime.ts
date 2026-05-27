import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { getLoggerFor } from 'global-logger-factory';
import type { WorkspaceRef } from '../../workspace/types';
import { getPlatformApiBaseUrl } from '../../service/platform-ai-config';
import { PACKAGE_ROOT } from '../../../runtime';
import { GitWorktreeService } from './GitWorktreeService';
import { AcpRunner } from './AcpRunner';
import { CodexRuntimeProjector } from './CodexRuntimeProjector';
import type { ResolvedAgentConfig } from '../../../agents/config/types';
import type { McpServerConfig } from '../../../agents/types';
import { codexWireApi, getDefaultBaseUrl } from '../../service/provider-registry';
import type {
  AcpRunnerType,
  AgentRuntimeConfig,
  AgentRuntimeEvent,
} from '../../runs/AgentRuntimeTypes';

interface AgentRuntimeRunInput {
  threadId: string;
  prompt: string;
  config: AgentRuntimeConfig;
}

/**
 * Request-scoped ACP Agent Runtime.
 *
 * This class intentionally keeps no per-thread runner/session map. Durable
 * conversation state belongs in the Pod; each invocation starts an ACP runner,
 * creates one ACP session, streams events, then stops the runner.
 */
export class AcpAgentRuntime {
  private readonly logger = getLoggerFor(this);
  private readonly git = new GitWorktreeService();
  private readonly codexProjector = new CodexRuntimeProjector();

  public constructor(
    private readonly options: {
      worktreeRootDirName?: string;
    } = {},
  ) {}

  public async *run(input: AgentRuntimeRunInput): AsyncIterable<AgentRuntimeEvent> {
    const { threadId, prompt, config } = input;
    const workdir = await this.resolveWorkdir(threadId, config.workspace, config);

    if (config.runner.protocol && config.runner.protocol !== 'acp') {
      throw new Error(`Unsupported runner protocol: ${config.runner.protocol}. Only 'acp' is supported.`);
    }

    const runnerType = this.resolveAcpRunnerType(config.runner.type);
    const argv = this.resolveRunnerArgv(runnerType, config.runner.argv);
    const command = argv[0];
    const args = argv.slice(1);
    const env = this.buildRunnerEnv(runnerType, threadId, workdir, config.agentConfig);
    const runner = new AcpRunner();
    const queue = new AsyncPushQueue<AgentRuntimeEvent>();

    try {
      runner.start({ command, args, cwd: workdir, env });

      const sessionId = await this.createSession(runner, workdir, config.agentConfig);
      const runPromise = this.runPrompt(runner, sessionId, prompt, {
        idleMs: config.idleMs ?? 500,
        authWaitMs: Math.max(config.authWaitMs ?? 300_000, config.idleMs ?? 500),
        queue,
      }).catch((error) => {
        queue.push({ type: 'error', message: this.formatError(error) });
        queue.close();
      });

      for await (const event of queue.iterate()) {
        yield event;
      }
      await runPromise;
    } catch (error: any) {
      const message = this.formatError(error);
      this.logger.warn(`ACP agent runtime failed: ${message}`);
      yield { type: 'error', message };
    } finally {
      runner.stop('SIGINT');
    }
  }

  private async createSession(
    runner: AcpRunner,
    workdir: string,
    agentConfig?: ResolvedAgentConfig,
  ): Promise<string> {
    await runner.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'xpod', version: 'dev' },
    });

    const sessionParams: Record<string, unknown> = { cwd: workdir };
    if (agentConfig) {
      sessionParams.mcpServers = Object.keys(agentConfig.mcpServers).length > 0
        ? this.convertMcpServersForAcp(agentConfig.mcpServers)
        : [];
      if (agentConfig.systemPrompt) sessionParams.systemPrompt = agentConfig.systemPrompt;
      if (agentConfig.skillsContent) sessionParams.appendSystemPrompt = agentConfig.skillsContent;
      if (agentConfig.maxTurns) sessionParams.maxTurns = agentConfig.maxTurns;
      if (agentConfig.allowedTools) sessionParams.allowedTools = agentConfig.allowedTools;
      if (agentConfig.disallowedTools) sessionParams.disallowedTools = agentConfig.disallowedTools;
      if (agentConfig.permissionMode) sessionParams.permissionMode = agentConfig.permissionMode;
    } else {
      sessionParams.mcpServers = [];
    }

    const newSession = await runner.request<{ sessionId: string }>('session/new', sessionParams);
    if (!newSession?.sessionId) {
      throw new Error('ACP session/new did not return sessionId');
    }
    return newSession.sessionId;
  }

  private async runPrompt(
    runner: AcpRunner,
    sessionId: string,
    prompt: string,
    options: {
      idleMs: number;
      authWaitMs: number;
      queue: AsyncPushQueue<AgentRuntimeEvent>;
    },
  ): Promise<void> {
    const { idleMs, authWaitMs, queue } = options;
    let idleTimer: NodeJS.Timeout | undefined;
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      runner.off('notification', onNotification);
      runner.off('request', onRequest);
      queue.close();
    };

    const bumpIdle = (ms: number = idleMs): void => {
      if (done) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(), ms);
    };

    const onRequest = (req: any): void => {
      if (!req || typeof req.method !== 'string') return;

      if (this.isRuntimeHandledRequest(req.method)) {
        const hint = req.params?.message || req.params?.reason || req.method;
        const url = this.extractAuthUrl(req.params);
        const authOptions =
          this.extractAuthOptions(req.params) ??
          (url ? [{ label: 'Continue in browser', url, method: req.method }] : undefined);
        queue.push({
          type: 'auth_required',
          method: req.method,
          url,
          message: typeof hint === 'string' ? hint : undefined,
          options: authOptions,
        });
        bumpIdle(authWaitMs);
        if (req.method === 'session/request_permission') {
          req.respond({ granted: true });
        } else {
          req.respond({ handled: true });
        }
        return;
      }

      const requestId = `acp:${String(req.id)}`;
      queue.push({
        type: 'tool_call',
        requestId,
        name: req.method,
        arguments: JSON.stringify(req.params ?? {}),
      });
      req.fail(-32601, `Unsupported ACP client request in stateless runtime: ${req.method}`);
      finish();
    };

    const onNotification = (method: string, params: any): void => {
      if (method !== 'session/update') return;
      if (!params || params.sessionId !== sessionId) return;

      const update = params.update;
      if (!update || typeof update !== 'object') return;

      const text = this.extractTextDeltaFromSessionUpdate(update);
      if (typeof text === 'string' && text.length > 0) {
        queue.push({ type: 'text', text });
        bumpIdle();
      }
    };

    runner.on('request', onRequest);
    runner.on('notification', onNotification);

    try {
      void runner.request('session/prompt', {
        sessionId,
        prompt: [ { type: 'text', text: prompt } ],
      }).then((result) => {
        const text = this.extractTextFromPromptResult(result);
        if (typeof text === 'string' && text.length > 0) {
          queue.push({ type: 'text', text });
          bumpIdle();
        } else {
          bumpIdle();
        }
      }).catch((error) => {
        if (!done) {
          queue.push({ type: 'error', message: this.formatError(error) });
          finish();
        }
      });
      bumpIdle();
      await queue.waitClosed();
    } finally {
      finish();
    }
  }

  private isRuntimeHandledRequest(method: string): boolean {
    return method === 'session/request_permission' ||
      method === 'auth/request' ||
      method === 'auth/authorize';
  }

  private async resolveWorkdir(threadId: string, workspace: WorkspaceRef, config: AgentRuntimeConfig): Promise<string> {
    const url = new URL(workspace);
    if (url.protocol !== 'file:') {
      throw new Error('ACP runtime only supports file:// workspaces; use pi Agent Runtime for Pod-backed runs');
    }
    if (!this.canResolveFileWorkspace(url)) {
      throw new Error(`Workspace is not resolvable by this ACP runner: ${workspace}`);
    }

    const repoRoot = decodeURIComponent(url.pathname);
    if (!fs.existsSync(repoRoot)) {
      throw new Error(`workspace reference does not exist on this runner: ${workspace}`);
    }

    const worktree = config.worktree;
    if (!worktree) {
      return repoRoot;
    }

    if (worktree.mode === 'existing') {
      if (!fs.existsSync(worktree.path)) {
        throw new Error(`worktree.path not found: ${worktree.path}`);
      }
      return worktree.path;
    }

    await this.git.assertGitRepo(repoRoot);

    const rootDirName = this.options.worktreeRootDirName ?? '.xpod-worktrees';
    const root = path.join(repoRoot, rootDirName);
    const worktreePath = path.join(root, threadId);

    if (fs.existsSync(worktreePath)) {
      return worktreePath;
    }

    const baseRef = worktree.baseRef ?? 'main';
    await this.git.createWorktree({
      repoPath: repoRoot,
      worktreePath,
      baseRef,
      branch: worktree.branch,
    });

    return worktreePath;
  }

  private canResolveFileWorkspace(url: URL): boolean {
    const authority = url.hostname;
    if (!authority || authority === 'localhost') {
      return true;
    }
    const configured = process.env.XPOD_RUNNER_AUTHORITY?.trim();
    return authority === configured || authority === os.hostname();
  }

  private resolveAcpRunnerType(type: string): AcpRunnerType {
    if (type === 'codebuddy' || type === 'claude' || type === 'codex') {
      return type;
    }
    throw new Error(`Unsupported ACP runner type: ${type}`);
  }

  private resolveRunnerArgv(type: AcpRunnerType, argv?: string[]): string[] {
    if (argv && argv.length > 0) {
      return argv;
    }
    switch (type) {
      case 'codebuddy':
        return [ this.resolveLocalBin('codebuddy'), '--acp' ];
      case 'claude':
        return [ this.resolveLocalBin('claude-code-acp') ];
      case 'codex':
        return [ this.resolveLocalBin('codex-acp') ];
      default:
        return [ type ];
    }
  }

  private resolveLocalBin(binName: string): string {
    const localBin = path.join(PACKAGE_ROOT, 'node_modules', '.bin', binName);
    if (fs.existsSync(localBin)) {
      return localBin;
    }
    return binName;
  }

  private buildRunnerEnv(
    type: AcpRunnerType,
    threadId: string,
    workdir: string,
    agentConfig?: ResolvedAgentConfig,
  ): Record<string, string | undefined> | undefined {
    const defaultApiKey = agentConfig?.apiKey || process.env.DEFAULT_API_KEY?.trim();
    const rawApiBase = agentConfig?.baseUrl || getPlatformApiBaseUrl();
    const defaultModel = agentConfig?.model || process.env.DEFAULT_MODEL?.trim();

    if (type === 'codebuddy') {
      return undefined;
    }

    const home = this.getIsolatedHomeDir(type, threadId, workdir);

    if (type === 'codex') {
      const defaultApiBase = rawApiBase || getDefaultBaseUrl();
      const codexHome = path.join(home, '.codex');
      this.codexProjector.project({
        codexHome,
        baseUrl: defaultApiBase,
        apiKey: defaultApiKey,
        wireApi: codexWireApi(defaultApiBase),
        model: defaultModel,
        agentConfig,
      });
      const env: Record<string, string | undefined> = {
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_STATE_HOME: path.join(home, '.local', 'state'),
        XDG_DATA_HOME: path.join(home, '.local', 'share'),
        XDG_CACHE_HOME: path.join(home, '.cache'),
        CODEX_HOME: codexHome,
      };
      if (defaultApiKey) {
        env.CODEX_API_KEY = defaultApiKey;
        env.OPENAI_API_KEY = defaultApiKey;
      }
      env.OPENAI_BASE_URL = defaultApiBase;
      env.OPENAI_API_BASE = defaultApiBase;
      if (defaultModel) {
        env.OPENAI_MODEL = defaultModel;
        env.CODEX_MODEL = defaultModel;
      }
      return env;
    }

    const defaultApiBase = rawApiBase || getDefaultBaseUrl();
    const env: Record<string, string | undefined> = {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_STATE_HOME: path.join(home, '.local', 'state'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
    };
    const normalizedBase = defaultApiBase ? this.normalizeClaudeBaseUrl(defaultApiBase) : undefined;
    const isOpenRouterLike =
      (typeof normalizedBase === 'string' && normalizedBase.includes('openrouter.ai'));

    if (defaultApiKey) {
      if (isOpenRouterLike) {
        env.ANTHROPIC_AUTH_TOKEN = defaultApiKey;
        delete env.ANTHROPIC_API_KEY;
      } else {
        env.ANTHROPIC_API_KEY = defaultApiKey;
        delete env.ANTHROPIC_AUTH_TOKEN;
      }
    }
    if (normalizedBase) {
      env.ANTHROPIC_BASE_URL = normalizedBase;
    }
    if (defaultModel) {
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = defaultModel;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = defaultModel;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = defaultModel;
    }
    return env;
  }

  private getIsolatedHomeDir(type: Exclude<AcpRunnerType, 'codebuddy'>, threadId: string, workdir: string): string {
    const hash = crypto.createHash('sha256').update(`${type}:${threadId}:${workdir}`).digest('hex').slice(0, 16);
    const root = path.join(os.tmpdir(), 'xpod-acp-home', type, hash);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  private normalizeClaudeBaseUrl(baseUrl: string): string {
    if (baseUrl.endsWith('/v1')) {
      return baseUrl.slice(0, -3);
    }
    if (baseUrl.endsWith('/v1/')) {
      return baseUrl.slice(0, -4);
    }
    return baseUrl;
  }

  private convertMcpServersForAcp(
    servers: Record<string, McpServerConfig>,
  ): Array<Record<string, unknown>> {
    return Object.entries(servers).map(([name, config]) => ({
      name,
      ...config,
    }));
  }

  private extractTextDeltaFromSessionUpdate(update: any): string | undefined {
    if (!update) return undefined;

    if (typeof update === 'string') return update;
    if (typeof update.delta === 'string') return update.delta;
    if (typeof update.text === 'string') return update.text;

    const content = update.content?.content ?? update.content;
    if (typeof content === 'string') return content;
    if (content && typeof content === 'object') {
      if (typeof content.text === 'string') return content.text;
      if (Array.isArray(content)) {
        const parts = content
          .map((part: any) => (part && typeof part === 'object' ? part.text : undefined))
          .filter((text: any) => typeof text === 'string');
        if (parts.length) return parts.join('');
      }
    }

    const message = update.message ?? update.item ?? update.assistant_message;
    if (message && typeof message === 'object') {
      const msgContent = message.content?.content ?? message.content;
      if (typeof msgContent === 'string') return msgContent;
      if (Array.isArray(msgContent)) {
        const parts = msgContent
          .map((part: any) => {
            if (!part || typeof part !== 'object') return undefined;
            if (typeof part.text === 'string') return part.text;
            if (typeof part.delta === 'string') return part.delta;
            return undefined;
          })
          .filter((text: any) => typeof text === 'string');
        if (parts.length) return parts.join('');
      }
    }

    return undefined;
  }

  private extractTextFromPromptResult(result: any): string | undefined {
    if (!result) return undefined;
    if (typeof result === 'string') return result;

    if (typeof result.text === 'string') return result.text;
    if (typeof result.output_text === 'string') return result.output_text;

    const message = result.message ?? result.item ?? result.assistant_message;
    if (message && typeof message === 'object') {
      const msgContent = message.content?.content ?? message.content;
      if (typeof msgContent === 'string') return msgContent;
      if (Array.isArray(msgContent)) {
        const parts = msgContent
          .map((part: any) => (part && typeof part === 'object' ? (typeof part.text === 'string' ? part.text : undefined) : undefined))
          .filter((text: any) => typeof text === 'string');
        if (parts.length) return parts.join('');
      }
    }

    const content = result.content?.content ?? result.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts = content
        .map((part: any) => (part && typeof part === 'object' ? (typeof part.text === 'string' ? part.text : undefined) : undefined))
        .filter((text: any) => typeof text === 'string');
      if (parts.length) return parts.join('');
    }

    return undefined;
  }

  private extractAuthUrl(params: any): string | undefined {
    if (!params || typeof params !== 'object') return undefined;
    const candidates = [
      params.url,
      params.authorizationUrl,
      params.authorization_url,
      params.authUrl,
      params.auth_url,
      params.browserUrl,
      params.browser_url,
      params.verification_uri,
      params.verificationUri,
      params.verificationUrl,
    ];
    return candidates.find((value) => typeof value === 'string' && value.startsWith('http'));
  }

  private extractAuthOptions(params: any): Array<{ label?: string; url?: string; method?: string }> | undefined {
    if (!params || typeof params !== 'object') return undefined;

    const raw =
      Array.isArray((params as any).methods) ? (params as any).methods
      : Array.isArray((params as any).options) ? (params as any).options
      : Array.isArray((params as any).authMethods) ? (params as any).authMethods
      : Array.isArray((params as any).auth_methods) ? (params as any).auth_methods
      : undefined;

    if (!raw) return undefined;

    const options = raw
      .map((method: any) => {
        if (!method || typeof method !== 'object') return undefined;
        const url = this.extractAuthUrl(method);
        const label =
          typeof method.label === 'string' ? method.label :
          typeof method.name === 'string' ? method.name :
          typeof method.type === 'string' ? method.type :
          undefined;
        const optionMethod =
          typeof method.method === 'string' ? method.method :
          typeof method.type === 'string' ? method.type :
          undefined;
        return { label, url, method: optionMethod };
      })
      .filter(Boolean) as Array<{ label?: string; url?: string; method?: string }>;

    return options.length > 0 ? options : undefined;
  }

  private formatError(error: unknown): string {
    const anyError = error as any;
    const dataMessage =
      anyError?.data && typeof anyError.data === 'object' && typeof anyError.data.message === 'string'
        ? anyError.data.message
        : undefined;
    const message = String(anyError?.message ?? error);
    return dataMessage ? `${message} | data.message=${dataMessage.slice(0, 800)}` : message;
  }
}

class AsyncPushQueue<T> {
  private readonly items: T[] = [];
  private resolvers: Array<() => void> = [];
  private closed = false;
  private closeResolvers: Array<() => void> = [];

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
    for (const resolver of this.closeResolvers) {
      resolver();
    }
    this.closeResolvers = [];
  }

  public async waitClosed(): Promise<void> {
    if (this.closed) {
      return;
    }
    await new Promise<void>((resolve) => this.closeResolvers.push(resolve));
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
