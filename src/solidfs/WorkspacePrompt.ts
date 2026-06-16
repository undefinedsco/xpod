export interface WorkspaceSummaryPromptInput {
  root: string;
  authority: 'local-filesystem' | 'cloud-object-store';
  files: number;
  bylineLocalFiles: number;
  remotePlaceholders: number;
  hydratedRemoteObjects: number;
  freeLocalCacheBytes?: number;
  maxHydrateBytesWithoutConfirmation?: number;
  tools: string[];
}

export function buildWorkspaceSemanticsPrompt(): string {
  return `## Workspace Semantics

You are operating inside an Xpod SolidFS materialized workspace.

- Directory entries are complete: \`ls\` and \`find\` show the workspace tree.
- Text/by-line files are materialized locally and can be read with normal tools.
- Large binary/media/remote-object files may appear as placeholders.
- Placeholder metadata is available through \`.meta\` and workspace tools.
- Do not assume placeholder bytes are the real content.
- Hydration has cost; inspect metadata before choosing metadata, thumbnail, range-read, or full hydration.
- Writes are tracked by the SolidFS journal and must be committed or rolled back by runtime.
- Search/vector/index artifacts are internal; use search/parser tools rather than looking for index files.
`;
}

export function buildWorkspaceSummaryPrompt(input: WorkspaceSummaryPromptInput): string {
  return [
    '## Current Workspace',
    '',
    `Root: ${promptValue(input.root)}`,
    `Authority: ${input.authority}`,
    `Files: ${input.files}`,
    `Text/by-line local files: ${input.bylineLocalFiles}`,
    `Remote placeholders: ${input.remotePlaceholders}`,
    `Hydrated remote objects: ${input.hydratedRemoteObjects}`,
    input.freeLocalCacheBytes === undefined ? undefined : `Free local cache bytes: ${input.freeLocalCacheBytes}`,
    input.maxHydrateBytesWithoutConfirmation === undefined ? undefined : `Max hydrate bytes without confirmation: ${input.maxHydrateBytesWithoutConfirmation}`,
    `Available tools: ${input.tools.map(promptValue).join(', ')}`,
    '',
  ].filter((line): line is string => line !== undefined).join('\n');
}

function promptValue(value: string): string {
  return (JSON.stringify(value) ?? '""').replace(/[\u0085\u2028\u2029]/g, escapeLogicalLineSeparator);
}

function escapeLogicalLineSeparator(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
}
