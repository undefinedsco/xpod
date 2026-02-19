/**
 * AGENT.md Parser
 *
 * Parses markdown files with YAML frontmatter into structured agent config.
 *
 * Format:
 * ```
 * ---
 * name: secretary
 * description: Default assistant
 * max-turns: 20
 * allowed-tools: Read, Write, Edit, Grep, Glob
 * skills:
 *   - /skills/drizzle-solid
 *   - ./skills/custom-skill
 * mcp-servers:
 *   - name: jina
 *     transport: stdio
 *     command: npx
 *     args: ["-y", "@jina-ai/mcp-server"]
 * ---
 *
 * You are Secretary, a helpful assistant...
 * ```
 */

import { parse as parseYaml } from 'yaml';
import type { ParsedAgentMd, AgentFrontmatter } from './types';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse an AGENT.md file content into frontmatter + body.
 *
 * @param content Raw file content
 * @returns Parsed result with frontmatter object and markdown body
 */
export function parseAgentMd(content: string): ParsedAgentMd {
  const trimmed = content.trim();
  const match = FRONTMATTER_RE.exec(trimmed);

  if (!match) {
    // No frontmatter — entire content is the system prompt
    return {
      frontmatter: {},
      body: trimmed,
    };
  }

  const yamlStr = match[1];
  const body = (match[2] ?? '').trim();

  let frontmatter: AgentFrontmatter = {};
  try {
    const parsed = parseYaml(yamlStr);
    if (parsed && typeof parsed === 'object') {
      frontmatter = parsed as AgentFrontmatter;
    }
  } catch {
    // Invalid YAML — treat as no frontmatter
    return { frontmatter: {}, body: trimmed };
  }

  // Normalize allowed-tools: accept comma-separated string or array
  if (typeof frontmatter['allowed-tools'] === 'string') {
    frontmatter['allowed-tools'] = frontmatter['allowed-tools']
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }
  if (typeof frontmatter['disallowed-tools'] === 'string') {
    frontmatter['disallowed-tools'] = frontmatter['disallowed-tools']
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  return { frontmatter, body };
}
