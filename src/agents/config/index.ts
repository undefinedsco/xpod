/**
 * Agent Config Module
 *
 * Per-agent configuration system based on:
 * - AGENT.md: user-editable markdown (system prompt + skills + MCP servers)
 * - .meta: server-side TTL (provider/credential/model references)
 */

// Types
export type {
  AgentFrontmatter,
  AgentMcpServerDef,
  AgentMetaRecord,
  ParsedAgentMd,
  ResolvedAgentConfig,
} from './types';

// Parser
export { parseAgentMd } from './parse-agent-md';

// Schema
export { AgentMetaSchema } from './agent-meta-schema';

// Resolver
export { resolveAgentConfig } from './resolve';
