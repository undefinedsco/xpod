import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sha256File } from './manifest';
import { safeMaterialPath as safeRelative, sourceFileIndex, verifySourceArchive, verifySourceFiles, type SourceFile } from './source-materials';
import { bunCompileTarget } from './native-target';

interface JavascriptIndex {
  schemaVersion: number; target: string; cliSha256: string;
  inputs: { path: string; sha256: string }[];
  packages: { root: string; name: string; version: string; packageJsonSha256: string }[];
  externalImports: string[];
}

export interface ApplicationSourceKit {
  schemaVersion: 2;
  distribution: 'external-runtime';
  status: 'application-materials';
  scope: string;
  target: string;
  cliSha256: string;
  source: { commit: string | null; dirtyTreeHash: string | null };
  compiler: { version: string; executableSha256: string; hostTarget: string };
  recipe: { entry: string; workingDirectory: '.'; defines: []; removedEnvironmentOptions: string[]; usesInvokedBundler: true };
  inputs: JavascriptIndex['inputs'];
  externalImports: string[];
  files: SourceFile[];
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/** Snapshot actual application bytes; this is not the embedded runtime's corresponding source. */
export function exportApplicationSources(options: {
  stageRoot: string; repoRoot: string; packageRoot: string; notices: string; destination: string;
  target: string; cli: string; compiler: string; compilerVersion: string; hostTarget: string;
  source: ApplicationSourceKit['source'];
}): ApplicationSourceKit {
  bunCompileTarget(options.target);
  const stage = realpathSync(options.stageRoot);
  const dependencies = realpathSync(path.join(options.repoRoot, 'node_modules'));
  const indexFile = path.join(options.notices, 'javascript/index.json');
  const index = JSON.parse(readFileSync(indexFile, 'utf8')) as JavascriptIndex;
  const cliSha256 = sha256File(options.cli);
  if (index.schemaVersion !== 1 || index.target !== options.target || index.cliSha256 !== cliSha256 ||
    !Array.isArray(index.inputs) || !index.inputs.length || !Array.isArray(index.packages) || !Array.isArray(index.externalImports)) {
    throw new Error('Invalid application compile input index');
  }
  const inputNames = new Set<string>();
  for (const input of index.inputs) {
    if (!safeRelative(input.path) || inputNames.has(input.path) || !/^[a-f0-9]{64}$/.test(input.sha256)) {
      throw new Error('Unsafe or duplicate application input');
    }
    inputNames.add(input.path);
    const base = input.path.startsWith('node_modules/') ? dependencies : stage;
    const relative = base === dependencies ? input.path.slice('node_modules/'.length) : input.path;
    const original = realpathSync(path.join(base, relative));
    if (!within(base, original) || sha256File(original) !== input.sha256) {
      throw new Error(`Application input drift or escape: ${input.path}`);
    }
  }
  const packageRoots = new Set<string>();
  for (const entry of index.packages) {
    if (!safeRelative(entry.root) || !entry.root.startsWith('node_modules/') || packageRoots.has(entry.root)) {
      throw new Error('Unsafe or duplicate application package root');
    }
    packageRoots.add(entry.root);
    const filename = realpathSync(path.join(dependencies, entry.root.slice('node_modules/'.length), 'package.json'));
    if (!within(dependencies, filename) || sha256File(filename) !== entry.packageJsonSha256) { throw new Error('Application package manifest drift'); }
    const info = JSON.parse(readFileSync(filename, 'utf8'));
    if (info.name !== entry.name || info.version !== entry.version) { throw new Error('Application package identity mismatch'); }
  }
  // First plan and hash every file. Symlinks are flattened only within their
  // source tree, so neither checkout paths nor external caches leak into the kit.
  const files = new Map<string, { original: string; record: SourceFile }>();
  const add = (original: string, relative: string): void => {
    if (!safeRelative(relative)) { throw new Error('Unsafe application material path'); }
    const record = { path: relative, sha256: sha256File(original), sizeBytes: statSync(original).size };
    const previous = files.get(relative);
    if (previous && previous.record.sha256 !== record.sha256) { throw new Error(`Conflicting application material: ${relative}`); }
    files.set(relative, { original, record });
  };
  const tree = (root: string, prefix: string): void => {
    const boundary = realpathSync(root);
    const visit = (file: string, relative: string, parents: Set<string>): void => {
      const resolved = realpathSync(file);
      if (!within(boundary, resolved) || parents.has(resolved)) { throw new Error(`Application material symlink escape or cycle: ${relative}`); }
      if (statSync(resolved).isDirectory()) {
        const ancestors = new Set(parents).add(resolved);
        for (const entry of readdirSync(resolved)) { visit(path.join(resolved, entry), `${relative}/${entry}`, ancestors); }
      } else if (statSync(resolved).isFile()) { add(resolved, relative); }
      else { throw new Error(`Unsupported application material: ${relative}`); }
    };
    visit(boundary, prefix, new Set());
  };
  tree(path.join(stage, 'src'), 'src');
  tree(path.join(stage, 'packages/xpod-cli/src'), 'packages/xpod-cli/src');
  tree(path.join(options.packageRoot, 'scripts'), 'packages/xpod-cli/scripts');
  tree(options.notices, 'licenses');
  for (const entry of index.packages) {
    tree(path.join(dependencies, entry.root.slice('node_modules/'.length)), entry.root);
  }
  add(path.join(stage, 'package.json'), 'package.json');
  add(path.join(options.packageRoot, 'package.json'), 'packages/xpod-cli/package.json');
  add(path.join(options.repoRoot, 'bun.lock'), 'bun.lock');
  add(path.join(options.notices, '../NOTICES.md'), 'NOTICES.md');
  add(path.join(options.packageRoot, 'APPLICATION-SOURCE-README.md'), 'README.md');
  for (const input of index.inputs) {
    if (files.get(input.path)?.record.sha256 !== input.sha256) { throw new Error(`Input missing from application material: ${input.path}`); }
  }
  const kit: ApplicationSourceKit = {
    schemaVersion: 2, distribution: 'external-runtime', status: 'application-materials',
    scope: 'Actual application source, installed dependency bytes, notices and compile recipe. Excludes Bun/JSC/toolchain and native helper source/build closure; not whole-artifact release clearance.',
    target: options.target, cliSha256, source: options.source,
    compiler: { version: options.compilerVersion, executableSha256: sha256File(options.compiler), hostTarget: options.hostTarget },
    recipe: { entry: 'packages/xpod-cli/src/entry.ts', workingDirectory: '.', defines: [], removedEnvironmentOptions: ['NODE_ENV', 'NODE_OPTIONS', 'BUN_OPTIONS'], usesInvokedBundler: true },
    inputs: index.inputs, externalImports: index.externalImports,
    files: [...files.values()].map((entry) => entry.record).sort((a, b) => a.path.localeCompare(b.path)),
  };
  for (const entry of files.values()) {
    const output = path.join(options.destination, entry.record.path);
    mkdirSync(path.dirname(output), { recursive: true });
    cpSync(entry.original, output);
    if (sha256File(output) !== entry.record.sha256) { throw new Error(`Application material changed during copy: ${entry.record.path}`); }
  }
  writeFileSync(path.join(options.destination, 'source-kit.json'), JSON.stringify(kit, null, 2) + '\n');
  return kit;
}

export function validateApplicationSourceIndex(value: unknown): ApplicationSourceKit {
  const kit = value as ApplicationSourceKit;
  if (kit.schemaVersion !== 2 || kit.distribution !== 'external-runtime' || kit.status !== 'application-materials' || !Array.isArray(kit.files) || !kit.files.length ||
    !Array.isArray(kit.inputs) || !kit.inputs.length || kit.recipe?.entry !== 'packages/xpod-cli/src/entry.ts' ||
    kit.recipe.usesInvokedBundler !== true || kit.recipe.workingDirectory !== '.' ||
    !Array.isArray(kit.recipe.defines) || kit.recipe.defines.length !== 0 ||
    JSON.stringify(kit.recipe.removedEnvironmentOptions) !== JSON.stringify(['NODE_ENV', 'NODE_OPTIONS', 'BUN_OPTIONS']) || !/^[a-f0-9]{64}$/.test(kit.cliSha256)) {
    throw new Error('Invalid application source kit');
  }
  bunCompileTarget(kit.target);
  const files = sourceFileIndex(kit.files);
  const inputs = new Set<string>();
  for (const input of kit.inputs) {
    if (!safeRelative(input.path) || inputs.has(input.path) || !/^[a-f0-9]{64}$/.test(input.sha256) || files.get(input.path) !== input.sha256) {
      throw new Error(`Compile input missing from source kit: ${input.path}`);
    }
    inputs.add(input.path);
  }
  if (!files.has(kit.recipe.entry) || !files.has('packages/xpod-cli/scripts/rebuild-application.ts')) { throw new Error('Source kit entry or recipe missing'); }
  return kit;
}

export function verifyApplicationSources(root: string): ApplicationSourceKit {
  const kit = validateApplicationSourceIndex(JSON.parse(readFileSync(path.join(root, 'source-kit.json'), 'utf8')));
  verifySourceFiles(root, kit.files);
  return kit;
}

export function verifyApplicationSourceArchive(archive: string, expectedIndex: Buffer): ApplicationSourceKit {
  const kit = validateApplicationSourceIndex(JSON.parse(expectedIndex.toString('utf8')));
  verifySourceArchive(archive, expectedIndex, 'application-source', kit.files);
  return kit;
}
