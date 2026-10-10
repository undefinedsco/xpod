import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectJavascriptNotices } from '../../xpod-cli/src/javascript-notices';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '../..');
const args = process.argv.slice(2);
function option(name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) { throw new Error(`Required ${name}`); }
  return args[index + 1];
}
const target = option('--target');
if (!/^(darwin|linux)-(arm64|x64)$/.test(target)) { throw new Error('Unsupported AFS target'); }
const [platform, arch] = target.split('-');
const output = path.resolve(option('--out'));
const stage = path.join(output, 'package');
if (existsSync(stage)) { throw new Error('Output already exists'); }
mkdirSync(stage, { recursive: true });
function checked(command: string, args: string[], cwd = repoRoot): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error || result.status !== 0) { throw new Error('AFS build stage failed'); }
}
checked('python3', [path.join(packageRoot, 'scripts/native-material.py'), repoRoot, path.resolve(option('--native-evidence')), path.resolve(option('--native-pins')), target, stage]);
mkdirSync(path.join(stage, 'dist'), { recursive: true });
cpSync(path.join(packageRoot, 'dist'), path.join(stage, 'dist'), { recursive: true });
cpSync(path.join(packageRoot, 'src'), path.join(stage, 'src'), { recursive: true });
const metadata = path.join(output, 'bundle-inputs.json');
checked('bun', ['build', '--target=node', '--format=cjs', '--external=@undefineds.co/xpod-cli/client', '--external=drizzle-orm', '--external=bun:sqlite', `--metafile=${metadata}`, '--outfile', path.join(stage, 'dist/library.cjs'), path.join(packageRoot, 'dist/library-source.ts')], packageRoot);
copyFileSync(path.join(packageRoot, 'dist/entry.mjs'), path.join(stage, 'dist/entry.mjs'));
// A single declaration drives each staged vendor copy and notice collection.
const clientVendor = { sourceRoot: path.join(repoRoot, 'packages/xpod-cli'),
  files: ['dist/client.cjs', 'dist/client.mjs', 'dist/client-types', 'dist/licenses/client', 'LICENSE'],
  manifestFields: ['name', 'version', 'type', 'license', 'engines', 'exports', 'typesVersions'],
  preserveManifestAt: 'provenance/cli-client-package-source.json' };
const vendoredPackages: Array<{ sourceRoot: string; files?: string[]; manifestFields?: string[]; preserveManifestAt?: string; stageRoot?: string }> = [
  clientVendor, { sourceRoot: path.join(repoRoot, 'node_modules/drizzle-orm') },
];
for (const vendor of vendoredPackages) {
  const original = JSON.parse(readFileSync(path.join(vendor.sourceRoot, 'package.json'), 'utf8'));
  if (typeof original.name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(original.name)) { throw new Error('Invalid vendored package name'); }
  vendor.stageRoot = path.join(stage, 'node_modules', original.name);
  if (vendor.files) {
    mkdirSync(vendor.stageRoot, { recursive: true });
    for (const file of vendor.files) {
      const destination = path.join(vendor.stageRoot, file); mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(path.join(vendor.sourceRoot, file), destination, { recursive: true, dereference: false });
    }
    writeFileSync(path.join(vendor.stageRoot, 'package.json'), JSON.stringify(Object.fromEntries(vendor.manifestFields!.map(field => [field, original[field]])), null, 2) + '\n');
  } else { cpSync(vendor.sourceRoot, vendor.stageRoot, { recursive: true, dereference: true }); }
  if (vendor.preserveManifestAt) { copyFileSync(path.join(vendor.sourceRoot, 'package.json'), path.join(stage, vendor.preserveManifestAt)); }
}
const client = vendoredPackages[0].stageRoot!;
copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(stage, 'LICENSE'));
writeFileSync(path.join(stage, 'LICENSES.txt'), 'This artifact contains materials with separate licenses.\nXpod-owned source: MIT, original terms in LICENSE.\nThe assembled AgentFS native helper has no asserted aggregate SPDX license here; consult the preserved native collection/declarations and AgentFS notices under licenses/native and licenses/agentfs.\nThe public CLI client and vendored drizzle-orm retain their original notices and source provenance.\nPackaging or hash verification does not grant artifact review clearance.\n');
const inputs = Object.keys(JSON.parse(readFileSync(metadata, 'utf8')).inputs) as string[];
if (inputs.some(p => /(?:@solid\/community-server|src\/(?:api|storage)|inngest)/.test(p))) { throw new Error('AFS bundle contains service inputs'); }
// AFS CJS uses the reviewed client helpers without the unused __commonJS
// wrapper. Compare the entire emitted prefix with that exact derivation.
const originalGenerated = path.join(repoRoot, 'packages/xpod-cli/licenses/javascript/generated', process.versions.bun ?? 'unknown');
const profile = JSON.parse(readFileSync(path.join(originalGenerated, 'client.json'), 'utf8'));
const basePrefix = readFileSync(path.join(originalGenerated, profile.file.object), 'utf8');
if (createHash('sha256').update(basePrefix).digest('hex') !== profile.file.sha256) { throw new Error('Client helper source hash mismatch'); }
const expectedPrefix = basePrefix.replace('var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);\n', '');
const payload = readFileSync(path.join(stage, 'dist/library.cjs'));
const actualPrefix = payload.subarray(0, payload.indexOf('\n// '));
if (!actualPrefix.equals(Buffer.from(expectedPrefix)) && !actualPrefix.equals(Buffer.from(basePrefix))) { throw new Error('AFS generated runtime differs from reviewed client helpers'); }
const generated = path.join(output, 'generated-provenance');
cpSync(originalGenerated, generated, { recursive: true });
const prefixHash = createHash('sha256').update(actualPrefix).digest('hex');
writeFileSync(path.join(generated, 'objects', `${prefixHash}.txt`), actualPrefix);
const generatedIndex = JSON.parse(readFileSync(path.join(generated, 'index.json'), 'utf8'));
generatedIndex.prefixSha256 = prefixHash; generatedIndex.prefixBytes = actualPrefix.length;
generatedIndex.provenance = { original: generatedIndex.provenance, clientProfile: profile.provenance,
  derivation: actualPrefix.equals(Buffer.from(basePrefix)) ? 'Exact reviewed CJS client prefix; full emitted bytes compared.' : 'Exact reviewed CJS client prefix minus the unused __commonJS wrapper declaration; full emitted bytes compared.' };
generatedIndex.files = [...generatedIndex.files.filter((file: { sourcePath: string }) => file.sourcePath !== 'generated-prefix.js'),
  { sourcePath: 'generated-prefix.js', object: `objects/${prefixHash}.txt`, sha256: prefixHash }];
writeFileSync(path.join(generated, 'index.json'), JSON.stringify(generatedIndex, null, 2) + '\n');
collectJavascriptNotices({ metafile: metadata, stageRoot: packageRoot, repoRoot,
  destination: path.join(stage, 'licenses/javascript-afs'), target,
  cli: path.join(stage, 'dist/library.cjs'), bunVersion: process.versions.bun ?? 'unknown',
  supplements: [path.join(repoRoot, 'packages/xpod-cli/licenses/javascript'), path.join(packageRoot, 'licenses/javascript')],
  vendoredRoots: vendoredPackages.map(vendor => vendor.stageRoot!), requireVendoredOriginals: true,
  generated });
const sourceFiles = [...inputs.filter(p => !p.includes('node_modules/')).map(p => path.relative(repoRoot, path.resolve(packageRoot, p))), 'package.json', 'bun.lock', '.componentsjs-generator-config.json', 'config/components-ignore.json'];
function sourceTree(directory: string): void {
  for (const name of readdirSync(directory).sort()) {
    if (['node_modules', 'dist', '.test-data', 'build'].includes(name)) { continue; }
    const file = path.join(directory, name); const stat = lstatSync(file);
    if (stat.isDirectory()) { sourceTree(file); }
    else if (stat.isFile()) { sourceFiles.push(path.relative(repoRoot, file)); }
    else { throw new Error('Source kit contains a nonregular input'); }
  }
}
sourceTree(packageRoot); sourceTree(path.join(repoRoot, 'packages/xpod-cli'));
const publicInputs = path.join(repoRoot, 'packages/xpod-cli/.test-data/build/client-inputs.json');
sourceFiles.push(path.relative(repoRoot, publicInputs));
const sourceRoot = path.join(output, 'module-source');
for (const name of new Set(sourceFiles)) {
  if (name.startsWith('..') || path.isAbsolute(name)) { throw new Error('Source outside repository'); }
  const dest = path.join(sourceRoot, name); mkdirSync(path.dirname(dest), { recursive: true }); copyFileSync(path.join(repoRoot, name), dest);
}
const sourceInventory = [...new Set(sourceFiles)].sort().map(name => {
  const bytes = readFileSync(path.join(repoRoot, name));
  return { path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
});
const sourceTreeDigest = createHash('sha256').update(JSON.stringify(sourceInventory)).digest('hex');
const nativeFacts = JSON.parse(readFileSync(path.join(stage, 'provenance/native-reuse.json'), 'utf8'));
nativeFacts.moduleSourceTreeSHA256 = sourceTreeDigest;
writeFileSync(path.join(stage, 'provenance/native-reuse.json'), JSON.stringify(nativeFacts, null, 2) + '\n');
writeFileSync(path.join(stage, 'provenance/module-source-kit.json'), JSON.stringify({ schemaVersion: 1,
  baseCommit: nativeFacts.baseCommit, dirty: nativeFacts.moduleSourceDirty, moduleSourceSHA: nativeFacts.moduleSourceSHA,
  moduleSourceTreeSHA256: sourceTreeDigest, files: sourceInventory,
  publicClientPayloadSHA256: createHash('sha256').update(readFileSync(path.join(client, 'dist/client.cjs'))).digest('hex'),
  publicClientMetafileSHA256: createHash('sha256').update(readFileSync(publicInputs)).digest('hex') }, null, 2) + '\n');
mkdirSync(path.join(stage, 'sources'), { recursive: true });
checked('tar', ['-czf', path.join(stage, 'sources/module-source.tar.gz'), '-C', sourceRoot, '.']);
const files: Array<{ path: string; sha256: string; size: number; mode: number }> = [];
function inventory(directory: string): void {
  for (const name of readdirSync(directory).sort()) {
    const file = path.join(directory, name); const stat = lstatSync(file);
    if (stat.isDirectory()) { inventory(file); continue; }
    if (!stat.isFile() || stat.isSymbolicLink()) { throw new Error('Module contains a nonregular file'); }
    const relative = path.relative(stage, file).split(path.sep).join('/');
    const mode = relative === 'helper/agentfs-pod' ? 0o755 : 0o644;
    chmodSync(file, mode); const bytes = readFileSync(file);
    files.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mode });
  }
}
inventory(stage);
const version = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
const manifest = { name: `@undefineds.co/xpod-afs-${target}`, version, type: 'module', license: 'SEE LICENSE IN LICENSES.txt',
  exports: JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).exports,
  main: './dist/index.cjs', types: './dist/types/index.d.ts',
  typesVersions: JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).typesVersions,
  engines: { node: '>=22.13' }, xpodModule: { schemaVersion: 1, id: 'afs', cliApiVersion: 1, platform, arch, entry: 'dist/entry.mjs', files } };
writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
const archive = path.join(output, `xpod-afs-${version}-${target}.tgz`);
checked('tar', ['-czf', archive, '-C', output, 'package']);
const bytes = readFileSync(archive);
writeFileSync(path.join(output, 'build.safe.json'), JSON.stringify({ archive, target, version, inventoryFiles: files.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  native: JSON.parse(readFileSync(path.join(stage, 'provenance/native-reuse.json'), 'utf8')) }, null, 2) + '\n');
console.log(JSON.stringify({ archive, target, inventoryFiles: files.length }));
