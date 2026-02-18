/**
 * Agent Configuration Types
 *
 * Two-layer config model:
 * - AGENT.md: user-editable markdown with YAML frontmatter (skills, MCP servers, tools)
 * - .meta: server-side TTL document (provider, credential, model references)
 *
 * The resolver combines both into a ResolvedAgentConfig ready for PtyThreadRuntime.
 */

import type { McpServerConfig, ExecutorType } from '../types';

// ============================================
// AGENT.md Frontmatter (parsed from YAML)
// ============================================

/**
 * MCP server definition in AGENT.md frontmatter
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

/**
 * Parsed AGENT.md frontmatter
 */
export interface AgentFrontmatter {
  name?: string;
  description?: string;
  'max-turns'?: number;
  'allowed-tools'?: string[] | string;
  'disallowed-tools'?: string[] | string;
  skills?: string[];
  'mcp-servers'?: AgentMcpServerDef[];
  'permission-mode'?: string;
}

/**
 * Full parsed AGENT.md result
 */
export interface ParsedAgentMd {
  frontmatter: AgentFrontmatter;
  /** Markdown body = system prompt */
  body: string;
}

// ============================================
// .meta (server-side, resolved from Pod TTL)
// ============================================

/**
 * Agent .meta record (from Pod TTL)
 */
export interface AgentMetaRecord {
  /** Agent ID (folder name) */
  id: string;
  displayName?: string;
  /** URI ref → AgentProvider */
  provider?: string;
  /** URI ref → Credential */
  credential?: string;
  /** URI ref → Model */
  model?: string;
  enabled?: boolean;
}

// ============================================
// Resolved Agent Config (ready for runtime)
// ============================================

/**
 * Fully resolved agent configuration.
 * Combines AGENT.md + .meta + resolved Pod references.
 * Ready to be passed to PtyThreadRuntime / ACP session.
 */
export interface ResolvedAgentConfig {
  /** Agent ID (folder name) */
  id: string;
  /** Display name (from .meta or frontmatter) */
  displayName: string;
  /** Description (from frontmatter) */
  description?: string;
  /** System prompt (AGENT.md body) */
  systemPrompt: string;

  // --- Resolved from .meta ---
  /** Executor type (from AgentProvider) */
  executorType: ExecutorType;
  /** API key (from Credential) */
  apiKey: string;
  /** API base URL (from Credential or AgentProvider) */
  baseUrl?: string;
  /** Proxy URL */
  proxyUrl?: string;
  /** Model name (resolved from Model URI) */
  model?: string;

  // --- From AGENT.md frontmatter ---
  /** Max conversation turns */
  maxTurns?: number;
  /** Allowed tools list */
  allowedTools?: string[];
  /** Disallowed tools list */
  disallowedTools?: string[];
  /** Permission mode */
  permissionMode?: string;
  /** MCP servers (converted from frontmatter defs) */
  mcpServers: Record<string, McpServerConfig>;
  /** Resolved skill contents (concatenated markdown) */
  skillsContent?: string;

  /** Whether agent is enabled */
  enabled: boolean;
}
