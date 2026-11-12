import { stageBundledBun } from './bun-runtime-material';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** What the shared native platform producer measured for this candidate. */
export interface NativePlatformStage {
  /** Scratch stage directory owned by the producer; never the promoted runtime. */
  readonly stageDir: string;
  /** The accepted QLever native runtime payload inside `stageDir`. */
  readonly qleverRuntimeOutputPath: string;
  /** Producer-written measured budget document. */
  readonly publicationBudgetPath: string;
}

/**
 * The one existing native publication producer. It builds the real Bun single
 * binary, extracts the accepted QLever artifact, stages Source/LICENSE, runs an
 * actual `npm pack --dry-run --json`, and validates the result with
 * `verifyPlatformPackageBudget` before returning. Reused here so the desktop
 * stage and stable publication measure the *same* package, never a second copy.
 */
export type NativePlatformProducer = (stageDir: string) => Promise<NativePlatformStage>;

/** `build-platform-package.cjs` writes its measured evidence beside the stage directory. */
function measuredEvidencePaths(stageDir: string): { pack: string; budget: string } {
  return { pack: `${stageDir}-pack.json`, budget: `${stageDir}-pack-budget.json` };
}

const defaultNativePlatformProducer: NativePlatformProducer = async (stageDir) => {
  const { buildPlatformPackage } = require('../../scripts/build-platform-package.cjs') as {
    buildPlatformPackage: (targetRef: string, options: { stageDir: string }) => Promise<NativePlatformStage>;
  };
  // `current` resolves the host target (darwin-arm64 on both desktop runners). The
  // accepted QLever artifact comes from XPOD_QLEVER_LOCAL_RUNTIME_ARTIFACT, which
  // every desktop caller already sets; the producer fails closed without it.
  return buildPlatformPackage('current', { stageDir });
};

/**
 * Install the normal public CLI and client packages; ModuleStore owns capabilities.
 *
 * The accepted native platform package is produced by the shared publication
 * producer into its own scratch sibling directory, then only its verified QLever
 * payload is folded into this runtime. The desktop ZIP is not what that producer
 * measures: the measured bytes are the upcoming native platform publication, and
 * its evidence is retained so the release gate can check a real pack.
 */
export async function stageDesktopRuntime(
  repoRoot: string,
  run = runCommand,
  runtimeInput?: string,
  produceNativePlatform: NativePlatformProducer = defaultNativePlatformProducer,
): Promise<void> {
  if (!runtimeInput) throw new Error('Desktop build requires an explicit --runtime-input descriptor');
  const desktop = path.join(repoRoot, 'desktop');
  const scratch = path.join(repoRoot, '.test-data', 'desktop-runtime');
  mkdirSync(scratch, { recursive: true });
  const temporary = mkdtempSync(path.join(scratch, 'stage-'));
  const install = path.join(temporary, 'runtime');
  const destination = path.join(desktop, 'runtime');
  const packReport = path.join(desktop, 'runtime-pack.json');
  const budgetReport = path.join(desktop, 'runtime-pack-budget.json');
  // Measured evidence becomes visible only after promotion succeeds, so a failed
  // build can never leave a success budget behind.
  const pending = { pack: `${packReport}.pending-${randomUUID()}`, budget: `${budgetReport}.pending-${randomUUID()}` };
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
    stageBundledBun(repoRoot, install, path.resolve(runtimeInput));
    const dependencies = Object.fromEntries(Object.entries(archives).map(([name, archive]) => [name, `file:${archive}`]));
    writeFileSync(path.join(install, 'package.json'), JSON.stringify({ private: true, dependencies,
      overrides: { '@undefineds.co/xpod-client': dependencies['@undefineds.co/xpod-client'] } }));
    run(['bun', 'install', '--production', '--ignore-scripts'], install);
    const cli = path.join(install, 'node_modules', '@undefineds.co', 'xpod-cli', 'dist', 'xpod.mjs');
    if (!existsSync(cli)) throw new Error('Installed CLI entry is missing');

    // Native stage in its own scratch sibling: the producer removes and rebuilds
    // its stage directory, so it must never be the install directory above.
    const nativeStage = await produceNativePlatform(path.join(temporary, 'native-platform'));
    // The producer reports the binary at `<qlever root>/bin/xpod_qlever_local_runtime`;
    // the runtime contract wants that whole root (binary + manifest) under `qlever/`.
    const qleverRoot = path.dirname(path.dirname(nativeStage.qleverRuntimeOutputPath));
    const qlever = path.join(install, 'qlever');
    rmSync(qlever, { recursive: true, force: true });
    cpSync(qleverRoot, qlever, { recursive: true, dereference: true });
    const qleverBinary = path.join(qlever, 'bin', 'xpod_qlever_local_runtime');
    if (!existsSync(qleverBinary)) throw new Error('Native platform stage is missing the QLever runtime binary');
    if (!existsSync(path.join(qlever, 'manifest.json'))) throw new Error('Native platform stage is missing the QLever runtime manifest');

    // Retain the producer's own measured documents verbatim, staging them out of
    // sight until the runtime is actually promoted.
    const { pack: measuredPack, budget: declaredBudget } = measuredEvidencePaths(nativeStage.stageDir);
    // The producer's returned budget path must be its conventional measured
    // document, so this consumes the same bytes the producer itself reports.
    if (path.resolve(declaredBudget) !== path.resolve(nativeStage.publicationBudgetPath)) {
      throw new Error('Native platform producer reported an unexpected budget document');
    }
    for (const file of [measuredPack, nativeStage.publicationBudgetPath]) {
      if (!existsSync(file)) throw new Error(`Native platform producer is missing measured evidence: ${file}`);
    }
    writeFileSync(pending.pack, readFileSync(measuredPack));
    writeFileSync(pending.budget, readFileSync(nativeStage.publicationBudgetPath));

    // Installation metadata contains temporary local archive paths; runtime resolution uses node_modules.
    rmSync(path.join(install, 'package.json'));
    for (const lock of ['bun.lock', 'bun.lockb']) rmSync(path.join(install, lock), { force: true });
    promoteDesktopRuntime(install, destination);
    // Atomic publish of the measured evidence: both files appear only once the
    // runtime carrying that exact native package is in place.
    renameSync(pending.pack, packReport);
    renameSync(pending.budget, budgetReport);
  } finally {
    for (const file of [pending.pack, pending.budget]) rmSync(file, { force: true });
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

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--runtime-input') throw new Error('Usage: stage-runtime.ts --runtime-input <descriptor.json>');
  await stageDesktopRuntime(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), runCommand, args[1]);
}
