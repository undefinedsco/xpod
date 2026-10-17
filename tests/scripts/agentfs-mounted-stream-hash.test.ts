import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { runMountedPlatformAdmission } from '../../scripts/agentfs-native-ci/mounted/platform-admission';

describe('mounted private streaming original hashes', () => {
  it('hashes a real archive with bounded reads before rejecting a wrong expected identity', async () => {
    const parent = path.resolve('.test-data/mounted-stream-hash'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'tiny-')), previous = { ...process.env };
    try {
      const script = path.join(root, 'scripts/agentfs-native-ci/mounted/platform-admission.ts');
      fs.mkdirSync(path.dirname(script), { recursive: true }); fs.writeFileSync(script, 'test-owned source original');
      const node = path.join(root, 'node'); fs.writeFileSync(node, '#!/bin/sh\necho v22.21.1\n', { mode: 0o700 });
      const archive = path.join(root, 'product.tgz'); fs.writeFileSync(archive, Buffer.alloc(2 * 1024 ** 2, 17));
      Object.assign(process.env, { XPOD_MOUNTED_ARCHIVE: archive, XPOD_MOUNTED_ARCHIVE_SHA: '0'.repeat(64),
        XPOD_MOUNTED_HELPER_SHA: '1'.repeat(64), XPOD_MOUNTED_WORKSPACE: root, XPOD_MOUNTED_NODE: node,
        XPOD_MOUNTED_EVIDENCE: path.join(root, 'evidence'), XPOD_MOUNTED_OS: process.platform, XPOD_MOUNTED_ARCH: process.arch });
      const readFile = fs.readFileSync, read = fs.readSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
        if (file === archive) throw Error('archive full-buffer read forbidden');
        return (readFile as any)(file, ...args);
      }) as any);
      const lengths: number[] = [];
      vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
        lengths.push(length); return read(fd, buffer, offset, length, position);
      }) as any);
      syncBuiltinESMExports();
      await expect(runMountedPlatformAdmission()).rejects.toThrow('product archive digest mismatch');
      expect(lengths.length).toBeGreaterThan(32);
      expect(Math.max(...lengths)).toBeLessThanOrEqual(65536);
    } finally {
      vi.restoreAllMocks(); syncBuiltinESMExports();
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
