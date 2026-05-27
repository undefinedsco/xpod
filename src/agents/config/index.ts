/**
 * Agent Config Module
 *
 * Per-agent configuration system based on a Pod-hosted Agent Profile:
 * - AGENTS.md: user-editable plain Markdown guidance
 * - .meta: RDF runtime config and refs to shared skill documents
 */

// Types
export type {
  AgentMcpServerDef,
  AgentRuntimeKind,
  AgentMetaRecord,
  ResolvedAgentSkill,
  ResolvedAgentConfig,
} from './types';

// Parser
export { parseAgentInstructions, extractMarkdownBody } from './parse-agent-instructions';

// Schema
export { AgentMetaSchema } from './agent-meta-schema';

// Resolver
export { resolveAgentConfig } from './resolve';
