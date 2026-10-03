import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';

export type KernelMountState = 'absent' | 'mounted' | 'unknown';
export interface CleanupOptions {
  observe: (root: string) => KernelMountState;
  remove: (root: string) => Promise<void>;
  report: (record: Record<string, unknown>) => void;
}

// Kernel inventory only: never stat or enumerate a mount target. Darwin's
// INODE64 structure is 2168 bytes; MNT_NOWAIT avoids waiting on dead NFS.
const MAC_INVENTORY = `import ctypes,json,sys
class S(ctypes.Structure):
 _fields_=[('bsize',ctypes.c_uint32),('iosize',ctypes.c_int32),('blocks',ctypes.c_uint64),('bfree',ctypes.c_uint64),('bavail',ctypes.c_uint64),('files',ctypes.c_uint64),('ffree',ctypes.c_uint64),('fsid',ctypes.c_int32*2),('owner',ctypes.c_uint32),('type',ctypes.c_uint32),('flags',ctypes.c_uint32),('subtype',ctypes.c_uint32),('fstype',ctypes.c_char*16),('mount',ctypes.c_char*1024),('source',ctypes.c_char*1024),('reserved',ctypes.c_uint32*8)]
assert ctypes.sizeof(S)==2168
lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
f=getattr(lib,'getfsstat$INODE64');f.argtypes=[ctypes.POINTER(S),ctypes.c_int,ctypes.c_int];f.restype=ctypes.c_int
rows=(S*128)();n=f(rows,ctypes.sizeof(rows),2)
assert 0<n<128
print(json.dumps([{'mountpoint':bytes(x.mount).decode(),'type':bytes(x.fstype).decode()} for x in rows[:n]]))`;

export function observeKernelMounts(root: string): KernelMountState {
  try {
    if (!validMountPath(root)) return 'unknown';
    if (process.platform === 'darwin') {
      const result = spawnSync('python3', [ '-c', MAC_INVENTORY ], { encoding: 'utf8', timeout: 5_000, maxBuffer: 256 * 1024 });
      if (result.status !== 0 || result.signal || result.error) return 'unknown';
      return classifyMountInventory(root, JSON.parse(result.stdout), 'darwin');
    }
    if (process.platform === 'linux') {
      const rows = parseLinuxMountInfo(readFileSync('/proc/self/mountinfo', 'utf8'));
      return rows ? classifyMountInventory(root, rows, 'linux') : 'unknown';
    }
  } catch { /* A failed observation never authorizes target access. */ }
  return 'unknown';
}

export class MountCleanupGuard {
  private readonly retained = new Set<string>();
  constructor(private readonly options: CleanupOptions = {
    observe: observeKernelMounts,
    remove: root => rm(root, { recursive: true, force: true }),
    report: record => console.error('[mount-cleanup]', JSON.stringify(record)),
  }) {}

  private observation(root: string): KernelMountState {
    try {
      const state = this.options.observe(root);
      return state === 'absent' || state === 'mounted' ? state : 'unknown';
    } catch { return 'unknown'; }
  }

  private fail(root: string, observation: KernelMountState, owned: Record<string, string>, unmountStatus: number | null, primary?: unknown, throwIfNoPrimary = true): void {
    this.retained.add(root);
    try { this.options.report({ root, owned, observation, unmountStatus, retained: true, primaryPresent: primary !== undefined }); } catch { /* Preserve the existing primary error. */ }
    if (primary === undefined && throwIfNoPrimary) throw new Error('mount cleanup unsafe; owned scene retained');
  }

  assertAbsent(root: string): void {
    const observation = this.observation(root);
    const retained = [...this.retained].some(item => item === root || item.startsWith(`${root}/`) || root.startsWith(`${item}/`));
    if (observation !== 'absent' || retained) this.fail(root, observation, {}, null);
  }

  async remove(root: string, primary?: unknown): Promise<void> {
    const observation = this.observation(root);
    const retained = [...this.retained].some(item => item === root || item.startsWith(`${root}/`) || root.startsWith(`${item}/`));
    if (observation !== 'absent' || retained) { this.fail(root, observation, {}, null, primary); return; }
    try { await this.options.remove(root); } catch (error) {
      this.fail(root, observation, {}, null, primary === undefined ? error : primary, false);
      if (primary === undefined) throw error;
    }
  }

  async unmount(root: string, action: () => Promise<{ status: number; stdout?: string; stderr?: string }>, owned: Record<string, string>, primary?: unknown): Promise<void> {
    let status: number | null = null;
    try {
      const result = await action(); status = result.status;
      if (status !== 0) {
        // Test-only private raw logs: bound command output, preserve original
        // lifecycle decisions and never let recording replace the primary.
        try { this.options.report({ unmountCommand: { status, stdout: result.stdout?.slice(0, 8192) ?? '', stderr: result.stderr?.slice(0, 8192) ?? '', stdoutTruncated: (result.stdout?.length ?? 0) > 8192, stderrTruncated: (result.stderr?.length ?? 0) > 8192 }, root, owned }); } catch { /* Diagnostic sink is secondary. */ }
      }
    } catch { /* Record command failure separately from kernel absence. */ }
    const observation = this.observation(root);
    if (status !== 0 || observation !== 'absent') this.fail(root, observation, owned, status, primary);
  }
}

export interface MountInventoryEntry { mountpoint: string; type: string }

function validMountPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0')
    && path.posix.normalize(value) === value && !value.split('/').some(part => part === '.' || part === '..');
}

export function classifyMountInventory(root: string, rows: MountInventoryEntry[], platform = process.platform): KernelMountState {
  if (!validMountPath(root) || !Array.isArray(rows) || rows.length === 0) return 'unknown';
  let baseline = false;
  let unknownAncestor = false;
  for (const row of rows) {
    if (!row || !validMountPath(row.mountpoint) || typeof row.type !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(row.type)) return 'unknown';
    const mount = row.mountpoint;
    if (mount === root || mount.startsWith(`${root}/`)) return 'mounted';
    if (mount === '/' || root.startsWith(`${mount}/`)) {
      if (/^(?:nfs|fuse|osxfuse|macfuse)/.test(row.type) || ['smbfs', 'cifs', 'afpfs', 'webdav', '9p', 'ceph'].includes(row.type)) return 'mounted';
      const safe = platform === 'darwin'
        ? (row.type === 'apfs' && ['/', '/System/Volumes/Data'].includes(mount)) || (row.type === 'hfs' && mount === '/')
        : platform === 'linux' && ['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'tmpfs', 'overlay'].includes(row.type);
      if (safe) baseline = true;
      else unknownAncestor = true;
    }
  }
  return baseline && !unknownAncestor ? 'absent' : 'unknown';
}

export function parseLinuxMountInfo(source: string): MountInventoryEntry[] | undefined {
  const rows: MountInventoryEntry[] = [];
  for (const line of source.trim().split('\n')) {
    const fields = line.split(' '); const separator = fields.indexOf('-');
    if (separator < 6 || fields.length < separator + 4 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1]) || !/^\d+:\d+$/.test(fields[2])) return undefined;
    if (/\\(?![0-7]{3})/.test(fields[4])) return undefined;
    const mountpoint = fields[4].replace(/\\([0-7]{3})/g, (_, digits: string) => String.fromCharCode(parseInt(digits, 8)));
    if (!validMountPath(mountpoint)) return undefined;
    rows.push({ mountpoint, type: fields[separator + 1] });
  }
  return rows;
}
