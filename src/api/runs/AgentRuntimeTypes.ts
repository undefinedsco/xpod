import type { ResolvedAgentConfig } from '../../agents/config/types';
import type { WorkspaceUri } from '../workspace/types';

export type RunnerProtocol = 'pi' | 'acp';
export type AcpRunnerType = 'codebuddy' | 'claude' | 'codex';
export type RunnerType = 'pi' | AcpRunnerType;

export type WorktreeSpec =
  | { mode: 'existing'; path: string }
  | { mode: 'create'; baseRef?: string; branch?: string };

/**
 * Canonical workspace reference for a Run.
 *
 * This is an RDF URI reference to a workspace Container, not an execution
 * config object. Stable workspace metadata belongs on the Container .meta
 * resource. Runners resolve this URI into their own local cwd before starting
 * the Agent Loop.
 */
export interface AgentRuntimeConfig {
  workspace: WorkspaceUri;
  /**
   * Optional execution policy for git workspaces. The workspace field still
   * points at the repo/workspace URI; this only selects the cwd used by a run.
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
   * Resolved agent configuration from /agents/{agentId}/AGENTS.md + .meta.
   * When provided, credentials/model/MCP servers/system prompt come from here
   * instead of DEFAULT_* environment variables.
   */
  agentConfig?: ResolvedAgentConfig;
}

export type AgentRuntimeEvent =
  | { type: 'text'; text: string }
  | { type: 'error'; message: string }
  | {
    type: 'waiting_runner';
    workspace: WorkspaceUri;
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
