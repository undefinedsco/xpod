import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { collectPhysicalDependencies, installedPackageRoot, packageRoot, resolvePhysicalRuntimeImport } from '../../../scripts/lib/physical-module-stage';
import { apiRuntimeArtifacts } from './bundle-runtime';
import { bundleFile, verifyApiBundleProducts, type ApiBundleReceipt } from './bundle-products';
import { classifyInputs } from './closure';
import { canonicalSourcePaths, staticSourcePaths, verifyStaticProducts } from './static-material';
import { deduplicateApiSourceRoots, writeApiSourcekit, verifyApiSourcekitRoots, type ApiSourceOwner, type ApiSourceRoot } from './sourcekit-producer';
import { verifyApiSourcekits, type ApiSourcekit } from './sourcekit';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function apiStageFiles(directory: string, excluded = new Set<string>()): string[] {
  const result: string[] = [];
  const visit = (relative: string) => { for (const name of readdirSync(path.join(directory, relative))) {
    if (excluded.has(name)) continue;
    const file = relative ? relative + '/' + name : name, stat = lstatSync(path.join(directory, file));
    if (stat.isSymbolicLink()) throw new Error('API material symlink');
    if (stat.isDirectory()) visit(file); else if (stat.isFile()) result.push(file); else throw new Error('API nonregular material');
  } }; visit(''); return result.sort();
}
export function apiStageExpandedBytes(stage: string): number {
  return apiStageFiles(stage).reduce((sum, file) => sum + lstatSync(path.join(stage, file)).size, 0);
}

/** A single strict authority used by normal stage and pack. No material-only permission. */
export function prepareApiBundleStage(root: string, build: string) {
  const receipt = JSON.parse(readFileSync(path.join(build, 'bundle-products.json'), 'utf8')) as ApiBundleReceipt;
  const manifest = JSON.parse(readFileSync(path.join(root, 'packages/xpod-api/package.json'), 'utf8'));
  const runtimePackages = Object.keys(manifest.dependencies);
  verifyApiBundleProducts(root, build, receipt, runtimePackages);
  const inputs = [...new Set(receipt.products.flatMap(product => product.inputs.map(row => row.path)))].sort();
  const blockers = classifyInputs(inputs.map(file => ({path: file, bytes: lstatSync(path.join(root, file)).size})), root).blockers;
  if (blockers.length) throw new Error('Forbidden service closure: ' + blockers.join(','));
  const staticProducts = verifyStaticProducts(root, build);
  const runtimeImports = [...new Map(receipt.products.flatMap(product => product.runtimeImports).map(row => [JSON.stringify(row), row])).values()];
  const files = receipt.products.flatMap(product => {
    const artifact = apiRuntimeArtifacts[product.role];
    return [[product.entry, artifact.entry], [product.implementation, artifact.implementation], [product.metadata, 'provenance/' + product.metadata.path], [product.rawMetadata, 'provenance/' + product.rawMetadata.path]].map(([row, destination]) => {
      const file = row as typeof product.entry;
      return {source: path.relative(root, path.join(build, file.path)).replaceAll('\\', '/'), destination: destination as string, sha256: file.sha256};
    });
  });
  const receiptFile = path.relative(root, path.join(build, 'bundle-products.json')).replaceAll('\\', '/');
  files.push({source: receiptFile, destination: 'provenance/bundle-products.json', sha256: bundleFile(root, receiptFile).sha256});
  return {receipt, inputs, runtimePackages, runtimeImports, files, staticProducts};
}

/** One canonical producer source authority for sourcekit and normal pack. */
export function apiProducerSourcePaths(root: string): string[] {
  return canonicalSourcePaths(root, ['package.json', 'bun.lock', 'LICENSE', 'packages/xpod-api', 'scripts/lib',
    'packages/xpod-cli/src/module-catalog.ts', 'packages/xpod-cli/src/manifest.ts', 'packages/xpod-cli/src/source-materials.ts',
    'scripts/agentfs-native-ci/supervise.py', 'docs/testing/api-bundle-materials.md', 'docs/testing/physical-module-native-materials.md']);
}

/** Both bundled originals and external runtime distributions share the stage's dependency resolver. */
export function apiOriginalSourceRoots(root: string, plan: ReturnType<typeof prepareApiBundleStage>): ApiSourceRoot[] {
  const installed = (file: string) => file.split('/').includes('node_modules');
  const canonical = new Set([...plan.inputs.filter(file => !installed(file)), ...staticSourcePaths(root), ...apiProducerSourcePaths(root)]);
  const owners = new Map<string, ApiSourceOwner[]>();
  const manifestHashes = new Map<string, string>();
  const relativeFile = (file: string) => path.relative(root, file).replaceAll('\\', '/');
  const manifestHash = (file: string) => { const relative = relativeFile(file); const previous = manifestHashes.get(relative); if (previous) return previous; const digest = bundleFile(root, relative).sha256; manifestHashes.set(relative, digest); return digest; };
  const note = (directory: string, owner: ApiSourceOwner) => {
    const relative = relativeFile(directory); if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('API source origin outside authority');
    const rows = owners.get(directory) ?? []; rows.push(owner); owners.set(directory, rows);
  };
  const seeds = new Set<string>();
  for (const binding of plan.runtimeImports) {
    const resolved = resolvePhysicalRuntimeImport(root, binding.from, binding.specifier).root; seeds.add(resolved);
    note(resolved, {kind: 'runtime-import', from: binding.from, sha256: bundleFile(root, binding.from).sha256, specifier: binding.specifier, ownerManifest: binding.ownerManifest, ownerManifestSHA256: binding.ownerManifestSHA256});
  }
  for (const name of plan.runtimePackages) {
    const manifestFile = path.join(root, plan.receipt.runtimePackageManifest.path);
    const resolved = installedPackageRoot(manifestFile, name); seeds.add(resolved);
    note(resolved, {kind: 'declaration', from: relativeFile(manifestFile), sha256: manifestHash(manifestFile), specifier: name});
  }
  // Static producer dependencies are material, never API runtime lookup roots.
  for (const directory of ['ui', 'packages/xpod-api']) {
    const manifestFile = path.join(root, directory, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    for (const name of Object.keys({...manifest.dependencies, ...manifest.devDependencies})) {
      const dependency = installedPackageRoot(manifestFile, name);
      if (installed(relativeFile(dependency))) { seeds.add(dependency); note(dependency, {kind: 'declaration', from: relativeFile(manifestFile), sha256: manifestHash(manifestFile), specifier: name}); }
    }
  }
  const graph = collectPhysicalDependencies(seeds);
  const originals = new Set([...graph.keys()]);
  for (const [directory, item] of graph) for (const [specifier, target] of item.dependencies) {
    const manifestFile = path.join(directory, 'package.json');
    note(target, {kind: 'dependency', from: relativeFile(manifestFile), sha256: manifestHash(manifestFile), specifier});
  }
  const materialOwners = new Set<string>();
  for (const file of plan.inputs) {
    const input = bundleFile(root, file);
    const owner = realpathSync(packageRoot(path.join(root, file)));
    if (installed(relativeFile(owner))) note(owner, {kind: 'bundle-input', from: file, sha256: input.sha256});
    if (materialOwners.has(owner)) continue;
    materialOwners.add(owner);
    bundleFile(root, path.relative(root, path.join(owner, 'package.json')).replaceAll('\\', '/'));
    const relative = path.relative(root, owner).replaceAll('\\', '/');
    if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('API input source owner outside source authority');
    if (installed(relative)) originals.add(owner);
    else if (relative) canonicalSourcePaths(root, [relative]).forEach(file => canonical.add(file));
  }
  return deduplicateApiSourceRoots([{directory: realpathSync(root), prefix: 'canonical', files: [...canonical].sort()}, ...[...originals].sort().map(directory => {
    const relative = path.relative(root, directory).replaceAll('\\', '/');
    if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('API original distribution outside source authority');
    return {directory: realpathSync(directory), prefix: 'originals/' + hash(relative), owners: owners.get(directory) ?? []};
  })]);
}

function sourceRootBindings(root: string, roots: ApiSourceRoot[]) {
  const relative = (directory: string) => path.relative(root, directory).replaceAll('\\', '/') || '.';
  return roots.map(row => ({directory: relative(row.directory), prefix: row.prefix, ...(row.files ? {files: row.files} : {})}));
}

function sourcekitOriginalPackages(roots: ApiSourceRoot[], kit: ApiSourcekit) {
  if (lstatSync(kit.index).size > 32 * 1024 * 1024) throw new Error('API original index byte bound');
  const rows = JSON.parse(readFileSync(kit.index, 'utf8')).files as Array<{path: string; sha256: string; sizeBytes: number}>;
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.path.startsWith('originals/')) continue;
    const prefix = row.path.split('/').slice(0, 2).join('/');
    const group = grouped.get(prefix) ?? []; group.push(row); grouped.set(prefix, group);
  }
  return roots.filter(row => !row.files).map(root => {
    const manifestBytes = readFileSync(path.join(root.directory, 'package.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const files = grouped.get(root.prefix) ?? [];
    if (!files.some(row => row.path === root.prefix + '/package.json' && row.sha256 === hash(manifestBytes))) throw new Error('API original package manifest binding drift');
    return {name: manifest.name, version: manifest.version, prefix: root.prefix, manifestSHA256: hash(manifestBytes),
      namedTerms: files.filter(row => row.sizeBytes > 0 && /(?:^|\/)(?:licen[cs]e|copying|notice)(?:[._-]|$)/iu.test(row.path.slice(root.prefix.length + 1))).map(row => ({path: row.path, sha256: row.sha256, bytes: row.sizeBytes}))};
  });
}

export function attachApiSourcekit(root: string, stage: string, plan: ReturnType<typeof prepareApiBundleStage>): void {
  const roots = apiOriginalSourceRoots(root, plan);
  const {kit, budget} = writeApiSourcekit(path.join(stage, 'provenance/sourcekits'), roots, apiStageExpandedBytes(stage));
  const originalPackages = sourcekitOriginalPackages(roots, kit);
  const missingNamedOriginalTerms = originalPackages.filter(row => !row.namedTerms.length).map(row => ({name: row.name, version: row.version}));
  const binding = {archive: path.relative(stage, kit.archive).replaceAll('\\', '/'), index: path.relative(stage, kit.index).replaceAll('\\', '/'), sha256: kit.sha256};
  writeFileSync(path.join(stage, 'provenance/api-source-materials.json'), JSON.stringify({schemaVersion: 1, role: 'source-only', kit: binding, budget, originalPackages, missingNamedOriginalTerms, roots: sourceRootBindings(root, roots), publishReady: false, noticeAudit: 'pending', nativeAudit: 'pending'}, null, 2) + '\n', {flag: 'wx'});
}

export function verifyApiStageMaterials(root: string, build: string, stage: string, requireCompleteTerms = false): void {
  const plan = prepareApiBundleStage(root, build);
  for (const file of plan.files) if (hash(readFileSync(path.join(stage, file.destination))) !== file.sha256) throw new Error('Staged API bundle material drift');
  for (const asset of plan.staticProducts.assets) if (hash(readFileSync(path.join(stage, asset.path))) !== asset.sha256) throw new Error('Staged API static asset drift');
  const record = JSON.parse(readFileSync(path.join(stage, 'provenance/api-source-materials.json'), 'utf8'));
  if (record.schemaVersion !== 1 || record.role !== 'source-only' || record.publishReady !== false || record.noticeAudit !== 'pending' || record.nativeAudit !== 'pending') throw new Error('API source material role mismatch');
  const roots = apiOriginalSourceRoots(root, plan);
  const expectedRoots = sourceRootBindings(root, roots);
  if (JSON.stringify(record.roots) !== JSON.stringify(expectedRoots) || record.kit?.archive !== 'provenance/sourcekits/originals.tgz' || record.kit?.index !== 'provenance/sourcekits/source-kit.json') throw new Error('API original source root binding drift');
  const kit: ApiSourcekit = {archive: path.join(stage, record.kit.archive), index: path.join(stage, record.kit.index), sha256: record.kit.sha256};
  const runtime = apiStageExpandedBytes(stage);
  verifyApiSourcekits([kit], runtime);
  verifyApiSourcekitRoots(kit, roots, runtime);
  const index = JSON.parse(readFileSync(kit.index, 'utf8')) as {files: Array<{path: string; sha256: string}>};
  const allowedSources = new Map(index.files.filter(row => row.path.startsWith('canonical/')).map(row => [row.path.slice('canonical/'.length), row.sha256]));
  for (const asset of plan.staticProducts.assets) allowedSources.set(asset.path, asset.sha256);
  for (const file of apiStageFiles(path.join(stage, 'source'))) {
    const expected = allowedSources.get(file);
    if (!expected || hash(readFileSync(path.join(stage, 'source', file))) !== expected) throw new Error('Unapproved or drifted staged API source: ' + file);
  }
  const originalPackages = sourcekitOriginalPackages(roots, kit);
  const missing = originalPackages.filter(row => !row.namedTerms.length).map(row => ({name: row.name, version: row.version}));
  if (JSON.stringify(record.originalPackages) !== JSON.stringify(originalPackages) || JSON.stringify(record.missingNamedOriginalTerms) !== JSON.stringify(missing)) throw new Error('API original named terms inventory drift');
  if (requireCompleteTerms && missing.length) throw new Error('API original named terms missing: ' + missing.map(row => row.name + '@' + row.version).join(','));
}
