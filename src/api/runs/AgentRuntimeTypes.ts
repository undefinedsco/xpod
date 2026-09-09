import type { ResolvedAgentConfig } from '../../agents/config/types';
import type { AIConnectionInvocationConfig } from '../../agents/types';
import type { WorkspaceRef } from '../workspace/types';

export type RunnerProtocol = 'pi' | 'acp';
export type AcpRunnerType = 'codebuddy' | 'claude' | 'codex';
export type RunnerType = 'pi' | AcpRunnerType;

export type WorktreeSpec =
  | { mode: 'existing'; path: string }
  | { mode: 'create'; baseRef?: string; branch?: string };

/**
 * Canonical workspace reference for a Run.
 *
 * This is a workspace Container reference, not an execution config object.
 * Stable workspace metadata belongs on the Container .meta resource. Runners
 * resolve this reference into their own local cwd before starting the Agent Loop.
 */
export interface AgentRuntimeConfig {
  workspace: WorkspaceRef;
  /**
   * Optional execution policy for git workspaces. The workspace field still
   * points at the repo/workspace resource; this only selects the cwd used by a run.
   */
  worktree?: WorktreeSpec;
  /**
   * Stream idle cutoff for agent output. If no output arrives within this window,
   * the current streaming response ends.
   *
   * Defaults to 500ms for tests; real agents may need a larger value.
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
     * pi: request-scoped pi AgentSession restored from Xpod Run/Thread/Message state.
     * acp: protocol adapter over JSON-RPC (Agent Client Protocol) stdio runners.
     */
    protocol?: RunnerProtocol;
    argv?: string[];
    allowCustomArgv?: boolean;
  };
  /**
   * Resolved non-secret agent profile from /agents/{agentId}/AGENTS.md + .meta.
   */
  agentConfig?: ResolvedAgentConfig;
  /**
   * Invocation-scoped Xpod AI Connection. Model runners fail closed without it;
   * raw Pod provider credentials must never be placed in agentConfig.
   */
  aiConnection?: AIConnectionInvocationConfig;
}

export type PersistedAgentRuntimeConfig = Omit<AgentRuntimeConfig, 'aiConnection'> & {
  aiConnection?: Omit<AIConnectionInvocationConfig, 'apiKey'>;
};

/**
 * Runtime config persisted with a Run is a non-secret binding description.
 * The API key is restored from the current execution context on each
 * initial or continuation invocation.
 */
export function toPersistedAgentRuntimeConfig(config: AgentRuntimeConfig): PersistedAgentRuntimeConfig {
  return deepScrubApiKey(config) as PersistedAgentRuntimeConfig;
}

export function withInvocationAiConnections<TContext>(
  config: AgentRuntimeConfig | PersistedAgentRuntimeConfig,
  context: TContext | undefined,
): AgentRuntimeConfig {
  const persisted = toPersistedAgentRuntimeConfig(config as AgentRuntimeConfig);
  const invocation = readInvocationAiConnections(context);
  return {
    ...persisted,
    ...(invocation ? {
      aiConnection: {
        ...persisted.aiConnection,
        ...invocation,
      },
    } : {}),
  } as AgentRuntimeConfig;
}

export function deepScrubApiKey<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepScrubApiKey(item)) as T;
  }
  if (!value || typeof value !== 'object' || value instanceof Date) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'apiKey') {
      continue;
    }
    output[key] = deepScrubApiKey(item);
  }
  return output as T;
}

function readInvocationAiConnections<TContext>(context: TContext | undefined): AIConnectionInvocationConfig | undefined {
  if (!context || typeof context !== 'object') {
    return undefined;
  }
  const candidate = (context as Record<string, unknown>).aiConnection;
  if (!candidate || typeof candidate !== 'object') {
    return undefined;
  }
  const value = candidate as Record<string, unknown>;
  if (
    typeof value.baseUrl !== 'string'
    || value.baseUrl.trim().length === 0
    || typeof value.apiKey !== 'string'
    || value.apiKey.trim().length === 0
  ) {
    return undefined;
  }
  return {
    baseUrl: value.baseUrl,
    apiKey: value.apiKey,
    ...(typeof value.model === 'string' && value.model.trim().length > 0 ? { model: value.model } : {}),
  };
}

export type AgentRuntimeEvent =
  | { type: 'text'; text: string }
  | { type: 'error'; message: string }
  | {
    type: 'waiting_runner';
    workspace: WorkspaceRef;
    message: string;
  }
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
