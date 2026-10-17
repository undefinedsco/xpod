import { accessSync, constants, realpathSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class NativeBinaryNotFoundError extends Error {
  public constructor(public readonly binary: string) {
    super(`Could not resolve the native "${binary}" binary.`);
    this.name = 'NativeBinaryNotFoundError';
  }
}

function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function realpathOrUndefined(candidate: string): string | undefined {
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

function isWithin(directory: string, candidate: string): boolean {
  return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
}

function resolveSkipDirs(env: NodeJS.ProcessEnv, skipDirs: string[]): string[] {
  const dirs = new Set<string>();
  for (const dir of [ ...skipDirs, env.XPOD_AGENT_FS_WRAPPER_DIR ]) {
    if (!dir) {
      continue;
    }
    const real = realpathOrUndefined(dir) ?? path.resolve(dir);
    dirs.add(real);
  }
  return [ ...dirs ];
}

function isInsideSkipDirs(candidate: string, skipDirs: string[]): boolean {
  const real = realpathOrUndefined(candidate) ?? path.resolve(candidate);
  return skipDirs.some((dir) => isWithin(dir, real));
}

export function resolveNativeBinary(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  skipDirs: string[] = [],
): string | undefined {
  const resolvedSkipDirs = resolveSkipDirs(env, skipDirs);

  const explicit = binary === 'rg' ? env.XPOD_AGENT_FS_NATIVE_RG : undefined;
  if (explicit) {
    const real = realpathOrUndefined(explicit);
    // An explicit override resolved through a symlink must not point back into
    // the wrapper directory, otherwise the wrapper would recurse into itself.
    if (real && isExecutable(real) && !isInsideSkipDirs(real, resolvedSkipDirs)) {
      return real;
    }
  }

  const pathValue = env.PATH ?? '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const resolvedDir = path.resolve(dir);
    if (isInsideSkipDirs(resolvedDir, resolvedSkipDirs)) {
      continue;
    }
    const candidate = path.join(resolvedDir, binary);
    if (isExecutable(candidate)) {
      const real = realpathOrUndefined(candidate) ?? candidate;
      if (!isInsideSkipDirs(real, resolvedSkipDirs)) {
        return real;
      }
    }
  }
  return undefined;
}

export async function execNativeBinary(binary: string, argv: string[], cwd: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(binary, argv, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }
      if (signal) {
        const signalNumber = osConstants.signals[signal as keyof typeof osConstants.signals];
        resolve(128 + (typeof signalNumber === 'number' ? signalNumber : 1));
        return;
      }
      resolve(1);
    });
  });
}
