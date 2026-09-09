import { spawnSync } from 'node:child_process';

/** Prefer Bun; Node is a compatibility fallback when Bun is not installed. */
export function resolveJsRuntime(options: {
  isBun?: boolean;
  execPath?: string;
  findBun?: () => string | undefined;
} = {}): { command: string; isBun: boolean } {
  const execPath = options.execPath ?? process.execPath;
  if (options.isBun ?? (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined')) {
    return { command: execPath, isBun: true };
  }
  const bun = (options.findBun ?? findBunExecutable)();
  return bun ? { command: bun, isBun: true } : { command: execPath, isBun: false };
}

function findBunExecutable(): string | undefined {
  const result = spawnSync('bun', ['--no-env-file', '-e', 'process.stdout.write(process.execPath)'], {
    encoding: 'utf8', timeout: 5_000, windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

export function jsEntrypointArgs(entrypoint: string, isBun: boolean): string[] {
  return !isBun && entrypoint.endsWith('.ts')
    ? ['-r', require.resolve('ts-node/register/transpile-only'), entrypoint]
    : [entrypoint];
}
