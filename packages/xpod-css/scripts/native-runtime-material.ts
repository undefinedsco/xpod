import path from 'node:path';
import { copyFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { safeMaterialPath, sourceFileIndex, verifySourceFiles, type SourceFile } from '../../xpod-cli/src/source-materials';
import { verifyNativeMaterialTarget } from '../../../scripts/lib/physical-module-native';
import { moduleTarget } from '../../xpod-cli/src/module-catalog';

/** Byte/layout integrity only. Official identity and release authority remain external admission. */
export interface CssNativeRuntimeInput {
  runtimeRoot: string;
  materialsRoot: string;
  manifest: SourceFile;
  archive: SourceFile;
  originalZip: SourceFile;
  acceptance: SourceFile;
  sourceSha: string;
}

function regularTree(root: string): string[] {
  let ancestor = path.resolve(root);
  while (true) {
    if (lstatSync(ancestor).isSymbolicLink()) throw new Error('Native input symlink ancestor');
    const next = path.dirname(ancestor); if (next === ancestor) break; ancestor = next;
  }
  if (!lstatSync(root).isDirectory()) throw new Error('Native input root is not a directory');
  const result: string[] = [];
  const visit = (relative: string): void => {
    for (const name of readdirSync(path.join(root, relative))) {
      const next = relative ? relative + '/' + name : name;
      if (!safeMaterialPath(next)) throw new Error('Unsafe native input path');
      const stat = lstatSync(path.join(root, next));
      if (stat.isSymbolicLink()) throw new Error('Native input symlink');
      if (stat.isDirectory()) visit(next);
      else if (stat.isFile()) result.push(next);
      else throw new Error('Native input is not regular');
    }
  };
  visit(''); return result.sort();
}

export function assembleCssNativeRuntime(productRoot: string, target: string, input: CssNativeRuntimeInput): SourceFile[] {
  const targetParts = target.split('-');
  if (targetParts.length !== 2 || !moduleTarget(targetParts[0], targetParts[1])) throw new Error('Unsupported CSS native target');
  const members = regularTree(input.runtimeRoot);
  regularTree(input.materialsRoot);
  const product = realpathSync(productRoot), material = realpathSync(input.materialsRoot);
  const contains = (a: string, b: string): boolean => b === a || b.startsWith(a + path.sep);
  if (contains(product, material) || contains(material, product)) throw new Error('Native materials must remain external');
  const refs = [input.archive, input.originalZip, input.acceptance];
  sourceFileIndex(refs); verifySourceFiles(input.materialsRoot, refs);
  const require = createRequire(import.meta.url);
  const { verifyQleverLocal, loadQleverSourceConformance } = require('../../../scripts/release-gate-evidence.cjs') as {
    verifyQleverLocal: (args: { sourceSha: string; evidence: string; expectedArchive: string; abiPlatform: string }) => void;
    loadQleverSourceConformance: () => { adapterAbiVersion: number; physicalBackendAbiVersion: number };
  };
  verifyQleverLocal({ sourceSha: input.sourceSha, evidence: path.join(input.materialsRoot, input.acceptance.path), expectedArchive: path.join(input.materialsRoot, input.archive.path), abiPlatform: target.replace(/^darwin-/, 'macos-') });
  const zip = path.join(input.materialsRoot, input.originalZip.path);
  const zipListing = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const zipNames = zipListing.stdout.trim().split('\n');
  if (zipListing.status !== 0 || JSON.stringify(zipNames.sort()) !== JSON.stringify([path.basename(input.archive.path), path.basename(input.acceptance.path)].sort())) throw new Error('Original ZIP layout mismatch');
  for (const ref of [input.archive, input.acceptance]) {
    const extracted = spawnSync('unzip', ['-p', zip, path.basename(ref.path)], { maxBuffer: ref.sizeBytes + 1024 });
    if (extracted.status !== 0 || !extracted.stdout.equals(readFileSync(path.join(input.materialsRoot, ref.path)))) throw new Error('Original ZIP member byte mismatch');
  }
  verifySourceFiles(input.runtimeRoot, [input.manifest]);
  if (input.manifest.path !== 'manifest.json') throw new Error('Original runtime manifest path required');
  const manifest = JSON.parse(readFileSync(path.join(input.runtimeRoot, input.manifest.path), 'utf8'));
  const conformance = loadQleverSourceConformance();
  if (manifest.schemaVersion !== 1 || manifest.adapterAbiVersion !== conformance.adapterAbiVersion || manifest.physicalBackendAbiVersion !== conformance.physicalBackendAbiVersion ||
    manifest.build?.platform !== target.replace(/^darwin-/, 'macos-') || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw new Error('CSS native ABI/target manifest mismatch');
  const files: SourceFile[] = manifest.artifacts.map((row: { path: string; sha256: string; size: number }) => ({ path: row.path, sha256: row.sha256, sizeBytes: row.size }));
  sourceFileIndex(files);
  if (!files.some(file => file.path === 'bin/xpod_qlever_local_runtime') || files.some(file => !/^(?:bin|lib)\/[^/]+$/.test(file.path))) throw new Error('Native runtime layout mismatch');
  if (JSON.stringify(members) !== JSON.stringify(['manifest.json', ...files.map(file => file.path)].sort())) throw new Error('Native runtime has missing or extra members');
  verifySourceFiles(input.runtimeRoot, files);
  for (const file of files) verifyNativeMaterialTarget(readFileSync(path.join(input.runtimeRoot, file.path)), target);
  // Bind the expanded input to original tar bytes without executing or rewriting the manifest.
  const archive = path.join(input.materialsRoot, input.archive.path);
  const listing = spawnSync('tar', ['-tf', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (listing.status !== 0) throw new Error('Cannot inspect original runtime archive');
  const names = listing.stdout.trim().split('\n');
  const verbose = spawnSync('tar', ['-tvf', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const types = verbose.stdout.trim().split('\n').map(line => line[0]);
  if (verbose.status !== 0 || types.length !== names.length || types.some(type => type !== '-' && type !== 'd')) throw new Error('Nonregular original runtime archive member');
  const seen = new Set<string>();
  for (let index = 0; index < names.length; index++) {
    const name = names[index].replace(/^\.\//, '').replace(/\/$/, '');
    if (types[index] === 'd' && (name === '.' || name === '')) continue;
    if (!safeMaterialPath(name) || seen.has(name) || (types[index] === 'd' && !members.some(member => member.startsWith(name + '/')))) throw new Error('Unsafe original runtime archive member');
    seen.add(name);
  }
  const normalized = names.filter(name => !name.endsWith('/')).map(name => name.replace(/^\.\//, ''));
  if (new Set(normalized).size !== normalized.length || JSON.stringify(normalized.sort()) !== JSON.stringify(members)) throw new Error('Original runtime archive layout mismatch');
  for (const file of [input.manifest, ...files]) {
    const name = names.find(member => member.replace(/^\.\//, '') === file.path)!;
    const extracted = spawnSync('tar', ['-xOf', archive, name], { maxBuffer: file.sizeBytes + 1024 });
    if (extracted.status !== 0 || !extracted.stdout.equals(readFileSync(path.join(input.runtimeRoot, file.path)))) throw new Error('Original runtime archive byte mismatch');
  }
  const output = path.join(productRoot, 'native/qlever');
  if (existsSync(output)) throw new Error('Fresh native runtime destination required');
  regularTree(productRoot);
  mkdirSync(output, { recursive: true });
  for (const file of [input.manifest, ...files]) {
    const destination = path.join(output, file.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(input.runtimeRoot, file.path), destination);
    chmodSync(destination, file.path.startsWith('bin/') ? 0o755 : 0o644);
  }
  return [input.manifest, ...files].map(file => ({ ...file, path: 'native/qlever/' + file.path }));
}
