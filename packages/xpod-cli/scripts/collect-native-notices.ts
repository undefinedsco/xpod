#!/usr/bin/env bun
/** Materialize previously audited Cargo inventory candidates without guessing licenses. */
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { sha256File } from '../src/manifest';

export interface Inventory {
  target: string;
  packages: {
    name: string; version: string; source: string | null; licenseResolved: string | null;
    activeFeatures: string[]; rolesFromMetadataNotBuildUnits: string[];
    licenseFiles: { path: string; relativePath: string; sha256: string }[];
  }[];
}

export interface RuntimeNoticeEvidence {
  target: string;
  runtimeNotices: {
    toolchain: string; compilerCommit: string; scope: string;
    files: { path: string; sourcePath: string; source: string; sha256: string; object?: string }[];
  };
}

function originalFile(filename: string, boundary?: string, directory = false): void {
  if (!path.isAbsolute(filename)) throw new Error('Native notice original must be absolute');
  if (boundary) {
    const relative = path.relative(boundary, filename);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || lstatSync(boundary).isSymbolicLink()) throw new Error('Native notice escaped package boundary');
    let current = boundary;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      if (lstatSync(current).isSymbolicLink()) throw new Error('Native notice original cannot be a symbolic link');
    }
    const actual = path.relative(realpathSync(boundary), realpathSync(filename));
    if (actual === '..' || actual.startsWith(`..${path.sep}`) || path.isAbsolute(actual)) throw new Error('Native notice escaped package boundary');
  }
  const stat = lstatSync(filename);
  if (!(directory ? stat.isDirectory() : stat.isFile()) || stat.isSymbolicLink()) throw new Error('Native notice original must be a regular file or directory of the required type');
}

/** Observe the actual isolated producer workspace and installed compiler, not Git declarations. */
export function generateNativeNotices(options: { target: string; workspace: string; cargo: string; rustc: string;
  env: NodeJS.ProcessEnv; compiler: { toolchain: string; rustcVersion: string }; sourceKitSHA256: string; destination: string }): { indexSHA256: string; provenanceSHA256: string } {
  const { target, workspace, cargo, rustc, env, compiler, destination } = options;
  const commit = compiler.rustcVersion.match(/^commit-hash: ([a-f0-9]{40})$/m)?.[1];
  const triple = compiler.rustcVersion.match(/^host: (\S+)$/m)?.[1];
  const expectedTriple = `${target.endsWith('arm64') ? 'aarch64' : 'x86_64'}-${target.startsWith('darwin-') ? 'apple-darwin' : 'unknown-linux-gnu'}`;
  if (!commit || triple !== expectedTriple) throw new Error('Native notice compiler target mismatch');
  const observations: { stage: string; arguments: string[]; exit: number; signal: null; stdoutSHA256: string; stderrSHA256: string }[] = [];
  const privateInputs = path.join(path.dirname(destination), 'native-notice-inputs');
  mkdirSync(privateInputs, { recursive: true, mode: 0o700 });
  const run = (command: string, args: string[]): string => {
    const result = spawnSync(command, args, { cwd: workspace, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error('Native notice producer command failed');
    const stage = command === cargo ? 'cargo-metadata' : 'rustc-sysroot';
    writeFileSync(path.join(privateInputs, stage + '.stdout.raw'), result.stdout, { mode: 0o600 });
    writeFileSync(path.join(privateInputs, stage + '.stderr.raw'), result.stderr, { mode: 0o600 });
    observations.push({ stage, arguments: args, exit: 0, signal: null,
      stdoutSHA256: createHash('sha256').update(result.stdout).digest('hex'), stderrSHA256: createHash('sha256').update(result.stderr).digest('hex') });
    return result.stdout;
  };
  const metadataBytes = run(cargo, ['metadata', '--format-version', '1', '--frozen', '--filter-platform', triple]);
  const metadata = JSON.parse(metadataBytes) as { packages: { id: string; name: string; version: string; source: string | null; license: string | null; license_file: string | null; manifest_path: string }[];
    resolve: { root: string; nodes: { id: string; features: string[]; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[] } };
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node])); const roles = new Map<string, Set<string>>();
  const visit = (id: string, role: string): void => {
    const previous = roles.get(id) ?? new Set<string>(); if (previous.has(role)) return;
    previous.add(role); roles.set(id, previous);
    const node = nodes.get(id); if (!node) throw new Error('Native notice metadata dependency missing');
    for (const dep of node.deps) for (const kind of dep.dep_kinds) if (kind.kind !== 'dev') visit(dep.pkg, kind.kind === 'build' ? 'build' : role);
  };
  visit(metadata.resolve.root, 'normal');
  const inventory: Inventory = { target: target.replace(/^darwin-/, 'macos-'), packages: metadata.packages.filter(entry => roles.has(entry.id)).map(entry => {
    const base = path.dirname(entry.manifest_path); const candidates = new Set<string>();
    const walk = (dir: string): void => {
      for (const file of readdirSync(dir, { withFileTypes: true })) {
        if (file.isSymbolicLink()) continue;
        const filename = path.join(dir, file.name);
        if (file.isDirectory() && !['.git', 'target'].includes(file.name)) walk(filename);
        else if (file.isFile() && /^(licen[cs]e|copying|copyright|notice)([._-]|$)/i.test(file.name)) candidates.add(filename);
      }
    };
    walk(base);
    if (entry.license_file) {
      const filename = path.resolve(base, entry.license_file); const relative = path.relative(base, filename);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Native notice license_file escaped package');
      originalFile(filename, base);
      candidates.add(filename);
    }
    return { name: entry.name, version: entry.version, source: entry.source, licenseResolved: entry.license,
      activeFeatures: nodes.get(entry.id)!.features, rolesFromMetadataNotBuildUnits: [...roles.get(entry.id)!].sort(),
      licenseFiles: [...candidates].sort().map(filename => { originalFile(filename, base); return { path: filename, relativePath: path.relative(base, filename), sha256: sha256File(filename) }; }) };
  }) };
  const sysroot = run(rustc, ['--print', 'sysroot']).trim(); const doc = path.join(sysroot, 'share/doc/rust');
  originalFile(path.join(doc, 'licenses'), sysroot, true);
  const paths = ['COPYRIGHT-library.html', ...readdirSync(path.join(doc, 'licenses')).sort().map(file => `licenses/${file}`)];
  const runtime: RuntimeNoticeEvidence = { target, runtimeNotices: { toolchain: compiler.toolchain, compilerCommit: commit,
    scope: 'Actual installed sysroot original notices; conservative attribution, not exact linkage or release clearance',
    files: paths.map(relative => {
      const filename = path.join(doc, relative); originalFile(filename, sysroot);
      return { path: filename, sourcePath: `share/doc/rust/${relative}`, source: `installed-sysroot:${triple}@${commit}:share/doc/rust/${relative}`, sha256: sha256File(filename) };
    }) } };
  collectNativeNotices(target, inventory, runtime, destination);
  const provenance = { schemaVersion: 1, target, sourceKitSHA256: options.sourceKitSHA256, compilerCommit: commit, toolchain: compiler.toolchain,
    cargoSHA256: sha256File(cargo), rustcSHA256: sha256File(rustc), metadataSHA256: createHash('sha256').update(metadataBytes).digest('hex'),
    observations,
    metadataArguments: ['metadata', '--format-version', '1', '--frozen', '--filter-platform', triple],
    indexSHA256: sha256File(path.join(destination, `${target}.json`)),
    scope: 'Producer-generated output from actual target metadata and sysroot bytes; not immutable Git source or runtime link graph' };
  writeFileSync(path.join(destination, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  return { indexSHA256: provenance.indexSHA256, provenanceSHA256: sha256File(path.join(destination, 'provenance.json')) };
}

/** New targets require independent actual sysroot files, never another target's inventory. */
export function collectNativeNotices(target: string, inventory: Inventory, runtime: RuntimeNoticeEvidence, root: string): void {
  if (!/^(darwin|linux)-(arm64|x64)$/.test(target)) throw new Error('Unsupported native notice target');
  const expected = target.replace(/^darwin-/, 'macos-');
  if (inventory.target !== expected) { throw new Error(`Inventory target mismatch: ${inventory.target}`); }
  const { runtimeNotices } = runtime;
  if (runtime.target !== target || !runtimeNotices || !/^nightly-\d{4}-\d{2}-\d{2}$/.test(runtimeNotices.toolchain) ||
    !/^[a-f0-9]{40}$/.test(runtimeNotices.compilerCommit) || !runtimeNotices.scope || !Array.isArray(runtimeNotices.files) || !runtimeNotices.files.length) {
    throw new Error('Audit fixed-toolchain runtime notices before regenerating Cargo candidates');
  }
  for (const file of runtimeNotices.files) {
    originalFile(file.path);
    if (!path.isAbsolute(file.path) || !file.sourcePath || !file.source || !/^[a-f0-9]{64}$/.test(file.sha256) ||
      (file.object !== undefined && file.object !== `objects/${file.sha256}.txt`) || sha256File(file.path) !== file.sha256) { throw new Error('Runtime notice drift'); }
  }
  function sourceOrigin(entry: Inventory['packages'][number]): string {
    if (entry.source?.startsWith('registry+')) {
      return `https://static.crates.io/crates/${entry.name}/${entry.name}-${entry.version}.crate`;
    }
    if (entry.name === 'agentfs-pod') { return 'workspace:tools/agentfs-pod'; }
    if (entry.name === 'agentfs' || entry.name === 'agentfs-sdk') {
      return 'https://github.com/tursodatabase/agentfs/tree/0a014ebd4918615baff589ed17486e557e7c6a23';
    }
    throw new Error(`Unrecognized package source: ${entry.name}@${entry.version}`);
  }
  const copies: { source: string; object: string }[] = [];
  const packages = inventory.packages.map((entry) => ({
    name: entry.name, version: entry.version, licenseExpression: entry.licenseResolved,
    // Keep the crate archive as provenance; do not publish workstation paths.
    source: sourceOrigin(entry),
    features: entry.activeFeatures, rolesAdvisory: entry.rolesFromMetadataNotBuildUnits,
    files: entry.licenseFiles.map((file) => {
      originalFile(file.path);
      const sha = sha256File(file.path);
      if (sha !== file.sha256) { throw new Error(`Audited notice changed: ${entry.name}/${file.relativePath}`); }
      const object = `objects/${sha}.txt`;
      copies.push({ source: file.path, object });
      return { originalPath: file.relativePath, object, sha256: sha };
    }),
  }));
  const runtimeFiles = runtimeNotices.files.map(({ path: sourceFile, object: ignored, ...file }) => {
    const object = `objects/${file.sha256}.txt`; copies.push({ source: sourceFile, object }); return { ...file, object };
  });
  // Validate all inputs before writing anything, including when a late Cargo file drifts.
  mkdirSync(path.join(root, 'objects'), { recursive: true });
  for (const file of copies) {
    cpSync(file.source, path.join(root, file.object));
    if (sha256File(path.join(root, file.object)) !== path.basename(file.object, '.txt')) throw new Error('Native notice changed while copying');
  }
  writeFileSync(path.join(root, `${target}.json`), `${JSON.stringify({
    schemaVersion: 1, target, status: 'partial-collection; not release clearance',
    scope: 'normal/build dependencies, not proof that every package is linked at runtime',
    packages, runtimeNotices: { ...runtimeNotices, files: runtimeFiles },
  }, null, 2)}\n`);
  console.log(JSON.stringify({ target, packages: packages.length, files: packages.reduce((sum, entry) => sum + entry.files.length, 0),
    missingPackageOriginals: packages.filter((entry) => entry.files.length === 0).map((entry) => `${entry.name}@${entry.version}`) }));
}

if (import.meta.main) {
  const [target, inventoryFile, runtimeFile, destination] = process.argv.slice(2);
  if (!target || !inventoryFile || !runtimeFile || !destination) throw new Error('Usage: collect-native-notices.ts <target> <audited inventory JSON> <actual runtime evidence JSON> <owned output directory>');
  collectNativeNotices(target, JSON.parse(readFileSync(inventoryFile, 'utf8')), JSON.parse(readFileSync(runtimeFile, 'utf8')), path.resolve(destination));
}
