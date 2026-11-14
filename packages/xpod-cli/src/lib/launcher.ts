import path from 'node:path';

/** Compiled Bun clients re-execute themselves without a source-script path. */
export function cliLauncher(): string[] {
  const entry = process.argv[1];
  if (entry?.startsWith('/$bunfs/')) { return [ process.execPath ]; }
  if (!entry) { throw new Error('Cannot determine the CLI entry point'); }
  return [ process.execPath, path.resolve(entry) ];
}
