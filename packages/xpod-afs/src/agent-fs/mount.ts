import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Fixed AgentFS upstream revision the prototype helper must be built against. */
export const AGENTFS_UPSTREAM = {
  repository: 'https://github.com/tursodatabase/agentfs',
  commit: '0a014ebd4918615baff589ed17486e557e7c6a23',
  sdkCrate: 'sdk/rust',
  cliCrate: 'cli',
} as const;

export interface MountPrerequisites {
  platform: string;
  helperPath?: string;
  helperPresent: boolean;
  /** Prerequisite-shell binary used for diagnostics only; never a mount. */
  checkBinaryPath?: string;
  fuseAvailable: boolean;
  nfsMountAvailable: boolean;
  upstream: typeof AGENTFS_UPSTREAM;
  blockers: string[];
}

function firstExisting(candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

/** The real mount helper. Absent until the AgentFS-linked build exists. */
export function resolveHelperPath(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const manifest = path.join(repoRoot, 'package.json');
  const installedModule = existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).xpodModule?.id === 'afs';
  // Historical preview and explicit source fixtures keep their override. A
  // real installed module always uses its integrity-checked own payload.
  return firstExisting([path.join(repoRoot, 'helper', 'agentfs-pod'), ...(installedModule ? [] : [env.XPOD_AGENTFS_HELPER])]);
}

/** Diagnostic-only prerequisite shell; deliberately a different binary name. */
export function resolveCheckBinaryPath(repoRoot: string): string | undefined {
  return undefined;
}

function detectFuse(platform: string): boolean {
  if (platform === 'darwin') {
    return existsSync('/Library/Filesystems/macfuse.fs') ||
      existsSync('/usr/local/lib/libfuse.dylib') ||
      existsSync('/opt/homebrew/lib/libfuse.dylib');
  }
  if (platform === 'linux') {
    return existsSync('/dev/fuse');
  }
  return false;
}

export type MountBackendKind = 'nfs' | 'fuse';

export function defaultBackend(platform: string = process.platform): MountBackendKind {
  return platform === 'linux' ? 'fuse' : 'nfs';
}

export function describePrerequisites(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  backend: MountBackendKind = defaultBackend(),
): MountPrerequisites {
  const platform = process.platform;
  const helperPath = resolveHelperPath(repoRoot, env);
  const fuseAvailable = detectFuse(platform);
  const nfsMountAvailable = existsSync('/sbin/mount_nfs') || existsSync('/usr/sbin/mount.nfs');
  const blockers: string[] = [];
  if (!helperPath) {
    blockers.push(
      'Installed AFS payload is missing its native helper. Reinstall the verified platform module.',
    );
  }
  // NFS uses a userspace server; it does not require FUSE or a system nfsd.
  if (backend === 'fuse' && !fuseAvailable) {
    blockers.push('FUSE kernel driver / /dev/fuse is not available on this host.');
  }
  return {
    platform,
    helperPath,
    helperPresent: Boolean(helperPath),
    checkBinaryPath: resolveCheckBinaryPath(repoRoot),
    fuseAvailable,
    nfsMountAvailable,
    upstream: AGENTFS_UPSTREAM,
    blockers,
  };
}

export class MountUnavailableError extends Error {
  public constructor(public readonly prerequisites: MountPrerequisites) {
    super(`AgentFS Pod mount is not available: ${prerequisites.blockers.join(' ')}`);
    this.name = 'MountUnavailableError';
  }
}

/**
 * Fails loudly instead of pretending a mount exists. A "successful mount"
 * claim requires an actual OS mount performed by the helper; if the helper or
 * kernel driver is missing, this prototype must not fabricate it.
 */
export function assertMountable(prerequisites: MountPrerequisites): void {
  if (!prerequisites.helperPresent || !prerequisites.fuseAvailable) {
    throw new MountUnavailableError(prerequisites);
  }
}
