import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { bundleTreeHash, installerForArchive } from '../../scripts/helpers/packaged-desktop-installation';

it('requires the matching arm64 DMG rather than silently using an extracted ZIP', () => {
  expect(installerForArchive('/release/Xpod-0.4.30-rc.1-arm64-mac.zip'))
    .toBe('/release/Xpod-0.4.30-rc.1-arm64.dmg');
  expect(() => installerForArchive('/release/other.zip')).toThrow('archive');
});

it('detects changed installed bytes, executable permissions and symlink targets', async () => {
  const root = path.join(process.cwd(), '.test-data', 'installed-bundle-hash');
  await mkdir(root, { recursive: true });
  const fixture = await mkdtemp(path.join(root, 'owned-'));
  try {
    const binary = path.join(fixture, 'xpod');
    const link = path.join(fixture, 'current');
    await writeFile(binary, 'original', { mode: 0o755 });
    await symlink('xpod', link);
    const original = await bundleTreeHash(fixture);
    await writeFile(binary, 'tampered');
    expect(await bundleTreeHash(fixture)).not.toBe(original);
    await writeFile(binary, 'original');
    expect(await bundleTreeHash(fixture)).toBe(original);
    await chmod(binary, 0o644);
    expect(await bundleTreeHash(fixture)).not.toBe(original);
    await chmod(binary, 0o755);
    await unlink(link);
    await symlink('/outside-not-followed', link);
    expect(await bundleTreeHash(fixture)).not.toBe(original);
  } finally { await rm(fixture, { recursive: true }); }
});
