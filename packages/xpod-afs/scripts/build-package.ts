import { buildObserver } from './build-observation';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProducerMaterials } from './producer-materials';
import { resolveProducerInput, resolveRuntimeClientInput } from './producer-input';
import { collectAfsJavascriptMaterials, copyAfsSourceKit } from './javascript-materials';
import { afsLibraryBuildArgs, buildAfsClient } from './build-client';
import { withStagedProducerInput } from './staged-producer-input';

const originalProducerInput = resolveProducerInput(process.argv.slice(2));
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '../..');
const clientPackageRoot = resolveRuntimeClientInput(process.argv.slice(2));
await withStagedProducerInput(originalProducerInput, path.join(packageRoot, '.test-data'), async producerInput => {
  // Never consume a previous client build's compiler graph: its producer scope
  // has already closed. Compile and package under this one verified lifetime.
  const clientBuild = await buildObserver.phase('module-fresh-client', () => buildAfsClient(producerInput, clientPackageRoot));
  const producer = await buildObserver.phase('module-materials', () => resolveProducerMaterials(producerInput.indexPath, clientPackageRoot, producerInput.tools));
  const publicInputs = producer.clientMetafile;
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
  async function checked(phase: string, command: string, args: string[], cwd = repoRoot): Promise<void> {
    const result = await buildObserver.command(phase, command, args, cwd);
    if (result.error || result.status !== 0) { throw new Error('AFS build stage failed'); }
  }
  await checked('module-native-material', 'python3', [path.join(packageRoot, 'scripts/native-material.py'), repoRoot, path.resolve(option('--native-evidence')), path.resolve(option('--native-pins')), target, stage]);
  mkdirSync(path.join(stage, 'dist'), { recursive: true });
  cpSync(path.join(packageRoot, 'dist'), path.join(stage, 'dist'), { recursive: true });
  cpSync(path.join(packageRoot, 'src'), path.join(stage, 'src'), { recursive: true });
  const metadata = path.join(output, 'bundle-inputs.json');
  await checked('module-library-bundle', 'bun', ['build', ...afsLibraryBuildArgs, `--metafile=${metadata}`, '--outfile', path.join(stage, 'dist/library.cjs'), path.join(packageRoot, 'dist/library-source.ts')], packageRoot);
  copyFileSync(path.join(packageRoot, 'dist/entry.mjs'), path.join(stage, 'dist/entry.mjs'));
  // A single declaration drives each staged vendor copy and notice collection.
  const clientVendor = { sourceRoot: clientPackageRoot,
    files: ['dist', 'package.json', 'LICENSE', 'README.md'],
    preserveManifestAt: 'provenance/runtime-client-package-source.json' };
  const vendoredPackages: Array<{ sourceRoot: string; files?: string[]; preserveManifestAt?: string; stageRoot?: string }> = [
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
    } else { cpSync(vendor.sourceRoot, vendor.stageRoot, { recursive: true, dereference: true }); }
    if (vendor.preserveManifestAt) { copyFileSync(path.join(vendor.sourceRoot, 'package.json'), path.join(stage, vendor.preserveManifestAt)); }
  }
  const client = vendoredPackages[0].stageRoot!;
  const runtimeClient = JSON.parse(readFileSync(path.join(client, 'package.json'), 'utf8'));
  for (const entry of Object.values(runtimeClient.exports) as Array<Record<string, string>>) {
    for (const file of Object.values(entry)) {
      if (!file.startsWith('./dist/') || !existsSync(path.join(client, file))) throw new Error('Runtime client export payload missing');
    }
  }
  for (const entry of producer.runtimeClient!.files) {
    const file = path.join(client, entry.path); const bytes = readFileSync(file);
    if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('Copied runtime client payload is not snapshot-bound');
  }
  copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(stage, 'LICENSE'));
  writeFileSync(path.join(stage, 'LICENSES.txt'), 'This artifact contains materials with separate licenses.\nXpod-owned source: MIT, original terms in LICENSE.\nThe assembled AgentFS native helper has no asserted aggregate SPDX license here; consult the preserved native collection/declarations and AgentFS notices under licenses/native and licenses/agentfs.\nThe public CLI client and vendored drizzle-orm retain their original notices and source provenance.\nPackaging or hash verification does not grant artifact review clearance.\n');
  const inputs = Object.keys(JSON.parse(readFileSync(metadata, 'utf8')).inputs) as string[];
  if (inputs.some(p => /(?:@solid\/community-server|src\/(?:api|storage)|inngest)/.test(p))) { throw new Error('AFS bundle contains service inputs'); }
  await buildObserver.phase('module-notices', () => collectAfsJavascriptMaterials({ buildTools: producerInput.tools, packageRoot, repoRoot, destination: path.join(stage, 'licenses/javascript-afs'), target,
    library: path.join(stage, 'dist/library.cjs'), libraryMetafile: metadata,
    commands: path.join(stage, 'dist/command-host.mjs'), commandsMetafile: clientBuild.physicalCommandMetafile, commandInputPaths: clientBuild.commandInputPaths,
    producer, vendoredRoots: vendoredPackages.map(vendor => vendor.stageRoot!) }));
  const sourceFiles = [...inputs.filter(p => !p.includes('node_modules/')).map(p => path.relative(repoRoot, path.resolve(packageRoot, p))), 'package.json', 'bun.lock', '.componentsjs-generator-config.json', 'config/components-ignore.json', 'scripts/check-afs-package.cjs'];
  const commandInputs = Object.keys(JSON.parse(readFileSync(path.join(packageRoot, 'dist/commands-inputs.json'), 'utf8')).inputs) as string[];
  sourceFiles.push(...commandInputs.filter(filename => !filename.includes('node_modules/')));
  clientBuild.assertCurrent();
  function sourceTree(directory: string): void {
    for (const name of readdirSync(directory).sort()) {
      if (['node_modules', 'dist', '.test-data', 'build'].includes(name)) { continue; }
      const file = path.join(directory, name); const stat = lstatSync(file);
      if (stat.isDirectory()) { sourceTree(file); }
      else if (stat.isFile()) { sourceFiles.push(path.relative(repoRoot, file)); }
      else { throw new Error('Source kit contains a nonregular input'); }
    }
  }
  sourceTree(packageRoot); sourceTree(path.join(repoRoot, 'types/bun'));
  // These are actual source inputs of native-material.py, not proof that the
  // delivered directory supplies a genuine Git object authority by itself.
  sourceTree(path.join(repoRoot, 'tools/agentfs-pod'));
  for (const name of ['accept.py', 'supervise.py']) sourceFiles.push('scripts/agentfs-native-ci/' + name);
  mkdirSync(path.join(stage, 'sources'), { recursive: true });
  copyFileSync(producer.clientSource, path.join(stage, 'sources/cli-client-source.tar.gz'));
  copyFileSync(producer.sourceInventory, path.join(stage, 'provenance/cli-client-source-inventory.json'));
  copyFileSync(producer.indexPath, path.join(stage, 'provenance/cli-producer-materials.json'));
  copyFileSync(publicInputs, path.join(stage, 'provenance/cli-client-inputs.json'));
  copyFileSync(producer.outputMetafile!, path.join(stage, 'provenance/cli-output-inputs.json'));
  copyFileSync(path.join(packageRoot, 'dist/commands-inputs.json'), path.join(stage, 'provenance/afs-commands-inputs.json'));
  const copiedBindings: Array<[string, string]> = [
    ['sources/cli-client-source.tar.gz', producer.binding.clientSourceSHA256],
    ['provenance/cli-client-source-inventory.json', producer.binding.sourceInventorySHA256],
    ['provenance/cli-producer-materials.json', producer.binding.indexSHA256],
  ];
  for (const [relative, expected] of copiedBindings) {
    if (createHash('sha256').update(readFileSync(path.join(stage, relative))).digest('hex') !== expected) throw new Error('Copied public producer payload is not snapshot-bound');
  }
  const sourceRoot = path.join(output, 'module-source');
  const sourceInventory = copyAfsSourceKit({ repoRoot, destination: sourceRoot, sourceFiles, commandBuild: clientBuild });
  const sourceTreeDigest = createHash('sha256').update(JSON.stringify(sourceInventory)).digest('hex');
  const nativeFacts = JSON.parse(readFileSync(path.join(stage, 'provenance/native-reuse.json'), 'utf8'));
  nativeFacts.moduleSourceTreeSHA256 = sourceTreeDigest;
  writeFileSync(path.join(stage, 'provenance/native-reuse.json'), JSON.stringify(nativeFacts, null, 2) + '\n');
  writeFileSync(path.join(stage, 'provenance/module-source-kit.json'), JSON.stringify({ schemaVersion: 1,
    baseCommit: nativeFacts.baseCommit, dirty: nativeFacts.moduleSourceDirty, moduleSourceSHA: nativeFacts.moduleSourceSHA,
    moduleSourceTreeSHA256: sourceTreeDigest, files: sourceInventory,
    publicClientPayloadSHA256: createHash('sha256').update(readFileSync(path.join(client, 'dist/library.cjs'))).digest('hex'),
    publicClientMetafileSHA256: createHash('sha256').update(readFileSync(publicInputs)).digest('hex'),
    publicClientMaterials: producer.binding }, null, 2) + '\n');
  mkdirSync(path.join(stage, 'sources'), { recursive: true });
  await checked('module-source-archive', 'tar', ['-czf', path.join(stage, 'sources/module-source.tar.gz'), '-C', sourceRoot, '.']);
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
  if (JSON.stringify((await resolveProducerMaterials(producer.indexPath, clientPackageRoot, producerInput.tools)).binding) !== JSON.stringify(producer.binding)) throw new Error('Public producer authority changed during packaging');
  inventory(stage);
  const version = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
  const manifest = { name: `@undefineds.co/xpod-afs-${target}`, version, type: 'module', license: 'SEE LICENSE IN LICENSES.txt',
    exports: JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).exports,
    main: './dist/index.cjs', types: './dist/types/index.d.ts',
    typesVersions: JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).typesVersions,
    engines: { node: '>=22.13' }, xpodModule: { schemaVersion: 1, id: 'afs', cliApiVersion: 1, platform, arch, entry: 'dist/entry.mjs', files } };
  writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const archive = path.join(output, `xpod-afs-${version}-${target}.tgz`);
  await checked('module-package-archive', 'tar', ['-czf', archive, '-C', output, 'package']);
  const bytes = readFileSync(archive);
  writeFileSync(path.join(output, 'build.safe.json'), JSON.stringify({ archive, target, version, inventoryFiles: files.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    native: JSON.parse(readFileSync(path.join(stage, 'provenance/native-reuse.json'), 'utf8')) }, null, 2) + '\n');
  console.log(JSON.stringify({ archive, target, inventoryFiles: files.length }));

  producerInput.assertCurrent();
});
