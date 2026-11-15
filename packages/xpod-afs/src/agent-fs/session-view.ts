import { readFileSync } from 'node:fs';
import path from 'node:path';

export function defaultSessionDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.XPOD_AGENTFS_SESSION || path.join(env.HOME ?? '.', '.xpod', 'agentfs'));
}

/** Read-only observation of the native journal; Rust remains its sole writer. */
export function observeSession(dir: string): { version: string; podRoot?: string; pending: number } {
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, 'session.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { version: '', pending: 0 }; }
    throw error;
  }
  const state = JSON.parse(raw) as { pod_root?: unknown; entries?: unknown };
  if (typeof state.pod_root !== 'string' || !state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries)) {
    throw new Error('Invalid native session manifest; pending state cannot be determined');
  }
  return { version: raw, podRoot: state.pod_root, pending: Object.keys(state.entries).length };
}
