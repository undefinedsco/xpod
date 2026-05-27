/**
 * Agent Configuration Types
 *
 * Pod-hosted Agent Profile model:
 * - AGENTS.md: user-editable plain Markdown guidance
 * - .meta: RDF runtime config and references to shared skill documents
 *
 * The resolver combines both into a ResolvedAgentConfig ready for an Agent Runtime.
 */

import type { McpServerConfig, ExecutorType } from '../types';

export type AgentRuntimeKind = ExecutorType | 'codex';

/**
 * MCP server definition stored as structured RDF/JSON-like fields on .meta.
 */
export interface AgentMcpServerDef {
  name: string;
  transport?: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export type AgentMcpServerInput = string | AgentMcpServerDef;

// ============================================
// .meta (server-side, resolved from Pod TTL)
// ============================================

/**
 * Agent .meta record (from Pod TTL)
 */
export interface AgentMetaRecord {
  /** Agent ID (folder name) */
  id: string;
  name?: string;
  description?: string;
  instructions?: string;
  /** URI ref → Provider */
  provider?: string;
  /** Runtime class selection */
  runtimeKind?: AgentRuntimeKind;
  /** URI ref → Credential */
  credential?: string;
  /** URI ref → Model */
  model?: string;
  enabled?: string;
  maxTurns?: number;
  timeout?: number;
  /** ACP permission mode */
  permissionMode?: string;
  /** Tool names allowed without extra prompt-time negotiation */
  allowedTools?: string[];
  /** Tool names disabled for this agent */
  disallowedTools?: string[];
  /** Skill refs, for example skills/solid-modeling, .codex/skills/local, or /skills/shared */
  skills?: string[];
  /** Structured MCP server definitions; file refs are intentionally unsupported. */
  mcpServers?: AgentMcpServerInput[];
}

// ============================================
// Resolved Agent Config (ready for runtime)
// ============================================

/**
 * Fully resolved agent configuration.
 * Combines AGENTS.md + .meta + resolved Pod references.
 * Ready to be passed to Agent Runtime / ACP session.
 */
export interface ResolvedAgentConfig {
  /** Agent ID (folder name) */
  id: string;
  /** Display name (from .meta) */
  displayName: string;
  /** Description (from .meta) */
  description?: string;
  /** System prompt (AGENTS.md body or .meta fallback) */
  systemPrompt: string;

  // --- Resolved from .meta ---
  /** Executor type (from Agent .meta runtimeKind) */
  executorType: AgentRuntimeKind;
  /** API key (from Credential) */
  apiKey: string;
  /** API base URL (from Credential or Provider) */
  baseUrl?: string;
  /** Proxy URL */
  proxyUrl?: string;
  /** Model name (resolved from Model URI) */
  model?: string;

  /** Max conversation turns */
  maxTurns?: number;
  /** Allowed tools list */
  allowedTools?: string[];
  /** Disallowed tools list */
  disallowedTools?: string[];
  /** Permission mode */
  permissionMode?: string;
  /** MCP servers resolved from .meta structured definitions */
  mcpServers: Record<string, McpServerConfig>;
  /** Resolved skill contents (concatenated Markdown for runtimes without native skill loading) */
  skillsContent?: string;
  /** Resolved skill documents; runtime projectors choose their own native layout */
  skills: ResolvedAgentSkill[];

  /** Whether agent is enabled */
  enabled: boolean;
}

export interface ResolvedAgentSkill {
  name: string;
  content: string;
}
