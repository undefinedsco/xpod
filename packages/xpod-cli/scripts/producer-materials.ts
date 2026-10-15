import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { verifyProducerSourceArchive } from '../src/producer-source';

/** Bind the actual normal package archive, including Bun's publication manifest rewrite. */
export function collectPublishedRuntimeClient(origin: string, destination: string) {
  mkdirSync(destination, { recursive: true });
  const packed = spawnSync('bun', ['pm', 'pack', '--destination', destination], { cwd: origin, encoding: 'utf8' });
  if (packed.error || packed.status !== 0) throw new Error('Runtime client normal pack failed: ' + (packed.error?.message ?? packed.stderr));
  const archives = readdirSync(destination).filter(name => name.endsWith('.tgz'));
  if (archives.length !== 1) throw new Error('Runtime client publication archive is ambiguous');
  const archive = path.join(destination, archives[0]);
  const listed = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error('Runtime client publication archive cannot be listed');
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const seen = new Set<string>();
  for (const member of listed.stdout.trim().split('\n')) {
    if (member.endsWith('/')) continue;
    const relative = member.replace(/^package\//u, '');
    if (!member.startsWith('package/') || !relative || /[\x00-\x1f\x7f\\]/u.test(relative)
      || relative.split('/').some(part => !part || part === '.' || part === '..') || seen.has(relative)) {
      throw new Error('Runtime client publication member is unsafe');
    }
    seen.add(relative);
    const bytes = spawnSync('tar', ['-xOf', archive, member], { maxBuffer: 16 * 1024 * 1024 });
    if (bytes.status !== 0) throw new Error('Runtime client publication member cannot be read');
    files.push({ path: relative, bytes: bytes.stdout.length, sha256: createHash('sha256').update(bytes.stdout).digest('hex') });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (!files.some(file => file.path === 'package.json')) throw new Error('Runtime client published manifest missing');
  const inventory = path.join(destination, 'published-inventory.json');
  writeFileSync(inventory, JSON.stringify({ schemaVersion: 1, files: files.map(file => ({ ...file, path: 'package/' + file.path })) }, null, 2) + '\n');
  return { archive, inventory, files };
}

/** Public producer inputs travel with the package, never through sibling sources. */
export async function exportProducerMaterials(packageRoot: string, canonicalSources: readonly string[] = []): Promise<void> {
  const root = path.join(packageRoot, 'dist/producer-materials');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(path.join(packageRoot, 'licenses/javascript'), path.join(root, 'javascript'), { recursive: true });
  cpSync(path.join(packageRoot, '.test-data/build/client-inputs.json'), path.join(root, 'client-inputs.json'));
  const earlyManifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const hasOutput = Boolean(earlyManifest.exports?.['./output']);
  if (hasOutput) cpSync(path.join(packageRoot, '.test-data/build/output-inputs.json'), path.join(root, 'output-inputs.json'));
  const source = path.join(root, 'source');
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const visit = (directory: string, origin = packageRoot, prefix = ''): void => {
    for (const name of readdirSync(directory).sort()) {
      if (['node_modules', 'dist', '.test-data', 'build'].includes(name)) continue;
      const file = path.join(directory, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) { visit(file, origin, prefix); continue; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('CLI producer source contains nonregular material');
      const relative = prefix + path.relative(origin, file).split(path.sep).join('/');
      const destination = path.join(source, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(file, destination);
      const bytes = readFileSync(destination);
      files.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  };
  visit(packageRoot);
  const repositoryRoot = path.resolve(packageRoot, '../..');
  const hostSources = canonicalSources.filter(file => {
    const relative = path.relative(repositoryRoot, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.startsWith(`src${path.sep}`)) throw new Error('Unsafe canonical host source');
    return true;
  });
  for (const file of hostSources) {
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('Canonical host source must be regular');
    const relative = 'repository/' + path.relative(repositoryRoot, file).split(path.sep).join('/');
    const destination = path.join(source, relative);
    mkdirSync(path.dirname(destination), { recursive: true }); cpSync(file, destination);
    const bytes = readFileSync(destination);
    files.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  // The declared workspace dependencies identify canonical source mappings; no second dependency registry.
  const packageManifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const workspaceSources: Array<{ name: string; version: string; directory: string; role: string }> = [];
  const runtimeClients: Array<{ name: string; version: string; sourceDirectory: string; publication: { archive: string; inventory: string; sourceManifest: string }; files: Array<{ path: string; bytes: number; sha256: string }> }> = [];
  for (const [name, version] of Object.entries(packageManifest.dependencies ?? {})) {
    if (typeof version !== 'string' || !version.startsWith('workspace:')) continue;
    if (!/^@undefineds\.co\/[a-z0-9-]+$/.test(name)) throw new Error('Invalid workspace source name');
    const dirname = name.split('/')[1];
    const origin = path.resolve(packageRoot, '..', dirname);
    const dependency = JSON.parse(readFileSync(path.join(origin, 'package.json'), 'utf8'));
    if (dependency.name !== name) throw new Error('Canonical workspace source identity mismatch');
    const directory = `workspace/${dirname}`;
    visit(origin, origin, directory + '/');
    workspaceSources.push({ name, version: dependency.version, directory, role: 'declared-runtime-dependency' });
    const published = collectPublishedRuntimeClient(origin, path.join(root, 'runtime-clients', dirname));
    await verifyProducerSourceArchive({ archive: published.archive, inventory: published.inventory });
    runtimeClients.push({ name, version: dependency.version, sourceDirectory: directory,
      publication: { archive: path.relative(root, published.archive).split(path.sep).join('/'),
        inventory: path.relative(root, published.inventory).split(path.sep).join('/'), sourceManifest: directory + '/package.json' },
      files: published.files });
  }
  writeFileSync(path.join(root, 'source-inventory.json'), JSON.stringify({ schemaVersion: 1, files }, null, 2) + '\n');
  const packed = spawnSync('tar', ['-czf', path.join(root, 'client-source.tar.gz'), '-C', source, '.']);
  if (packed.error || packed.status !== 0) throw new Error('CLI producer source archive failed');
  await verifyProducerSourceArchive({ archive: path.join(root, 'client-source.tar.gz'), inventory: path.join(root, 'source-inventory.json') });
  const inventory: Array<{ path: string; bytes: number; sha256: string }> = [];
  const inventoryDirectory = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      if (lstatSync(file).isDirectory()) { inventoryDirectory(file); continue; }
      const bytes = readFileSync(file);
      inventory.push({ path: path.relative(root, file).split(path.sep).join('/'), bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  };
  inventoryDirectory(root);
  const producer = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' });
  const state = spawnSync('git', ['status', '--porcelain', '--', '.', ...hostSources, ...workspaceSources.map(source => '../' + source.directory.split('/')[1])], { cwd: packageRoot, encoding: 'utf8' });
  // A copied producer under an ignored test directory must not inherit its
  // ancestor repository's commit or appear clean merely because it is ignored.
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', 'package.json', 'src/client.ts', ...hostSources, ...workspaceSources.flatMap(source => ['../' + source.directory.split('/')[1] + '/package.json', '../' + source.directory.split('/')[1] + '/src/index.ts'])],
    { cwd: packageRoot, encoding: 'utf8' });
  const sourceCommit = tracked.status === 0 && commit.status === 0 && /^[a-f0-9]{40}$/.test(commit.stdout.trim()) ? commit.stdout.trim() : null;
  const payload = (filename: string): string => createHash('sha256').update(readFileSync(path.join(packageRoot, 'dist', filename))).digest('hex');
  writeFileSync(path.join(root, 'index.json'), JSON.stringify({ schemaVersion: 1,
    status: 'producer-materials-only',
    producer: { name: producer.name, version: producer.version, bunVersion: process.versions.bun ?? null },
    workspaceSources, runtimeClients,
    sourceAuthority: { sourceCommit, dirty: sourceCommit && state.status === 0 ? Boolean(state.stdout.trim()) : null,
      snapshotSHA256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
      scope: 'CLI source plus explicitly mapped canonical host and runtime-client source; no claim of release acceptance or external dependency closure.' },
    clientPayloads: { cjsSHA256: payload('client.cjs'), esmSHA256: payload('client.mjs') },
    ...(hasOutput ? { outputMetafile: 'output-inputs.json', outputPayloads: { esmSHA256: payload('output.mjs') } } : {}),
    supplements: 'javascript', generatedRoot: 'javascript/generated', clientMetafile: 'client-inputs.json',
    clientSource: 'client-source.tar.gz', sourceDirectory: 'source', sourceInventory: 'source-inventory.json',
    files: inventory }, null, 2) + '\n');
}
