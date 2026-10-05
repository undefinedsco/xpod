import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';

export type KernelMountState = 'absent' | 'mounted' | 'unknown';
export interface KernelObservationDetail {
  state: KernelMountState;
  /** The normalized observed root this snapshot was classified against. */
  root?: string;
  /** Bounded, safe classifier reason: which branch produced the state. */
  reason: string;
  /** The command name used (NOT a proven resolved absolute path). */
  executableCommand?: string;
  /** Summary of argv (the -c code is a static constant; its SHA is recorded). */
  argvSummary?: string[];
  /** SHA256 of the exact MAC_INVENTORY code actually passed to python3 -c. */
  macInventoryCodeSHA256?: string;
  status?: number | null;
  signal?: string | null;
  errorCode?: string | null;
  stderr?: string;
  rowCount?: number;
  /** For classify-unknown: the specific offending row/ancestor/type reason. */
  classifyReason?: string;
  /** Bounded offending-entry context (not the whole inventory). */
  classificationContext?: ClassificationContext;
  platform: string;
}
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

/**
 * Detailed kernel observation: returns BOTH the state and the exact classifier
 * reason (bounded), so a real `unknown` is diagnosable without changing the
 * fail-closed decision. Never stats/enumerates the mount target.
 */
export function observeKernelMountsDetailed(root: string): KernelObservationDetail {
  const platform = process.platform;
  // SAME single snapshot decides state AND detail; attach the normalized root so
  // matrix ROOT / stream / recovery scenes are distinguishable.
  const normRoot = validMountPath(root) ? root : String(root).slice(0, 256);
  const withRoot = (d: KernelObservationDetail): KernelObservationDetail => ({ ...d, root: normRoot });
  try {
    if (!validMountPath(root)) return withRoot({ state: 'unknown', reason: 'invalid-mount-path', platform });
    if (platform === 'darwin') {
      const result = spawnSync('python3', [ '-c', MAC_INVENTORY ], { encoding: 'utf8', timeout: 5_000, maxBuffer: 256 * 1024 });
      if (result.status !== 0 || result.signal || result.error) {
        return withRoot({
          state: 'unknown', reason: 'python-observer-nonzero', executableCommand: 'python3', argvSummary: [ '-c', '<MAC_INVENTORY>' ],
          macInventoryCodeSHA256: MAC_INVENTORY_SHA256,
          status: result.status, signal: result.signal ?? null, errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
          stderr: (result.stderr ?? '').slice(0, 4096), platform,
        });
      }
      let rows: MountInventoryEntry[];
      try { rows = JSON.parse(result.stdout) as MountInventoryEntry[]; }
      catch { return withRoot({ state: 'unknown', reason: 'json-parse-failed', executableCommand: 'python3', macInventoryCodeSHA256: MAC_INVENTORY_SHA256, status: result.status, platform }); }
      const result2 = classifyMountInventoryDetailed(root, rows, 'darwin');
      return withRoot({ state: result2.state, reason: result2.state === 'unknown' ? `classify-unknown:${result2.classifyReason}` : `classify-${result2.state}`, macInventoryCodeSHA256: MAC_INVENTORY_SHA256, rowCount: rows.length, classifyReason: result2.classifyReason, classificationContext: result2.classificationContext, platform });
    }
    if (platform === 'linux') {
      const rows = parseLinuxMountInfo(readFileSync('/proc/self/mountinfo', 'utf8'));
      if (!rows) return withRoot({ state: 'unknown', reason: 'mountinfo-parse-failed', platform });
      const result2 = classifyMountInventoryDetailed(root, rows, 'linux');
      return withRoot({ state: result2.state, reason: result2.state === 'unknown' ? `classify-unknown:${result2.classifyReason}` : `classify-${result2.state}`, rowCount: rows.length, classifyReason: result2.classifyReason, classificationContext: result2.classificationContext, platform });
    }
    return withRoot({ state: 'unknown', reason: 'unsupported-platform', platform });
  } catch (error) {
    return withRoot({ state: 'unknown', reason: 'observer-threw', errorCode: (error as NodeJS.ErrnoException)?.code ?? null, platform });
  }
}

export function observeKernelMounts(root: string): KernelMountState {
  return observeKernelMountsDetailed(root).state;
}

const MAC_INVENTORY_SHA256 = createHash('sha256').update(MAC_INVENTORY).digest('hex');

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

/**
 * Observer wrapper used by the suite's guards: ONE detailed kernel probe, write
 * the bounded detail into XPOD_MOUNTED_EVIDENCE (0600, static node:fs imports),
 * and return the SAME state the plain observer would. Fail-closed unchanged.
 */
let observerSequence = 0;
export function makeObservingKernelObserver(label: string): (root: string) => KernelMountState {
  return (root) => {
    // ONE snapshot decides both state and detail.
    const detail = observeKernelMountsDetailed(root);
    const dir = process.env.XPOD_MOUNTED_EVIDENCE;
    if (dir) {
      try {
        // Unique per invocation: monotonic sequence + random UUID (not Date.now-only).
        const seq = (observerSequence += 1);
        const nonce = `${label}-${seq}-${randomUUID()}`;
        const p = path.join(dir, `observer-${nonce}.json`);
        writeFileSync(p, `${JSON.stringify(detail, null, 2)}\n`, { mode: 0o600 });
        chmodSync(p, 0o600);
      } catch { /* diagnostic sink must never break cleanup */ }
    }
    return detail.state;
  };
}

export interface MountInventoryEntry { mountpoint: string; type: string }

function validMountPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0')
    && path.posix.normalize(value) === value && !value.split('/').some(part => part === '.' || part === '..');
}

export interface ClassificationContext {
  /** row index of the offending entry (bounded, not the whole inventory). */
  rowIndex?: number;
  /** the offending mountpoint / type when applicable. */
  mountpoint?: string;
  type?: string;
  /** for unknown-ancestor: whether the row is an ancestor of root and how. */
  ancestorOfRoot?: boolean;
  /** for malformed-row: which field was invalid. */
  malformedField?: 'null' | 'mountpoint' | 'type';
}

export function classifyMountInventoryDetailed(root: string, rows: MountInventoryEntry[], platform = process.platform): { state: KernelMountState; classifyReason: string; classificationContext?: ClassificationContext } {
  if (!validMountPath(root)) return { state: 'unknown', classifyReason: 'invalid-root', classificationContext: { mountpoint: String(root).slice(0, 256) } };
  if (!Array.isArray(rows) || rows.length === 0) return { state: 'unknown', classifyReason: 'empty-rows' };
  let baseline = false;
  let unknownAncestor = false;
  let ancestorContext: ClassificationContext | undefined;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row || !validMountPath(row.mountpoint) || typeof row.type !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(row.type)) {
      const field: ClassificationContext['malformedField'] = !row ? 'null' : !validMountPath(row.mountpoint) ? 'mountpoint' : 'type';
      return { state: 'unknown', classifyReason: `malformed-row:${field}`, classificationContext: { rowIndex, mountpoint: row && typeof (row as MountInventoryEntry).mountpoint === 'string' ? String((row as MountInventoryEntry).mountpoint).slice(0, 256) : undefined, type: row && typeof (row as MountInventoryEntry).type === 'string' ? String((row as MountInventoryEntry).type).slice(0, 64) : undefined, malformedField: field } };
    }
    const mount = row.mountpoint;
    if (mount === root || mount.startsWith(`${root}/`)) return { state: 'mounted', classifyReason: 'target-mounted', classificationContext: { rowIndex, mountpoint: mount, type: row.type } };
    if (mount === '/' || root.startsWith(`${mount}/`)) {
      if (/^(?:nfs|fuse|osxfuse|macfuse)/.test(row.type) || ['smbfs', 'cifs', 'afpfs', 'webdav', '9p', 'ceph'].includes(row.type)) return { state: 'mounted', classifyReason: `ancestor-mount:${row.type}`, classificationContext: { rowIndex, mountpoint: mount, type: row.type, ancestorOfRoot: true } };
      const safe = platform === 'darwin'
        ? (row.type === 'apfs' && ['/', '/System/Volumes/Data'].includes(mount)) || (row.type === 'hfs' && mount === '/')
        : platform === 'linux' && ['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'tmpfs', 'overlay'].includes(row.type);
      if (safe) baseline = true;
      else { unknownAncestor = true; ancestorContext ??= { rowIndex, mountpoint: mount, type: row.type, ancestorOfRoot: true }; }
    }
  }
  if (unknownAncestor) return { state: 'unknown', classifyReason: 'unknown-ancestor-type', classificationContext: ancestorContext };
  return baseline ? { state: 'absent', classifyReason: 'baseline-present' } : { state: 'unknown', classifyReason: 'no-baseline' };
}

export function classifyMountInventory(root: string, rows: MountInventoryEntry[], platform = process.platform): KernelMountState {
  return classifyMountInventoryDetailed(root, rows, platform).state;
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
