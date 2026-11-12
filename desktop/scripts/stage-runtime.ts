import { stageBundledBun } from './bun-runtime-material';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SERVICE_MODULES, MODULE_API_VERSION, MODULE_CATALOG, modulePackageName } from '../../packages/xpod-cli/src/module-catalog';

const require = createRequire(import.meta.url);
const { EMBEDDED_SOURCE_RELATIVE_PATH, EMBEDDED_SOURCE_MANIFEST_RELATIVE_PATH } = require('../../scripts/platform-binaries.cjs') as {
  EMBEDDED_SOURCE_RELATIVE_PATH: string; EMBEDDED_SOURCE_MANIFEST_RELATIVE_PATH: string;
};

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

/** One packaged capability artifact produced by the existing CSS/API producers. */
export interface PackagedCapability {
  /** Module id from the single shared catalog (`css` or `api`). */
  id: 'css' | 'api';
  /** Directory holding `package/package.json` with a verified `xpodModule`. */
  packageRoot: string;
  version: string;
}
/** Produces the capabilities to ship beside the runtime, using existing producers. */
export type CapabilityProducer = (stageDir: string) => Promise<PackagedCapability[]>;

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
 * Produce the packaged capabilities using each producer's REAL protocol.
 *
 * No second pipeline is recreated here: every step below is the exact command
 * the package's own supported entry accepts, run in its own directory.
 *
 *  - CSS: `build-package.ts --out <stage> --publication preview --version <v>
 *    --native-runtime-input <descriptor> --archive <tgz>`. The descriptor is the
 *    documented CssNativeRuntimeInput shape and is built from the ALREADY
 *    ACCEPTED QLever artifact the desktop build has staged (no SDK/C++ rebuild).
 *  - API: `stage.ts <stage> preview <version> ...` then `pack.ts <stage> <tgz>`.
 *    Only `packPhysicalModule` (called by pack) writes `xpodModule`, so BOTH run.
 */
function capabilityProducer(repoRoot: string, nativeStage: NativePlatformStage): CapabilityProducer {
  return async (stageDir) => {
    mkdirSync(stageDir, { recursive: true, mode: 0o700 });
    const target = `${process.platform}-${process.arch}`;
    const produced: PackagedCapability[] = [];
    const runStep = (label: string, command: string[], cwd: string): string => {
      const result = spawnSync(command[0]!, command.slice(1), { cwd, encoding: 'utf8' });
      if (result.status !== 0) {
        throw new Error(`${label} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 500)}`);
      }
      return result.stdout ?? '';
    };

    for (const id of requiredServiceCapabilities()) {
      const scratch = path.join(stageDir, id);
      mkdirSync(scratch, { recursive: true, mode: 0o700 });
      const packageRoot = path.join(scratch, 'package');
      const archive = path.join(scratch, 'product.tgz');

      if (id === 'css') {
        // CSS consumes the REAL retained originals recorded beside the accepted
        // QLever payload: the untouched original ZIP, the original tar, the raw
        // acceptance document and the raw runtime manifest. Nothing is re-tarred
        // or re-identified here.
        const materials = cssNativeMaterials(repoRoot);
        const nativeManifest = path.join(path.dirname(path.dirname(nativeStage.qleverRuntimeOutputPath)), 'manifest.json');
        if (!readFileSync(nativeManifest).equals(readFileSync(path.join(materials.runtimeRoot, 'manifest.json')))) {
          throw new Error('Desktop and CSS native producers selected different QLever manifests');
        }
        const version = JSON.parse(readFileSync(path.join(repoRoot, 'packages', 'xpod-css', 'package.json'), 'utf8')).version;
        if (typeof version !== 'string') throw new Error('CSS producer has no declared module version');
        await cssCapability({ repoRoot, packageRoot, archive, version, materials,
          run: (label, argv, cwd) => { runStep(label, argv, cwd); } });
      } else {
        // API capability production is C's helper; it owns that pipeline and the
        // canonical producer invocation. We only consume its produced archive.
        const api = await import('./api-capability-producer');
        // Prepared from the clean checkout before candidate version stamping.
        // Consumption rechecks its source/receipt/bytes without rebuilding.
        const producedApi = api.consumeApiCapability({ repoRoot });
        copyTree(producedApi.packageRoot, packageRoot);
        produced.push({ id: 'api', packageRoot, version: producedApi.version });
        continue;
      }
      const manifestBytes = readFileSync(path.join(packageRoot, 'package.json'));
      const manifest = JSON.parse(manifestBytes.toString()) as { version?: string; xpodModule?: unknown };
      if (!manifest.xpodModule) throw new Error(`Packaged capability ${id} was not packed into a module product`);
      if (!manifest.version) throw new Error(`Packaged capability ${id} has no version`);
      produced.push({ id, packageRoot, version: manifest.version });
    }
    return produced;
  };
}

/**
 * The retained QLever originals this build already has on disk.
 *
 * Layout is canonical and derived (no new user setup, no env alias):
 *   <repo>/.test-data/qlever-runtime/qlever-local-runtime-<target>.tar.gz   (original tar)
 *   <repo>/.test-data/qlever-runtime/qlever-local-acceptance.json            (raw acceptance)
 *   <repo>/.test-data/qlever-runtime/runtime/manifest.json                   (raw runtime manifest)
 *   <repo>/.test-data/qlever-runtime/qlever-native-artifact.zip              (untouched ORIGINAL zip)
 *   <repo>/.test-data/qlever-runtime/qlever-native-authority.json            (verified artifact metadata)
 */
export interface CssNativeMaterials {
  runtimeRoot: string;
  materialsRoot: string;
  sourceSha: string;
  manifest: { path: string; sizeBytes: number; sha256: string };
  archive: { path: string; sizeBytes: number; sha256: string };
  originalZip: { path: string; sizeBytes: number; sha256: string };
  acceptance: { path: string; sizeBytes: number; sha256: string };
}

/**
 * Resolve the retained originals and their TRUE source identity.
 *
 * Paths are returned RELATIVE to materialsRoot because that is the
 * SourceFile contract. The source identity comes from the verified artifact
 * authority, never from the runner's GITHUB_SHA.
 */
export function cssNativeMaterials(repoRoot: string): CssNativeMaterials {
  const materialsRoot = path.join(repoRoot, '.test-data', 'qlever-runtime');
  const authorityPath = path.join(materialsRoot, 'qlever-native-authority.json');
  if (!existsSync(authorityPath)) {
    throw new Error(`CSS native authority is missing at ${path.relative(repoRoot, authorityPath)}; the desktop build needs the retained original artifact materials`);
  }
  const authority = JSON.parse(readFileSync(authorityPath, 'utf8')) as {
    sourceSha?: unknown; target?: unknown; digest?: unknown; artifactId?: unknown;
  };
  if (typeof authority.sourceSha !== 'string' || !/^[a-f0-9]{40}$/u.test(authority.sourceSha)) {
    throw new Error('CSS native authority has no true source identity');
  }
  const target = `${process.platform}-${process.arch}`;
  if (authority.target !== target) throw new Error('CSS native authority target differs from this build target');
  const runtimeRoot = path.join(materialsRoot, 'runtime');
  const archiveName = `qlever-local-runtime-${target}.tar.gz`;
  const reference = (relative: string) => {
    const absolute = path.join(materialsRoot, relative);
    if (!existsSync(absolute)) throw new Error(`CSS native original is missing: ${relative}`);
    const bytes = readFileSync(absolute);
    return { path: relative, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  // The runtime manifest is verified against runtimeRoot and MUST be named
  // `manifest.json` there; the other three refs are relative to materialsRoot
  // and must match the original ZIP's own member basenames.
  const originalZip = reference('qlever-native-artifact.zip');
  if (authority.digest !== `sha256:${originalZip.sha256}`) {
    throw new Error('CSS retained ZIP differs from its artifact authority');
  }
  return {
    runtimeRoot, materialsRoot, sourceSha: authority.sourceSha,
    manifest: { ...reference('runtime/manifest.json'), path: 'manifest.json' },
    archive: reference(archiveName),
    originalZip,
    acceptance: reference('qlever-local-acceptance.json'),
  };
}

/**
 * Produce the CSS capability with the EXISTING builder and its real inputs.
 * The descriptor is written next to the materials so every SourceFile reference
 * stays relative and points at genuine originals.
 */
export async function cssCapability(input: {
  repoRoot: string; packageRoot: string; archive: string; version: string;
  materials: CssNativeMaterials; run: (label: string, argv: string[], cwd: string) => void;
}): Promise<void> {
  const descriptorPath = path.join(input.materials.materialsRoot, 'css-native-input.json');
  const { runtimeRoot, materialsRoot, sourceSha, manifest, archive, originalZip, acceptance } = input.materials;
  writeFileSync(descriptorPath, JSON.stringify({
    // The builder is invoked with cwd=<repo>/packages/xpod-css and reads these
    // with path.resolve/join, so they must be ABSOLUTE. Only the SourceFile
    // entries below are relative-to-materialsRoot, which is their contract.
    runtimeRoot,
    materialsRoot,
    manifest, archive, originalZip, acceptance,
    sourceSha,
    format: 'macos-native-materials',
  }, null, 2) + '\n', { mode: 0o600 });
  input.run('css build-package', ['bun', 'scripts/build-package.ts', '--out', input.packageRoot,
    '--publication', 'preview', '--version', input.version,
    '--native-runtime-input', descriptorPath, '--archive', input.archive],
  path.join(input.repoRoot, 'packages', 'xpod-css'));
}

/** Copy a produced capability tree without following links. */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name); const target = path.join(to, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Capability tree cannot contain links');
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) writeFileSync(target, readFileSync(source), { mode: 0o600 });
    else throw new Error('Capability tree contains an unsupported member');
  }
}

/**
 * Capabilities this build MUST ship: the SAME declaration `xpod start` binds by
 * default. A normal packaged desktop therefore always carries them; there is no
 * opt-in descriptor flag and no way to build a desktop missing its own defaults.
 */
export function requiredServiceCapabilities(): ('css' | 'api')[] {
  const ids: ('css' | 'api')[] = [];
  for (const value of DEFAULT_SERVICE_MODULES) {
    const definition = MODULE_CATALOG.find(row => row.id === value);
    if (!definition || (definition.id !== 'css' && definition.id !== 'api')) {
      throw new Error(`Default service capability is not a service module: ${String(value)}`);
    }
    if (ids.includes(definition.id)) throw new Error(`Duplicate default service capability: ${definition.id}`);
    ids.push(definition.id);
  }
  if (!ids.length) throw new Error('A packaged desktop must declare its default service capabilities');
  return ids;
}

/**
 * Materialize the packaged capability SEED the runtime imports from.
 *
 * The seed is written into the build output (which becomes the read-only bundle
 * tree) as `<runtime>/modules/<id>/<platform>-<arch>/<version>/package/...`, the
 * EXACT layout ModuleStore already reads. Every capability is validated against
 * the single shared catalog and its own `xpodModule` inventory here, so the
 * bundle can never ship a capability the runtime would reject later.
 */
export function materializeCapabilitySeed(runtimeRoot: string, capabilities: readonly PackagedCapability[]): string[] {
  const target = `${process.platform}-${process.arch}`;
  const seen = new Set<string>();
  const staged: string[] = [];
  for (const capability of capabilities) {
    const definition = MODULE_CATALOG.find(row => row.id === capability.id);
    if (!definition) throw new Error(`Unknown packaged capability: ${capability.id}`);
    if (seen.has(capability.id)) throw new Error(`Duplicate packaged capability: ${capability.id}`);
    seen.add(capability.id);
    const expectedName = modulePackageName(capability.id, process.platform, process.arch);
    if (!expectedName) throw new Error(`Unsupported packaged capability target for ${capability.id}`);
    const manifestBytes = readFileSync(path.join(capability.packageRoot, 'package.json'));
    const manifest = JSON.parse(manifestBytes.toString()) as {
      name?: string; version?: string; xpodModule?: { schemaVersion?: number; id?: string; cliApiVersion?: number;
        platform?: string; arch?: string; entry?: string; files?: { path: string; sha256: string; size: number; mode: number }[] };
    };
    const moduleManifest = manifest.xpodModule;
    if (manifest.name !== expectedName || manifest.version !== capability.version || !moduleManifest
      || moduleManifest.schemaVersion !== 1 || moduleManifest.id !== capability.id
      || moduleManifest.cliApiVersion !== MODULE_API_VERSION
      || moduleManifest.platform !== process.platform || moduleManifest.arch !== process.arch
      || !moduleManifest.entry || !Array.isArray(moduleManifest.files) || !moduleManifest.files.length) {
      throw new Error(`Packaged capability ${capability.id} does not satisfy the shared module contract`);
    }
    for (const file of moduleManifest.files) {
      const absolute = path.join(capability.packageRoot, file.path);
      const bytes = readFileSync(absolute);
      if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
        throw new Error(`Packaged capability ${capability.id} file differs from its own inventory: ${file.path}`);
      }
      if (![0o644, 0o755].includes(file.mode)) throw new Error(`Packaged capability ${capability.id} has an invalid file mode`);
    }
    const destination = path.join(runtimeRoot, 'modules', capability.id, target, capability.version, 'package');
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const file of moduleManifest.files) {
      const target_ = path.join(destination, file.path);
      mkdirSync(path.dirname(target_), { recursive: true, mode: 0o700 });
      writeFileSync(target_, readFileSync(path.join(capability.packageRoot, file.path)), { mode: file.mode, flag: 'wx' });
      chmodSync(target_, file.mode);
    }
    // The manifest is written last and exactly as verified above.
    writeFileSync(path.join(destination, 'package.json'), manifestBytes, { mode: 0o644, flag: 'wx' });
    staged.push(capability.id);
  }
  return staged;
}

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
  /** Test seam; production always uses the canonical capability producers. */
  capabilityProducerOverride?: CapabilityProducer,
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
    if (!existsSync(path.join(nativeStage.stageDir, EMBEDDED_SOURCE_MANIFEST_RELATIVE_PATH))) {
      throw new Error('Native platform stage is missing its corresponding Source');
    }
    cpSync(path.join(nativeStage.stageDir, EMBEDDED_SOURCE_RELATIVE_PATH), path.join(install, EMBEDDED_SOURCE_RELATIVE_PATH), { recursive: true });

    // Package the capabilities the Local runtime starts from. They are validated
    // against the single shared catalog + their own xpodModule inventory and
    // written as the READ-ONLY seed the runtime imports into an OWNED store.
    // A normal desktop build ALWAYS ships the capabilities `xpod start` binds by
    // default; failing to produce one fails the build instead of shipping a
    // desktop that cannot start.
    const required = requiredServiceCapabilities();
    const produceCapabilities = capabilityProducerOverride
      ?? capabilityProducer(repoRoot, nativeStage);
    const capabilities = (await produceCapabilities(path.join(temporary, 'capabilities')))
      .filter(capability => required.includes(capability.id));
    const staged = materializeCapabilitySeed(install, capabilities);
    const missing = required.filter(id => !staged.includes(id));
    if (missing.length) throw new Error(`Default service capability was not packaged: ${missing.join(', ')}`);

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
