import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Install the normal public CLI and client packages; ModuleStore owns capabilities. */
export function stageDesktopRuntime(repoRoot: string, run = runCommand): void {
  const desktop = path.join(repoRoot, 'desktop');
  const scratch = path.join(repoRoot, '.test-data', 'desktop-runtime');
  mkdirSync(scratch, { recursive: true });
  const temporary = mkdtempSync(path.join(scratch, 'stage-'));
  const install = path.join(temporary, 'runtime');
  const destination = path.join(desktop, 'runtime');
  try {
    // SDK's normal cold build resolves the CLI-owned build-tools export.
    run(['bun', 'run', 'build:tools'], path.join(repoRoot, 'packages', 'xpod-cli'));
    const archives: Record<string, string> = {};
    for (const name of ['xpod-client', 'xpod-cli']) {
      const packageRoot = path.join(repoRoot, 'packages', name);
      const archiveDir = path.join(temporary, name);
      mkdirSync(archiveDir);
      run(['bun', 'run', 'build'], packageRoot);
      run(['bun', 'pm', 'pack', '--ignore-scripts', '--destination', archiveDir], packageRoot);
      const archivesFound = readdirSync(archiveDir).filter(file => file.endsWith('.tgz'));
      if (archivesFound.length !== 1) throw new Error(`Expected one packed ${name} artifact`);
      const metadata = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
      archives[metadata.name] = path.join(archiveDir, archivesFound[0]);
    }
    mkdirSync(install);
    const dependencies = Object.fromEntries(Object.entries(archives).map(([name, archive]) => [name, `file:${archive}`]));
    writeFileSync(path.join(install, 'package.json'), JSON.stringify({ private: true, dependencies,
      overrides: { '@undefineds.co/xpod-client': dependencies['@undefineds.co/xpod-client'] } }));
    run(['bun', 'install', '--production', '--ignore-scripts'], install);
    const cli = path.join(install, 'node_modules', '@undefineds.co', 'xpod-cli', 'dist', 'xpod.mjs');
    if (!existsSync(cli)) throw new Error('Installed CLI entry is missing');
    // Installation metadata contains temporary local archive paths; runtime resolution uses node_modules.
    rmSync(path.join(install, 'package.json'));
    for (const lock of ['bun.lock', 'bun.lockb']) rmSync(path.join(install, lock), { force: true });
    promoteDesktopRuntime(install, destination);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Keep the previous runtime recoverable until promotion and cleanup succeed. */
export function promoteDesktopRuntime(install: string, destination: string, operations = {
  rename: renameSync,
  remove: (directory: string) => rmSync(directory, { recursive: true, force: true }),
}): void {
  const backup = `${destination}.previous-${randomUUID()}`;
  const hadPrevious = existsSync(destination);
  if (hadPrevious) operations.rename(destination, backup);
  try {
    operations.rename(install, destination);
  } catch (promotionError) {
    if (hadPrevious) {
      try {
        operations.rename(backup, destination);
      } catch (rollbackError) {
        throw new AggregateError([promotionError, rollbackError],
          `Runtime promotion and rollback failed; previous runtime retained at ${backup}`);
      }
    }
    throw promotionError;
  }
  if (hadPrevious) {
    try {
      operations.remove(backup);
    } catch (cleanupError) {
      throw new AggregateError([cleanupError], `Runtime promoted but previous runtime cleanup failed; recovery path: ${backup}`);
    }
  }
}

function runCommand(command: string[], cwd: string): void {
  const result = spawnSync(command[0], command.slice(1), { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command.join(' ')} exited ${result.status}`);
}

if (import.meta.main) stageDesktopRuntime(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
