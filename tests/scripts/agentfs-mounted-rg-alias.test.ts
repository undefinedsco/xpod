import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runMountedPlatformAdmission } from '../../scripts/agentfs-native-ci/mounted/platform-admission';
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
it('resolves a real rg executable alias while retaining nofollow streaming identity checks', async () => {
  const parent = path.resolve('.test-data/mounted-rg-alias'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'tiny-')), previous = { ...process.env };
  try {
    const source = path.join(root, 'scripts/agentfs-native-ci/mounted/platform-admission.ts'); fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, 'test-owned harness source');
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    const node = path.join(root, 'node'); fs.writeFileSync(node, '#!/bin/sh\necho v22.21.1\n', { mode: 0o700 });
    const actual = path.join(root, 'rg-original'); fs.writeFileSync(actual, '#!/bin/sh\necho "ripgrep fixture version"\n', { mode: 0o700 });
    fs.symlinkSync(actual, path.join(bin, 'rg'));
    const archive = path.join(root, 'product.tgz'); fs.writeFileSync(archive, 'actual archive bytes');
    const helper = path.join(root, 'helper'), launcher = path.join(root, 'launcher'), entry = path.join(root, 'entry');
    for (const file of [helper, launcher, entry]) fs.writeFileSync(file, 'test-owned file');
    const evidence = path.join(root, 'evidence');
    Object.assign(process.env, { PATH: bin + ':/usr/bin:/bin', XPOD_MOUNTED_ARCHIVE: archive, XPOD_MOUNTED_ARCHIVE_SHA: hash(archive), XPOD_MOUNTED_HELPER_SHA: hash(helper), XPOD_MOUNTED_WORKSPACE: root,
      XPOD_MOUNTED_NODE: node, XPOD_MOUNTED_EVIDENCE: evidence, XPOD_MOUNTED_OS: process.platform, XPOD_MOUNTED_ARCH: process.arch, XPOD_MOUNTED_BACKEND: process.platform === 'darwin' ? 'nfs' : 'fuse' });
    await expect(runMountedPlatformAdmission({ helper, helperSha256: hash(helper), launcher, launcherSha256: hash(launcher), entry, entrySha256: hash(entry), binding: {}, env: {} } as any)).rejects.toThrow('harness dependency tree is missing');
    const receipt = JSON.parse(fs.readFileSync(path.join(evidence, 'mounted-' + process.platform + '.receipt.json'), 'utf8'));
    expect(receipt.failureCategory).toBe('harness-dependency');
    expect(receipt.producerStarted).toBe(false);
    expect(receipt.actualWait).toBe(false);
    expect(receipt.rawClosedBeforeHash).toBe(false);
    expect(receipt.mountExecuted).toBe(false);
    expect(receipt).not.toHaveProperty('message');
    const before = fs.readFileSync(path.join(evidence, 'mounted-' + process.platform + '.receipt.json'));
    delete process.env.XPOD_MOUNTED_ARCHIVE;
    await expect(runMountedPlatformAdmission()).rejects.toThrow('missing XPOD_MOUNTED_ARCHIVE');
    expect(fs.readFileSync(path.join(evidence, 'mounted-' + process.platform + '.receipt.json'))).toEqual(before);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
