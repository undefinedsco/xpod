import { describe, expect, it, vi } from 'vitest';
import { MountCleanupGuard, observeKernelMounts, classifyMountInventory, parseLinuxMountInfo, type KernelMountState } from './support/mountCleanup';

describe('mounted test cleanup safety', () => {
  it.each(['mounted', 'unknown'] as KernelMountState[])('preserves %s without target deletion', async state => {
    const remove = vi.fn(); const report = vi.fn();
    const guard = new MountCleanupGuard({ observe: () => state, remove, report });
    await expect(guard.remove('/owned/case')).rejects.toThrow('mount cleanup unsafe');
    expect(remove).not.toHaveBeenCalled(); expect(report).toHaveBeenCalled();
  });
  it('treats observer exception as unknown without target deletion', async () => {
    const remove = vi.fn();
    const guard = new MountCleanupGuard({ observe: () => { throw new Error('private'); }, remove, report: vi.fn() });
    await expect(guard.remove('/owned/case')).rejects.toThrow('mount cleanup unsafe');
    expect(remove).not.toHaveBeenCalled();
  });
  it('deletes only after reliable absent', async () => {
    const remove = vi.fn(); const observe = vi.fn(() => 'absent' as const);
    const guard = new MountCleanupGuard({ observe, remove, report: vi.fn() });
    await guard.remove('/owned/case'); expect(observe).toHaveBeenCalledWith('/owned/case'); expect(remove).toHaveBeenCalledWith('/owned/case');
  });
  it('preserves existing primary and retained root after nonzero unmount even when absent', async () => {
    const remove = vi.fn(); const report = vi.fn(); const primary = new Error('primary');
    const guard = new MountCleanupGuard({ observe: () => 'absent', remove, report });
    await guard.unmount('/owned/case/mnt', async () => ({ status: 1 }), { sessionDir: '/owned/case/session' }, primary);
    await guard.remove('/owned', primary);
    expect(remove).not.toHaveBeenCalled(); expect(report).toHaveBeenCalledWith(expect.objectContaining({ primaryPresent: true, unmountStatus: 1 }));
  });
  it.each(['mounted','unknown'] as KernelMountState[])('does not confuse successful command with %s kernel state', async state => {
    const guard = new MountCleanupGuard({ observe: () => state, remove: vi.fn(), report: vi.fn() });
    await expect(guard.unmount('/owned/mnt', async () => ({ status: 0 }), {})).rejects.toThrow('mount cleanup unsafe');
  });
  it('allows actual zero plus absent and leaves primary unchanged on secondary exceptions', async () => {
    const report = vi.fn(); const primary = new Error('primary');
    const guard = new MountCleanupGuard({ observe: () => 'absent', remove: vi.fn(), report });
    await guard.unmount('/owned/mnt', async () => ({ status: 0 }), {});
    await guard.unmount('/owned/mnt', async () => { throw new Error('private'); }, {}, primary);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ primaryPresent: true, unmountStatus: null }));
    expect(primary.message).toBe('primary');
  });
  it('blocks subsequent setup after retained failure without touching the tree', async () => {
    const remove = vi.fn();
    const guard = new MountCleanupGuard({ observe: () => 'absent', remove, report: vi.fn() });
    await guard.unmount('/owned/case/mnt', async () => ({ status: 1 }), {}, new Error('primary'));
    expect(() => guard.assertAbsent('/owned')).toThrow('mount cleanup unsafe');
    expect(remove).not.toHaveBeenCalled();
  });
  it('reads the real kernel inventory without mount target metadata', () => {
    expect(observeKernelMounts(process.cwd())).toBe('absent');
  });

  it.each(['nfs', 'fusefs'])('classifies parent %s without reading a child path', type => {
    expect(classifyMountInventory('/foreign/case', [{ mountpoint: '/', type: 'apfs' }, { mountpoint: '/foreign', type }], 'darwin')).toBe('mounted');
  });
  it('accepts ordinary APFS roots but fails closed on malformed and unknown ancestors', () => {
    expect(classifyMountInventory('/Users/owned', [{ mountpoint: '/', type: 'apfs' }], 'darwin')).toBe('absent');
    expect(classifyMountInventory('/Users/owned', [{ mountpoint: '/', type: 'unknown-fs' }], 'darwin')).toBe('unknown');
    expect(classifyMountInventory('/Users/owned', [{ mountpoint: 'relative', type: 'apfs' }], 'darwin')).toBe('unknown');
    expect(classifyMountInventory('/Users/../owned', [{ mountpoint: '/', type: 'apfs' }], 'darwin')).toBe('unknown');
  });
  it('preserves the actual removal error as primary', async () => {
    const error = new Error('remove primary');
    const guard = new MountCleanupGuard({ observe: () => 'absent', remove: async () => { throw error; }, report: vi.fn() });
    await expect(guard.remove('/owned')).rejects.toBe(error);
  });
  it('does not replace an existing primary when removal also fails', async () => {
    const primary = new Error('original'); const report = vi.fn();
    const guard = new MountCleanupGuard({ observe: () => 'absent', remove: async () => { throw new Error('private secondary'); }, report });
    await guard.remove('/owned', primary);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ retained: true, primaryPresent: true }));
    expect(() => guard.assertAbsent('/owned')).toThrow('mount cleanup unsafe');
  });

  it('parses Linux escaped parent mounts and rejects malformed escapes', () => {
    const base = '1 0 0:1 / / rw - ext4 /dev/disk rw\n';
    const parent = parseLinuxMountInfo(base + String.raw`2 1 0:2 / /foreign\040space rw - fuse.sshfs remote rw`);
    expect(parent).toBeDefined();
    expect(classifyMountInventory('/foreign space/case', parent!, 'linux')).toBe('mounted');
    expect(parseLinuxMountInfo(base + 'bad')).toBeUndefined();
    expect(parseLinuxMountInfo(base + String.raw`2 1 0:2 / /foreign\zz rw - nfs remote rw`)).toBeUndefined();
    expect(parseLinuxMountInfo(base + String.raw`2 1 0:2 / /foreign\000 rw - nfs remote rw`)).toBeUndefined();
  });

  it('retains bounded actual unmount output without changing cleanup failure', async () => {
    const report = vi.fn(); const guard = new MountCleanupGuard({ observe: () => 'absent', remove: vi.fn(), report });
    await expect(guard.unmount('/owned/mnt', async () => ({ status: 1, stdout: 'x'.repeat(9000), stderr: 'closed proof unresolved' }), {})).rejects.toThrow('mount cleanup unsafe');
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ unmountCommand: { status: 1, stdout: 'x'.repeat(8192), stderr: 'closed proof unresolved', stdoutTruncated: true, stderrTruncated: false } }));
  });

});
