import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function installerForArchive(archive: string): string {
  if (!/-arm64-mac\.zip$/.test(archive)) throw new Error('Expected the arm64 macOS archive');
  return archive.replace(/-arm64-mac\.zip$/, '-arm64.dmg');
}

/** Compare installed bytes, executable permissions and symlinks with the ZIP.
 * Never follow a bundle symlink while computing provenance.
 */
export async function bundleTreeHash(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(relative: string): Promise<void> {
    const file = path.join(root, relative);
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) {
      hash.update(JSON.stringify([relative, 'link', await readlink(file)]));
    } else if (stat.isDirectory()) {
      hash.update(JSON.stringify([relative, 'directory']));
      for (const name of (await readdir(file)).sort()) await visit(path.join(relative, name));
    } else if (stat.isFile()) {
      hash.update(JSON.stringify([relative, 'file', stat.mode & 0o777, stat.size]));
      hash.update(createHash('sha256').update(await readFile(file)).digest());
    } else throw new Error('Unsupported installed bundle member');
  }
  await visit('');
  return hash.digest('hex');
}

/** Real DMG installation into a unique user Applications directory. Existing
 * installations and profiles are never overwritten or removed.
 */
export async function installOwnedDesktop(archive: string, directory: string): Promise<{
  appPath: string; treeSha256: string; remove(): Promise<void>;
}> {
  const installer = installerForArchive(archive);
  if (!(await lstat(installer)).isFile()) throw new Error('Desktop installer is missing');
  const applications = path.join(homedir(), 'Applications');
  await mkdir(applications, { recursive: true });
  const owned = await mkdtemp(path.join(applications, 'Xpod-Acceptance-'));
  const mount = path.join(directory, 'installer-volume');
  const reference = path.join(directory, 'archive-reference');
  const appPath = path.join(owned, 'Xpod.app');
  await mkdir(mount);
  let mounted = false;
  try {
    await execute('/usr/bin/hdiutil', ['attach', installer, '-readonly', '-nobrowse', '-mountpoint', mount]);
    mounted = true;
    await execute('/usr/bin/ditto', [path.join(mount, 'Xpod.app'), appPath]);
    await execute('/usr/bin/hdiutil', ['detach', mount]);
    mounted = false;
    await execute('/usr/bin/ditto', ['-x', '-k', archive, reference]);
    const treeSha256 = await bundleTreeHash(appPath);
    if (treeSha256 !== await bundleTreeHash(path.join(reference, 'Xpod.app'))) {
      throw new Error('Installed DMG bundle differs from the expected desktop archive');
    }
    await rm(reference, { recursive: true });
    return { appPath, treeSha256, remove: () => rm(owned, { recursive: true }) };
  } catch (error) {
    if (mounted) {
      try { await execute('/usr/bin/hdiutil', ['detach', mount]); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Installer volume cleanup failed'); }
    }
    await rm(owned, { recursive: true });
    throw error;
  }
}
