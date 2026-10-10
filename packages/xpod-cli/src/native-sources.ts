import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TOML } from 'bun';
import { sha256File } from './manifest';
import { safeMaterialPath, sourceFileIndex, verifySourceArchive, verifySourceFiles, type SourceFile } from './source-materials';

export interface NativeSourceKit {
  schemaVersion: 1;
  status: 'native-source-materials';
  scope: string;
  engine: { repository: string; commit: string };
  toolchain: string;
  registryPackages: number;
  files: SourceFile[];
}

export function validateNativeBuildReceipt(value: unknown, kit: NativeSourceKit, indexSha256: string, helperSha256: string, target: string): void {
  const receipt = value as {
    schemaVersion: number; target: string; engine: NativeSourceKit['engine']; sourceKitSha256: string; helperSha256: string;
    compiler: { toolchain: string; cargoSha256: string; rustcSha256: string }; buildArguments: string[];
    registryPackages: number; sourceFiles: number; isolatedCargoHome: boolean; stagedVerifiedFilesOnly: boolean;
  };
  if (receipt.schemaVersion !== 1 || receipt.target !== target || receipt.engine?.repository !== kit.engine.repository || receipt.engine.commit !== kit.engine.commit ||
    receipt.sourceKitSha256 !== indexSha256 || receipt.helperSha256 !== helperSha256 || receipt.compiler?.toolchain !== kit.toolchain ||
    !/^[a-f0-9]{64}$/.test(receipt.compiler.cargoSha256) || !/^[a-f0-9]{64}$/.test(receipt.compiler.rustcSha256) ||
    JSON.stringify(receipt.buildArguments) !== JSON.stringify(['build', '--release', '--frozen']) ||
    receipt.registryPackages !== kit.registryPackages || receipt.sourceFiles !== kit.files.length ||
    receipt.isolatedCargoHome !== true || receipt.stagedVerifiedFilesOnly !== true) {
    throw new Error('Native source/build receipt differs from helper, source kit or target');
  }
}

export function runSourceCommand(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) { throw new Error(`${command} failed: ${result.stderr}`); }
  return result.stdout;
}

/** Extracted upstream trees have no .git; never discover the caller's repository. */
export function nativeGitEnvironment(ceiling: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) { if (key.startsWith('GIT_')) { delete env[key]; } }
  env.GIT_CEILING_DIRECTORIES = path.resolve(ceiling);
  return env;
}

export function checkNativePatch(upstream: string, patch: string, applied: boolean): void {
  // Git excludes ancestors at the ceiling, not the current directory itself.
  const env = nativeGitEnvironment(path.dirname(path.resolve(upstream)));
  runSourceCommand('git', ['apply', ...(applied ? ['--reverse'] : []), '--check', '--unidiff-zero', path.resolve(patch)], upstream, env);
  if (!applied) { runSourceCommand('git', ['apply', '--unidiff-zero', path.resolve(patch)], upstream, env); }
}

function engineFromManifest(text: string): NativeSourceKit['engine'] {
  const data = TOML.parse(text) as { dependencies: Record<string, { git: string; rev: string }> };
  const cli = data.dependencies.agentfs;
  const sdk = data.dependencies['agentfs-sdk'];
  if (cli.git !== 'https://github.com/tursodatabase/agentfs' || !/^[a-f0-9]{40}$/.test(cli.rev) || cli.git !== sdk.git || cli.rev !== sdk.rev) {
    throw new Error('Native source engine identities differ');
  }
  return { repository: cli.git, commit: cli.rev };
}

export const NATIVE_PATCHES = ['fuse-revalidation.patch', 'nfs-directory-cookie.patch', 'fuse-owned-session-ready.patch'] as const;
const NATIVE_REBUILD_SCRIPTS = ['rebuild-native.ts', 'collect-native-notices.ts'] as const;

export function nativeWorkingManifest(original: string, engine: NativeSourceKit['engine']): string {
  if (original.includes('[patch.')) { throw new Error('Unexpected original native patch configuration'); }
  return original + `\n[patch."${engine.repository}"]\nagentfs = { path = "../upstream/cli" }\nagentfs-sdk = { path = "../upstream/sdk/rust" }\n`;
}

export function nativeWorkingLock(original: string, engine: NativeSourceKit['engine']): string {
  const source = `git+${engine.repository}?rev=${engine.commit}#${engine.commit}`;
  const lock = TOML.parse(original) as { package: { name: string; source?: string }[] };
  const substituted = lock.package.filter((entry) => entry.source === source).map((entry) => entry.name).sort();
  if (JSON.stringify(substituted) !== JSON.stringify(['agentfs', 'agentfs-sdk'])) { throw new Error('Native lock must substitute only two AgentFS identities'); }
  return original.split('\n').filter((line) => line !== `source = "${source}"`).join('\n');
}

export function validateNativeSourceIndex(value: unknown): NativeSourceKit {
  const kit = value as NativeSourceKit;
  if (kit.schemaVersion !== 1 || kit.status !== 'native-source-materials' || !Array.isArray(kit.files) || !kit.files.length ||
    kit.engine?.repository !== 'https://github.com/tursodatabase/agentfs' || !/^[a-f0-9]{40}$/.test(kit.engine.commit) ||
    !/^nightly-\d{4}-\d{2}-\d{2}$/.test(kit.toolchain) || !Number.isSafeInteger(kit.registryPackages) || kit.registryPackages < 1) {
    throw new Error('Invalid native source kit');
  }
  const files = sourceFileIndex(kit.files);
  for (const name of ['original/helper/Cargo.toml', 'original/helper/Cargo.lock', 'helper/Cargo.toml', 'helper/Cargo.lock',
    'helper/.cargo/config.toml', 'helper/src/main.rs', 'upstream/README.md', 'upstream/sdk/rust/Cargo.toml',
    'upstream/cli/src/fuse.rs', 'upstream/cli/src/nfs.rs', ...NATIVE_PATCHES.map(name => `patches/${name}`),
    'original-upstream.tar', ...NATIVE_REBUILD_SCRIPTS.map(name => `packages/xpod-cli/scripts/${name}`),
    'packages/xpod-cli/src/native-sources.ts', 'packages/xpod-cli/src/source-materials.ts',
    'packages/xpod-cli/src/manifest.ts', 'packages/xpod-cli/src/native-target.ts',
    'licenses/xpod/LICENSE', 'licenses/native/valuable-0.1.1/LICENSE', 'licenses/native/valuable-0.1.1/provenance.json',
    'licenses/native/LICENSE-turso.md', 'licenses/native/LICENSE-simsimd.txt', 'licenses/native/LICENSE-libaegis.txt']) {
    if (!files.has(name)) { throw new Error(`Native source material missing: ${name}`); }
  }
  const checksums = kit.files.filter((file) => /^vendor\/[^/]+\/\.cargo-checksum\.json$/.test(file.path));
  if (checksums.length !== kit.registryPackages) { throw new Error('Native vendor inventory count differs'); }
  return kit;
}

export function verifyNativeSources(root: string): NativeSourceKit {
  const kit = validateNativeSourceIndex(JSON.parse(readFileSync(path.join(root, 'source-kit.json'), 'utf8')));
  verifySourceFiles(root, kit.files);
  verifyNativeWorkingFiles(root, kit);
  return kit;
}

function verifyNativeWorkingFiles(root: string, kit: NativeSourceKit): void {
  const read = (name: string): string => readFileSync(path.join(root, name), 'utf8');
  const original = read('original/helper/Cargo.toml');
  const engine = engineFromManifest(original);
  if (JSON.stringify(engine) !== JSON.stringify(kit.engine) || read('helper/Cargo.toml') !== nativeWorkingManifest(original, engine) ||
    read('helper/Cargo.lock') !== nativeWorkingLock(read('original/helper/Cargo.lock'), engine)) { throw new Error('Native original/work manifest or lock transformation differs'); }
  const config = TOML.parse(read('helper/.cargo/config.toml'));
  const expected = { source: { 'crates-io': { 'replace-with': 'vendored-sources' }, 'vendored-sources': { directory: '../vendor' } } };
  if (JSON.stringify(config) !== JSON.stringify(expected)) { throw new Error('Native source replacement configuration differs'); }
  const upstream = path.join(root, 'upstream');
  for (const patch of NATIVE_PATCHES) {
    checkNativePatch(upstream, path.join(root, 'patches', patch), true);
  }
  const lock = TOML.parse(read('helper/Cargo.lock')) as { package: { name: string; version: string; source?: string; checksum?: string }[] };
  const registry = lock.package.filter((entry) => entry.source?.startsWith('registry+'));
  if (registry.length !== kit.registryPackages || lock.package.some((entry) => entry.source?.startsWith('git+'))) { throw new Error('Native locked/vendor package sets differ'); }
  const files = sourceFileIndex(kit.files);
  for (const entry of registry) {
    const prefix = `vendor/${entry.name}-${entry.version}`;
    if (!files.has(`${prefix}/.cargo-checksum.json`)) { throw new Error(`Locked native package missing: ${entry.name}`); }
    const checksums = JSON.parse(read(`${prefix}/.cargo-checksum.json`)) as { package: string; files: Record<string, string> };
    if (checksums.package !== entry.checksum || !/^[a-f0-9]{64}$/.test(checksums.package)) { throw new Error(`Native registry checksum differs: ${entry.name}`); }
    for (const [file, sha256] of Object.entries(checksums.files)) {
      if (!safeMaterialPath(file) || files.get(`${prefix}/${file}`) !== sha256) { throw new Error(`Native vendor source missing or changed: ${prefix}/${file}`); }
    }
  }
}

export function verifyNativeSourceArchive(archive: string, expectedIndex: Buffer): NativeSourceKit {
  const kit = validateNativeSourceIndex(JSON.parse(expectedIndex.toString('utf8')));
  verifySourceArchive(archive, expectedIndex, 'native-source', kit.files, (root) => verifyNativeWorkingFiles(root, kit));
  return kit;
}

/** Cargo vendors the full locked resolution; system libraries and the toolchain stay external. */
export function exportNativeSources(options: { repoRoot: string; upstream: string; destination: string; offline: boolean }): NativeSourceKit {
  if (existsSync(options.destination)) { throw new Error('Native source destination already exists; choose a fresh directory'); }
  const root = path.resolve(options.destination);
  const helper = path.join(root, 'helper');
  const canonical = path.join(options.repoRoot, 'tools/agentfs-pod');
  const original = readFileSync(path.join(canonical, 'Cargo.toml'), 'utf8');
  const engine = engineFromManifest(original);
  const toolchains = ['build-macos.sh', 'build-linux-container.sh'].map((name) => readFileSync(path.join(canonical, name), 'utf8').match(/nightly-\d{4}-\d{2}-\d{2}/)?.[0]);
  if (!toolchains[0] || toolchains[0] !== toolchains[1]) { throw new Error('Native build toolchains differ'); }
  // rustup which only locates an installed toolchain, never installs one.
  const cargo = runSourceCommand('rustup', ['which', '--toolchain', toolchains[0], 'cargo'], options.repoRoot).trim();
  mkdirSync(path.join(root, 'upstream'), { recursive: true });
  const archive = path.join(root, 'original-upstream.tar');
  runSourceCommand('git', ['-C', path.resolve(options.upstream), 'archive', '--format=tar', `--output=${archive}`, engine.commit], options.repoRoot);
  runSourceCommand('tar', ['-xf', archive, '-C', path.join(root, 'upstream')], options.repoRoot);
  cpSync(path.join(canonical, 'patches'), path.join(root, 'patches'), { recursive: true });
  for (const patch of NATIVE_PATCHES) {
    const file = path.join(root, 'patches', patch);
    const upstream = path.join(root, 'upstream');
    checkNativePatch(upstream, file, false);
  }
  mkdirSync(path.join(root, 'original/helper'), { recursive: true });
  mkdirSync(path.join(helper, '.cargo'), { recursive: true });
  for (const name of ['Cargo.toml', 'Cargo.lock', 'build-macos.sh', 'build-linux-container.sh', 'prepare-upstream.sh']) { cpSync(path.join(canonical, name), path.join(root, 'original/helper', name)); }
  cpSync(path.join(canonical, 'src'), path.join(helper, 'src'), { recursive: true });
  writeFileSync(path.join(helper, 'Cargo.toml'), nativeWorkingManifest(original, engine));
  writeFileSync(path.join(helper, 'Cargo.lock'), nativeWorkingLock(readFileSync(path.join(canonical, 'Cargo.lock'), 'utf8'), engine));
  const config = runSourceCommand(cargo, ['vendor', '--locked', '--versioned-dirs', ...(options.offline ? ['--offline'] : []), '../vendor'], helper);
  writeFileSync(path.join(helper, '.cargo/config.toml'), config);
  cpSync(path.join(options.repoRoot, 'packages/xpod-cli/licenses'), path.join(root, 'licenses'), { recursive: true });
  mkdirSync(path.join(root, 'licenses/xpod'), { recursive: true });
  cpSync(path.join(options.repoRoot, 'LICENSE'), path.join(root, 'licenses/xpod/LICENSE'));
  for (const name of ['native-sources.ts', 'source-materials.ts', 'manifest.ts', 'native-target.ts']) {
    const directory = path.join(root, 'packages/xpod-cli/src'); mkdirSync(directory, { recursive: true });
    cpSync(path.join(options.repoRoot, 'packages/xpod-cli/src', name), path.join(directory, name));
  }
  mkdirSync(path.join(root, 'packages/xpod-cli/scripts'), { recursive: true });
  for (const name of NATIVE_REBUILD_SCRIPTS) {
    cpSync(path.join(options.repoRoot, 'packages/xpod-cli/scripts', name), path.join(root, 'packages/xpod-cli/scripts', name));
  }
  cpSync(path.join(options.repoRoot, 'packages/xpod-cli/NATIVE-SOURCE-README.md'), path.join(root, 'README.md'));
  cpSync(path.join(options.repoRoot, 'package.json'), path.join(root, 'original/xpod-package.json'));
  const files: SourceFile[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (!safeMaterialPath(relative) || lstatSync(file).isSymbolicLink()) { throw new Error(`Unsafe native material: ${relative}`); }
      if (statSync(file).isDirectory()) { visit(file); }
      else if (statSync(file).isFile()) { files.push({ path: relative, sha256: sha256File(file), sizeBytes: statSync(file).size }); }
      else { throw new Error(`Unsupported native material: ${relative}`); }
    }
  };
  visit(root);
  const kit: NativeSourceKit = {
    schemaVersion: 1, status: 'native-source-materials',
    scope: 'Locked dependency/helper source, original upstream and patches, notices with source excerpts and offline Cargo recipe; no Bun/Node/JSC executable or compiler build; external toolchain, SDK/sysroot and system implementation sources excluded; not whole-artifact clearance.',
    engine, toolchain: toolchains[0], registryPackages: readdirSync(path.join(root, 'vendor')).length,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
  writeFileSync(path.join(root, 'source-kit.json'), JSON.stringify(kit, null, 2) + '\n');
  return verifyNativeSources(root);
}
