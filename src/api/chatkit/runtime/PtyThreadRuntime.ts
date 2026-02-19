import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { getLoggerFor } from 'global-logger-factory';
import { PACKAGE_ROOT } from '../../../runtime';
import { GitWorktreeService } from './GitWorktreeService';
import { AcpRunner } from './AcpRunner';
import type { ResolvedAgentConfig } from '../../../agents/config/types';
import type { McpServerConfig } from '../../../agents/types';
import { codexWireApi, getDefaultBaseUrl } from '../../service/provider-registry';

export type RunnerType = 'codebuddy' | 'claude' | 'codex';
export type RunnerProtocol = 'acp';

export type WorktreeSpec =
  | { mode: 'existing'; path: string }
  | { mode: 'create'; baseRef?: string; branch?: string };

export type WorkspaceSpec =
  | { type: 'path'; rootPath: string }
  | { type: 'git'; rootPath: string; worktree: WorktreeSpec };

export interface PtyRuntimeConfig {
  workspace: WorkspaceSpec;
  /**
   * Stream idle cutoff for agent output. If no output arrives within this window,
   * the current streaming response ends.
   *
   * Defaults to 500ms (fast tests) but real agents may need a larger value.
   */
  idleMs?: number;
  /**
   * How long to keep the stream open after an auth_required event.
   * Defaults to 5 minutes.
   */
  authWaitMs?: number;
  runner: {
    type: RunnerType;
    /**
     * acp: JSON-RPC (Agent Client Protocol) over stdio (recommended)
     */
    protocol?: RunnerProtocol;
    argv?: string[];
  };
  /**
   * Resolved agent configuration from /agents/{agentId}/AGENT.md + .meta.
   * When provided, credentials/model/MCP servers/system prompt come from here
   * instead of DEFAULT_* environment variables.
   */
  agentConfig?: ResolvedAgentConfig;
}

export interface PtyThreadRuntimeState {
  workdir: string;
  runnerType: RunnerType;
  protocol: RunnerProtocol;
  argv: string[];
}

export type PtyRuntimeOutputEvent =
  | { type: 'text'; text: string }
  | { type: 'error'; message: string }
  | {
    type: 'auth_required';
    method: string;
    url?: string;
    message?: string;
    options?: Array<{ label?: string; url?: string; method?: string }>;
  }
  | {
    type: 'tool_call';
    requestId: string;
    name: string;
    arguments: string;
  };

interface PendingAcpRequest {
  method: string;
  params?: unknown;
  respond: (result: unknown) => void;
  fail: (code: number, message: string, data?: unknown) => void;
}

interface RuntimeEntry {
  runner: AcpRunner;
  state: PtyThreadRuntimeState;
  acp?: {
    sessionId: string;
    pendingRequests: Map<string, PendingAcpRequest>;
  };
  jobs: Array<PtyJob>;
  processing: boolean;
}

/**
 * In-memory PTY runtime manager keyed by threadId.
 *
 * Notes:
 * - Runtime state is not persisted; thread metadata can store repo/worktree hints,
 *   but PTY processes are always runtime-local.
 */
export class PtyThreadRuntime {
  private readonly logger = getLoggerFor(this);
  private readonly git = new GitWorktreeService();
  private readonly runtimes = new Map<string, RuntimeEntry>();

  constructor(
    private readonly options: {
      worktreeRootDirName?: string;
    } = {},
  ) {}

  isRunning(threadId: string): boolean {
    return Boolean(this.runtimes.get(threadId)?.runner.isRunning());
  }

  async ensureStarted(threadId: string, cfg: PtyRuntimeConfig): Promise<PtyThreadRuntimeState> {
    const existing = this.runtimes.get(threadId);
    if (existing?.runner.isRunning()) {
      return existing.state;
    }

    const workdir = await this.resolveWorkdir(threadId, cfg.workspace);
    if (cfg.workspace.type === 'git') {
      this.git.ensurePathInsideRepo(cfg.workspace.rootPath, workdir);
    }

    const protocol: RunnerProtocol = 'acp';
    if (cfg.runner.protocol && cfg.runner.protocol !== 'acp') {
      throw new Error(`Unsupported runner protocol: ${cfg.runner.protocol}. Only 'acp' is supported.`);
    }
    const argv = this.resolveRunnerArgv(cfg.runner.type, cfg.runner.argv);
    const command = argv[0];
    const args = argv.slice(1);
    const env = this.buildRunnerEnv(cfg.runner.type, threadId, workdir, cfg.agentConfig);

    const runner = new AcpRunner();
    runner.start({ command, args, cwd: workdir, env });

    // ACP handshake + session creation (one session per thread).
    // We intentionally keep capabilities minimal to avoid the agent calling back into the server.
    await runner.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'xpod', version: 'dev' },
    });
    // Build session/new params — inject MCP servers + system prompt from agent config when available.
    const sessionParams: Record<string, unknown> = { cwd: workdir };
    const ac = cfg.agentConfig;
    if (ac) {
      sessionParams.mcpServers = Object.keys(ac.mcpServers).length > 0
        ? this.convertMcpServersForAcp(ac.mcpServers)
        : [];
      if (ac.systemPrompt) sessionParams.systemPrompt = ac.systemPrompt;
      if (ac.skillsContent) sessionParams.appendSystemPrompt = ac.skillsContent;
      if (ac.maxTurns) sessionParams.maxTurns = ac.maxTurns;
      if (ac.allowedTools) sessionParams.allowedTools = ac.allowedTools;
      if (ac.disallowedTools) sessionParams.disallowedTools = ac.disallowedTools;
      if (ac.permissionMode) sessionParams.permissionMode = ac.permissionMode;
    } else {
      sessionParams.mcpServers = [];
    }
    const newSession = await runner.request<{ sessionId: string }>('session/new', sessionParams);
    if (!newSession?.sessionId) {
      throw new Error('ACP session/new did not return sessionId');
    }

    const state: PtyThreadRuntimeState = { workdir, runnerType: cfg.runner.type, protocol, argv };
    this.runtimes.set(threadId, {
      runner,
      state,
      acp: { sessionId: newSession.sessionId, pendingRequests: new Map() },
      jobs: [],
      processing: false,
    });
    return state;
  }

  stop(threadId: string): void {
    const rt = this.runtimes.get(threadId);
    if (!rt) {
      return;
    }
    rt.runner.stop('SIGINT');
  }

  /**
   * Write a message to stdin and stream back output deltas.
   * We serialize jobs per thread to reduce interleaving outputs.
   */
  sendMessage(
    threadId: string,
    text: string,
    options?: { idleMs?: number; authWaitMs?: number },
  ): AsyncIterable<PtyRuntimeOutputEvent> {
    const rt = this.runtimes.get(threadId);
    if (!rt) {
      throw new Error('PTY runtime is not started');
    }
    const idleMs = options?.idleMs ?? 500;
    const authWaitMs = Math.max(options?.authWaitMs ?? 300_000, idleMs);
    const q = new AsyncPushQueue<PtyRuntimeOutputEvent>();
    rt.jobs.push({ input: text, idleMs, authWaitMs, queue: q });
    void this.processJobs(threadId);
    return q.iterate();
  }

  respondToRequest(
    threadId: string,
    requestId: string,
    output: string,
    options?: { idleMs?: number; authWaitMs?: number },
  ): AsyncIterable<PtyRuntimeOutputEvent> {
    const rt = this.runtimes.get(threadId);
    if (!rt || rt.state.protocol !== 'acp' || !rt.acp) {
      throw new Error('ACP runtime is not started');
    }

    const pending = rt.acp.pendingRequests.get(requestId);
    if (!pending) {
      throw new Error(`ACP request not found: ${requestId}`);
    }

    const idleMs = options?.idleMs ?? 500;
    const authWaitMs = Math.max(options?.authWaitMs ?? 300_000, idleMs);
    const q = new AsyncPushQueue<PtyRuntimeOutputEvent>();
    void this.continueAfterRequestResponse(rt, pending, requestId, output, idleMs, authWaitMs, q);
    return q.iterate();
  }

  private async processJobs(threadId: string): Promise<void> {
    const rt = this.runtimes.get(threadId);
    if (!rt || rt.processing) {
      return;
    }
    rt.processing = true;

    try {
      while (rt.jobs.length > 0) {
        const job = rt.jobs.shift()!;
        await this.runJobAcp(rt, job);
      }
    } finally {
      rt.processing = false;
    }
  }

  private async runJobAcp(rt: RuntimeEntry, job: PtyJob): Promise<void> {
    const runner = rt.runner;
    const sessionId = rt.acp?.sessionId;
    if (!sessionId) {
      throw new Error('ACP runtime missing sessionId');
    }

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
      job.queue.close();
    };

    const bumpIdle = (ms: number = job.idleMs): void => {
      if (done) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(), ms);
    };

    // For MVP:
    // - auto-ack common "permission"/"auth" style requests, so agents don't deadlock
    // - surface auth-required as a structured event (so clients can click URL)
    // - surface text chunks from session/update notifications
    const onRequest = (req: any): void => {
      if (!req || typeof req.method !== 'string') return;
      if (req.method === 'session/request_permission' || req.method === 'auth/request' || req.method === 'auth/authorize') {
        const hint = req.params?.message || req.params?.reason || req.method;
        const url = this.extractAuthUrl(req.params);
        const options =
          this.extractAuthOptions(req.params) ??
          (url ? [{ label: 'Continue in browser', url, method: req.method }] : undefined);
        job.queue.push({
          type: 'auth_required',
          method: req.method,
          url,
          message: typeof hint === 'string' ? hint : undefined,
          options,
        });
        // Keep stream open longer so users can complete browser-based auth.
        bumpIdle(job.authWaitMs);
        // Ack so the runner doesn't deadlock.
        // For "permission" style requests we grant by default; for auth requests we just acknowledge handling.
        if (req.method === 'session/request_permission') {
          req.respond({ granted: true });
        } else {
          req.respond({ handled: true });
        }
        return;
      }
      // Map unknown requests to a "tool call" (client must respond via threads.add_client_tool_output).
      // We end the current stream so the client can send the follow-up request.
      const pendingId = `acp:${String(req.id)}`;
      rt.acp!.pendingRequests.set(pendingId, {
        method: req.method,
        params: req.params,
        respond: req.respond,
        fail: req.fail,
      });
      job.queue.push({
        type: 'tool_call',
        requestId: pendingId,
        name: req.method,
        arguments: JSON.stringify(req.params ?? {}),
      });
      finish();
    };

    const onNotification = (method: string, params: any): void => {
      if (method !== 'session/update') return;
      if (!params || params.sessionId !== sessionId) return;

      const update = params.update;
      if (!update || typeof update !== 'object') return;

      const text = this.extractTextDeltaFromSessionUpdate(update);
      if (typeof text === 'string' && text.length > 0) {
        job.queue.push({ type: 'text', text });
        bumpIdle();
      }
    };

    runner.on('request', onRequest);
    runner.on('notification', onNotification);
    try {
      // Don't await: some agents will block the response until tool-call requests are satisfied.
      // However, some agents (notably codex-acp) may return the final text in the response,
      // not via session/update streaming notifications. We therefore attach a best-effort
      // handler to capture text from the response when available.
      void runner.request('session/prompt', {
        sessionId,
        prompt: [ { type: 'text', text: job.input } ],
      }).then((result) => {
        const text = this.extractTextFromPromptResult(result);
        if (typeof text === 'string' && text.length > 0) {
          job.queue.push({ type: 'text', text });
          bumpIdle();
        }
      }).catch((error) => {
        if (!done) {
          this.logger.warn(`ACP session/prompt failed: ${error}`);
          const anyErr = error as any;
          const dataMsg =
            anyErr?.data && typeof anyErr.data === 'object' && typeof anyErr.data.message === 'string'
              ? anyErr.data.message
              : undefined;
          const msg = dataMsg
            ? `${String(anyErr?.message ?? error)} | data.message=${dataMsg.slice(0, 800)}`
            : String(anyErr?.message ?? error);
          job.queue.push({ type: 'error', message: msg });
          finish();
        }
      });
      // Some agents return the session/prompt response before streaming the final updates.
      // We therefore keep listening until the stream goes idle.
      bumpIdle();
      await job.queue.waitClosed();
    } finally {
      finish();
    }
  }

  private async continueAfterRequestResponse(
    rt: RuntimeEntry,
    pending: PendingAcpRequest,
    requestId: string,
    output: string,
    idleMs: number,
    authWaitMs: number,
    queue: AsyncPushQueue<PtyRuntimeOutputEvent>,
  ): Promise<void> {
    const runner = rt.runner;
    const sessionId = rt.acp?.sessionId;
    if (!sessionId || !rt.acp) {
      throw new Error('ACP runtime missing session');
    }

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
      if (req.method === 'session/request_permission' || req.method === 'auth/request' || req.method === 'auth/authorize') {
        const hint = req.params?.message || req.params?.reason || req.method;
        const url = this.extractAuthUrl(req.params);
        const options =
          this.extractAuthOptions(req.params) ??
          (url ? [{ label: 'Continue in browser', url, method: req.method }] : undefined);
        queue.push({
          type: 'auth_required',
          method: req.method,
          url,
          message: typeof hint === 'string' ? hint : undefined,
          options,
        });
        // Keep stream open longer so users can complete browser-based auth.
        bumpIdle(authWaitMs);
        if (req.method === 'session/request_permission') {
          req.respond({ granted: true });
        } else {
          req.respond({ handled: true });
        }
        return;
      }

      const nestedId = `acp:${String(req.id)}`;
      rt.acp!.pendingRequests.set(nestedId, {
        method: req.method,
        params: req.params,
        respond: req.respond,
        fail: req.fail,
      });
      queue.push({
        type: 'tool_call',
        requestId: nestedId,
        name: req.method,
        arguments: JSON.stringify(req.params ?? {}),
      });
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
      rt.acp.pendingRequests.delete(requestId);
      let result: unknown = output;
      try {
        result = JSON.parse(output);
      } catch {
        // keep raw string
      }
      pending.respond(result);
      bumpIdle();
      await queue.waitClosed();
    } finally {
      finish();
    }
  }

  private async resolveWorkdir(threadId: string, workspace: WorkspaceSpec): Promise<string> {
    if (workspace.type === 'path') {
      if (!fs.existsSync(workspace.rootPath)) {
        throw new Error(`workspace.rootPath not found: ${workspace.rootPath}`);
      }
      return workspace.rootPath;
    }

    // workspace.type === 'git'
    const repoRoot = workspace.rootPath;
    const worktree = workspace.worktree;

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

  private resolveRunnerArgv(type: RunnerType, argv?: string[]): string[] {
    if (argv && argv.length > 0) {
      return argv;
    }
    switch (type) {
      case 'codebuddy':
        return [ this.resolveLocalBin('codebuddy'), '--acp' ];
      case 'claude':
        return [ this.resolveLocalBin('claude-code-acp') ]; // from @zed-industries/claude-code-acp
      case 'codex':
        return [ this.resolveLocalBin('codex-acp') ]; // from @zed-industries/codex-acp
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
    type: RunnerType,
    threadId: string,
    workdir: string,
    agentConfig?: ResolvedAgentConfig,
  ): Record<string, string | undefined> | undefined {
    // When agentConfig is provided, use its credentials; otherwise fall back to DEFAULT_* env vars.
    const defaultApiKey = agentConfig?.apiKey || process.env.DEFAULT_API_KEY?.trim();
    const rawApiBase = agentConfig?.baseUrl || process.env.DEFAULT_API_BASE?.trim();
    const defaultModel = agentConfig?.model || process.env.DEFAULT_MODEL?.trim();

    // CodeBuddy ACP relies on its own local auth state, not OpenAI/Anthropic keys.
    if (type === 'codebuddy') {
      return undefined;
    }

    // Run external agents with an isolated HOME to avoid:
    // - polluting the user's real ~/.codex / ~/.claude state
    // - sandbox permission errors when tools try to write outside workspace roots
    const home = this.getIsolatedHomeDir(type, threadId, workdir);

    if (type === 'codex') {
      // codex-acp speaks OpenAI Responses API by default. Only api.openai.com natively supports it.
      // For all other providers, configure codex to use wire_api="chat" so it sends
      // Chat Completions requests directly to the provider instead.
      const defaultApiBase = rawApiBase || getDefaultBaseUrl();
      const codexHome = path.join(home, '.codex');
      this.ensureDir(codexHome);
      this.ensureDir(path.join(codexHome, 'skills'));
      this.ensureCodexConfigAndAuth(codexHome, {
        baseUrl: defaultApiBase,
        apiKey: defaultApiKey,
        wireApi: codexWireApi(defaultApiBase),
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
        // codex-acp advertises CODEX_API_KEY / OPENAI_API_KEY.
        env.CODEX_API_KEY = defaultApiKey;
        env.OPENAI_API_KEY = defaultApiKey;
      }
      env.OPENAI_BASE_URL = defaultApiBase;
      env.OPENAI_API_BASE = defaultApiBase;
      if (defaultModel) {
        // Best-effort: may be ignored by codex-acp depending on its config.
        env.OPENAI_MODEL = defaultModel;
        env.CODEX_MODEL = defaultModel;
      }
      return env;
    }

    // type === 'claude'
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
      // claude-code-acp is built on the Claude Agent SDK.
      // For OpenRouter, the Anthropic-compatible path is typically via AUTH_TOKEN.
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
      // Use the same model for all families to keep behavior predictable.
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = defaultModel;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = defaultModel;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = defaultModel;
    }
    return env;
  }

  private getIsolatedHomeDir(type: Exclude<RunnerType, 'codebuddy'>, threadId: string, workdir: string): string {
    // Keep it stable per thread/workdir so session state can be reused across requests,
    // but still isolated from the user's actual home.
    const hash = crypto.createHash('sha256').update(`${type}:${threadId}:${workdir}`).digest('hex').slice(0, 16);
    const root = path.join(os.tmpdir(), 'xpod-acp-home', type, hash);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  private ensureDir(dir: string): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // best-effort: agent binaries may create it themselves
    }
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

  private ensureCodexConfigAndAuth(
    codexHome: string,
    options: { baseUrl?: string; apiKey?: string; wireApi?: 'responses' | 'chat' },
  ): void {
    // codex-acp wraps Codex CLI, which primarily reads config/auth from CODEX_HOME.
    // We generate a minimal config + auth file for isolated runs so that:
    // - it doesn't depend on the developer's ~/.codex
    // - it can authenticate without interactive login
    const configPath = path.join(codexHome, 'config.toml');
    const authPath = path.join(codexHome, 'auth.json');

    try {
      const baseUrl = options.baseUrl?.trim();
      if (baseUrl) {
        const wireApi = options.wireApi ?? 'responses';
        const contents = [
          'model_provider = "codex"',
          '',
          '[model_providers.codex]',
          'name = "codex"',
          `base_url = ${JSON.stringify(baseUrl)}`,
          `wire_api = ${JSON.stringify(wireApi)}`,
          'requires_openai_auth = true',
          '',
        ].join('\n');
        fs.writeFileSync(configPath, contents, { encoding: 'utf8' });
      }
    } catch (e) {
      this.logger.debug(`Failed to write Codex config.toml: ${String(e)}`);
    }

    try {
      const apiKey = options.apiKey?.trim();
      if (apiKey) {
        // Match Codex's expected schema.
        fs.writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: apiKey }), { encoding: 'utf8' });
      }
    } catch (e) {
      this.logger.debug(`Failed to write Codex auth.json: ${String(e)}`);
    }
  }

  /**
   * Convert McpServerConfig map to ACP session/new format.
   * ACP expects an array of { name, ...config } objects.
   */
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

    // Common shapes:
    // - { sessionUpdate/type: 'agent_message_chunk', content: { type:'text', text:'...' } }
    // - { ... , delta/text/content: '...' }
    // - { ... , message: { content: [{ type:'text', text:'...' }, ...] } }
    if (typeof update === 'string') return update;
    if (typeof update.delta === 'string') return update.delta;
    if (typeof update.text === 'string') return update.text;

    const content = update.content?.content ?? update.content;
    if (typeof content === 'string') return content;
    if (content && typeof content === 'object') {
      if (typeof content.text === 'string') return content.text;
      if (Array.isArray(content)) {
        const parts = content
          .map((p: any) => (p && typeof p === 'object' ? p.text : undefined))
          .filter((t: any) => typeof t === 'string');
        if (parts.length) return parts.join('');
      }
    }

    const message = update.message ?? update.item ?? update.assistant_message;
    if (message && typeof message === 'object') {
      const msgContent = message.content?.content ?? message.content;
      if (typeof msgContent === 'string') return msgContent;
      if (Array.isArray(msgContent)) {
        const parts = msgContent
          .map((p: any) => {
            if (!p || typeof p !== 'object') return undefined;
            if (typeof p.text === 'string') return p.text;
            if (typeof p.delta === 'string') return p.delta;
            return undefined;
          })
          .filter((t: any) => typeof t === 'string');
        if (parts.length) return parts.join('');
      }
    }

    return undefined;
  }

  private extractTextFromPromptResult(result: any): string | undefined {
    if (!result) return undefined;
    if (typeof result === 'string') return result;

    // Common shapes observed in ACP implementations:
    // - { message: { content: [{ type:'text', text:'...' }, ...] } }
    // - { output_text: '...' } / { text: '...' }
    // - { content: [{...}] }
    if (typeof result.text === 'string') return result.text;
    if (typeof result.output_text === 'string') return result.output_text;

    const message = result.message ?? result.item ?? result.assistant_message;
    if (message && typeof message === 'object') {
      const msgContent = message.content?.content ?? message.content;
      if (typeof msgContent === 'string') return msgContent;
      if (Array.isArray(msgContent)) {
        const parts = msgContent
          .map((p: any) => (p && typeof p === 'object' ? (typeof p.text === 'string' ? p.text : undefined) : undefined))
          .filter((t: any) => typeof t === 'string');
        if (parts.length) return parts.join('');
      }
    }

    const content = result.content?.content ?? result.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const parts = content
        .map((p: any) => (p && typeof p === 'object' ? (typeof p.text === 'string' ? p.text : undefined) : undefined))
        .filter((t: any) => typeof t === 'string');
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
    const found = candidates.find((v) => typeof v === 'string' && v.startsWith('http'));
    return found;
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

    const opts = raw
      .map((m: any) => {
        if (!m || typeof m !== 'object') return undefined;
        const url = this.extractAuthUrl(m);
        const label =
          typeof m.label === 'string' ? m.label :
          typeof m.name === 'string' ? m.name :
          typeof m.type === 'string' ? m.type :
          undefined;
        const method =
          typeof m.method === 'string' ? m.method :
          typeof m.type === 'string' ? m.type :
          undefined;
        return { label, url, method };
      })
      .filter(Boolean) as Array<{ label?: string; url?: string; method?: string }>;

    return opts.length > 0 ? opts : undefined;
  }
}

interface PtyJob {
  input: string;
  idleMs: number;
  authWaitMs: number;
  queue: AsyncPushQueue<PtyRuntimeOutputEvent>;
}

class AsyncPushQueue<T> {
  private readonly items: T[] = [];
  private resolvers: Array<() => void> = [];
  private _closed = false;
  private closeResolvers: Array<() => void> = [];

  push(item: T): void {
    if (this._closed) {
      return;
    }
    this.items.push(item);
    const r = this.resolvers.shift();
    r?.();
  }

  close(): void {
    if (this._closed) {
      return;
    }
    this._closed = true;
    for (const r of this.resolvers) {
      r();
    }
    this.resolvers = [];
    for (const r of this.closeResolvers) {
      r();
    }
    this.closeResolvers = [];
  }

  async waitClosed(): Promise<void> {
    if (this._closed) {
      return;
    }
    await new Promise<void>((resolve) => this.closeResolvers.push(resolve));
  }

  async *iterate(): AsyncIterable<T> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this._closed) {
        return;
      }
      await new Promise<void>((resolve) => this.resolvers.push(resolve));
    }
  }
}
