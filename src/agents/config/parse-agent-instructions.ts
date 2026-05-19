/**
 * Agent instruction parser.
 *
 * AGENTS.md follows the Codex-style convention: it is plain Markdown guidance,
 * not a structured configuration carrier. Runtime settings live in .meta.
 */
export function parseAgentInstructions(content: string): string {
  return content.trim();
}

/**
 * Skill files may use Markdown frontmatter for skill metadata. Runtime prompt
 * composition only needs the instruction body.
 */
export function extractMarkdownBody(content: string): string {
  const trimmed = content.trim();
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}
