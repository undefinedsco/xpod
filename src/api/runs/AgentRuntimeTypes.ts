import type { ResolvedAgentConfig } from '../../agents/config/types';
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
}

export type PersistedAgentRuntimeConfig = AgentRuntimeConfig;

/**
 * Runtime config persisted with a Run is a non-secret execution description.
 */
export function toPersistedAgentRuntimeConfig(config: AgentRuntimeConfig): PersistedAgentRuntimeConfig {
  return { ...config };
}

/**
 * Runtime state is allowed to describe execution, but not carry provider secrets.
 */
export function deepScrubAgentRuntimeSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepScrubAgentRuntimeSecrets(item)) as T;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const scrubbed: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isRuntimeSecretKey(key)) {
      continue;
    }
    scrubbed[key] = deepScrubAgentRuntimeSecrets(nested);
  }
  return scrubbed as T;
}

function isRuntimeSecretKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === 'apikey' ||
    normalized === 'authorization' ||
    normalized === 'clientsecret' ||
    normalized === 'accesstoken' ||
    normalized === 'refreshtoken';
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
