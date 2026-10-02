import { describePrerequisites } from '../../../src/cli/agent-fs/mount';

export interface AgentFsHelper {
  /** True when a real AgentFS-linked helper binary exists (not the diagnostic shell). */
  available: boolean;
  command: string[] | undefined;
  source: string | undefined;
  reason: string;
  platform: string;
  platformRequirements: string[];
  helperPath?: string;
  checkBinaryPath?: string;
  fuseAvailable: boolean;
  nfsMountAvailable: boolean;
  blockers: string[];
}

/**
 * Route-specific mount requirements. FUSE and NFS are independent mount paths:
 * a FUSE-only host needs macFUSE, but the NFS route does not, and vice versa.
 */
export function platformMountRequirements(platform: string = process.platform): string[] {
  if (platform === 'darwin') {
    return [
      'FUSE route: build the AgentFS-linked helper and install macFUSE (kernel extension approved in System Settings); /dev/fuse is not present on stock macOS.',
      'NFS route: build the AgentFS-linked helper with its NFS mount path; it reuses /sbin/mount_nfs and does NOT require macFUSE, but needs a loopback NFS export / mount permission.',
      'Each route must be judged independently; a missing macFUSE blocks only the FUSE route, and a missing nfsd blocks only the NFS route.',
    ];
  }
  if (platform === 'linux') {
    return [
      'FUSE route: build the AgentFS-linked helper and provide /dev/fuse + fusermount3 (fuse3).',
      'NFS route: build the helper with its NFS path; needs rpcbind/nfs-common and mount permissions, and does NOT require /dev/fuse.',
    ];
  }
  if (platform === 'win32') {
    return [ 'Windows: FUSE-like route requires WinFsp; OS mount acceptance was not attempted on Windows.' ];
  }
  return [ `Unsupported platform "${platform}": no verified OS mount path.` ];
}

/**
 * Discovery delegates to the product's own prerequisite logic so a diagnostic
 * shell (`agentfs-pod-check`) can never be mistaken for a working mount helper.
 *
 * `available` means "a real helper binary exists and can be attempted"; it is
 * deliberately NOT gated on FUSE, because the NFS route does not need it.
 */
export function discoverAgentFsHelper(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot: string = process.cwd(),
): AgentFsHelper {
  const prerequisites = describePrerequisites(repoRoot, env);
  const routeNotes: string[] = [];
  routeNotes.push(prerequisites.fuseAvailable ? 'FUSE route prerequisite present' : 'FUSE route prerequisite missing (macFUSE//dev/fuse)');
  routeNotes.push(prerequisites.nfsMountAvailable ? 'NFS route mount binary present' : 'NFS route mount binary missing');
  return {
    available: prerequisites.helperPresent,
    command: prerequisites.helperPath ? [ prerequisites.helperPath ] : undefined,
    source: prerequisites.helperPath ? 'tools/agentfs-pod AgentFS-linked helper' : undefined,
    reason: prerequisites.helperPresent
      ? `helper present; ${routeNotes.join('; ')}`
      : (prerequisites.blockers.join(' | ') || 'AgentFS Pod helper prerequisites not met'),
    platform: prerequisites.platform,
    platformRequirements: [ ...prerequisites.blockers, ...routeNotes, ...platformMountRequirements(prerequisites.platform) ],
    helperPath: prerequisites.helperPath,
    checkBinaryPath: prerequisites.checkBinaryPath,
    fuseAvailable: prerequisites.fuseAvailable,
    nfsMountAvailable: prerequisites.nfsMountAvailable,
    blockers: prerequisites.blockers,
  };
}
