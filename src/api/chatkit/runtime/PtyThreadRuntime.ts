import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { getLoggerFor } from 'global-logger-factory';
import { GitWorktreeService } from './GitWorktreeService';
import { PtyRunner } from './PtyRunner';
import { AcpRunner } from './AcpRunner';

export type RunnerType = 'codebuddy' | 'claude' | 'codex';
export type RunnerProtocol = 'raw' | 'acp';

export type WorktreeSpec =
  | { mode: 'existing'; path: string }
  | { mode: 'create'; baseRef?: string; branch?: string };

export type WorkspaceSpec =
  | { type: 'path'; rootPath: string }
  | { type: 'git'; rootPath: string; worktree: WorktreeSpec };

export interface PtyRuntimeConfig {
  workspace: WorkspaceSpec;
  runner: {
    type: RunnerType;
    /**
     * raw: write plain text to stdin (legacy mode)
     * acp: JSON-RPC (Agent Client Protocol) over stdio (recommended)
     */
    protocol?: RunnerProtocol;
    argv?: string[];
  };
}

export interface PtyThreadRuntimeState {
  workdir: string;
  runnerType: RunnerType;
  protocol: RunnerProtocol;
  argv: string[];
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
  private readonly runtimes = new Map<string, {
    runner: PtyRunner | AcpRunner;
    state: PtyThreadRuntimeState;
    acp?: {
      sessionId: string;
    };
    jobs: Array<PtyJob>;
    processing: boolean;
  }>();

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

    const protocol: RunnerProtocol = cfg.runner.protocol ?? 'raw';
    const argv = this.resolveRunnerArgv(cfg.runner.type, protocol, cfg.runner.argv);
    const command = argv[0];
    const args = argv.slice(1);

    if (protocol === 'acp') {
      const runner = new AcpRunner();
      runner.start({ command, args, cwd: workdir });

      // ACP handshake + session creation (one session per thread).
      // We intentionally keep capabilities minimal to avoid the agent calling back into the server.
      await runner.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'xpod', version: 'dev' },
      });
      const newSession = await runner.request<{ sessionId: string }>('session/new', { cwd: workdir });
      if (!newSession?.sessionId) {
        throw new Error('ACP session/new did not return sessionId');
      }

      const state: PtyThreadRuntimeState = { workdir, runnerType: cfg.runner.type, protocol, argv };
      this.runtimes.set(threadId, {
        runner,
        state,
        acp: { sessionId: newSession.sessionId },
        jobs: [],
        processing: false,
      });
      return state;
    } else {
      const runner = new PtyRunner();
      runner.start({ command, args, cwd: workdir });

      const state: PtyThreadRuntimeState = { workdir, runnerType: cfg.runner.type, protocol, argv };
      this.runtimes.set(threadId, { runner, state, jobs: [], processing: false });
      return state;
    }
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
  sendMessage(threadId: string, text: string, options?: { idleMs?: number }): AsyncIterable<string> {
    const rt = this.runtimes.get(threadId);
    if (!rt) {
      throw new Error('PTY runtime is not started');
    }
    const idleMs = options?.idleMs ?? 500;
    const q = new AsyncPushQueue<string>();
    rt.jobs.push({ input: text, idleMs, queue: q });
    void this.processJobs(threadId);
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
        if (rt.state.protocol === 'acp') {
          await this.runJobAcp(rt, job);
        } else {
          await this.runJobRaw(rt.runner as PtyRunner, job);
        }
      }
    } finally {
      rt.processing = false;
    }
  }

  private async runJobRaw(runner: PtyRunner, job: PtyJob): Promise<void> {
    let idleTimer: NodeJS.Timeout | undefined;
    let done = false;

    const finish = (): void => {
      if (done) {
        return;
      }
      done = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      job.queue.close();
    };

    const onData = (data: string): void => {
      job.queue.push(data);
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => finish(), job.idleMs);
    };

    runner.on('data', onData);
    try {
      runner.write(`${job.input}\n`);
      // If there is no output at all, we still complete the job after idleMs.
      idleTimer = setTimeout(() => finish(), job.idleMs);

      await job.queue.waitClosed();
    } finally {
      runner.off('data', onData);
      finish();
    }
  }

  private async runJobAcp(
    rt: {
      runner: PtyRunner | AcpRunner;
      state: PtyThreadRuntimeState;
      acp?: { sessionId: string };
    },
    job: PtyJob,
  ): Promise<void> {
    const runner = rt.runner as AcpRunner;
    const sessionId = rt.acp?.sessionId;
    if (!sessionId) {
      throw new Error('ACP runtime missing sessionId');
    }

    // For MVP:
    // - auto-ack common "permission" style requests, so agents don't deadlock
    // - surface text chunks from session/update notifications
    const onRequest = (req: any): void => {
      if (!req || typeof req.method !== 'string') return;
      if (req.method === 'session/request_permission' || req.method === 'auth/request' || req.method === 'auth/authorize') {
        const hint = req.params?.message || req.params?.reason || req.params?.url || req.method;
        job.queue.push(`[AUTH] ${String(hint)}\n`);
        // Default policy: allow. (Local-only; callers can override by adding a request handler later.)
        req.respond({ granted: true });
        return;
      }
      req.fail(-32601, `Method not found: ${req.method}`);
    };

    const onNotification = (method: string, params: any): void => {
      if (method !== 'session/update') return;
      if (!params || params.sessionId !== sessionId) return;

      const update = params.update;
      if (!update || typeof update !== 'object') return;

      // Support both shapes:
      // - { type: 'agent_message_chunk', ... } (older)
      // - { sessionUpdate: 'agent_message_chunk', ... } (spec-ish)
      const kind = (update as any).sessionUpdate ?? (update as any).type;
      if (kind === 'agent_message_chunk') {
        const content = (update as any).content?.content ?? (update as any).content;
        if (content?.type === 'text' && typeof content.text === 'string') {
          job.queue.push(content.text);
        }
      }
    };

    runner.on('request', onRequest);
    runner.on('notification', onNotification);
    try {
      await runner.request('session/prompt', {
        sessionId,
        prompt: [ { type: 'text', text: job.input } ],
      });
    } finally {
      runner.off('notification', onNotification);
      runner.off('request', onRequest);
      job.queue.close();
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

  private resolveRunnerArgv(type: RunnerType, protocol: RunnerProtocol, argv?: string[]): string[] {
    if (argv && argv.length > 0) {
      return argv;
    }
    switch (type) {
      case 'codebuddy':
        return protocol === 'acp'
          ? [ 'codebuddy', '--acp' ]
          : [ 'codebuddy', '--print', '--output-format', 'stream-json' ];
      case 'claude':
        return protocol === 'acp'
          ? [ 'claude-code-acp' ] // from @zed-industries/claude-code-acp
          : [ 'claude' ];
      case 'codex':
        return protocol === 'acp'
          ? [ 'codex-acp' ] // from @zed-industries/codex-acp
          : [ 'codex' ];
      default:
        return [ type ];
    }
  }
}

interface PtyJob {
  input: string;
  idleMs: number;
  queue: AsyncPushQueue<string>;
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
