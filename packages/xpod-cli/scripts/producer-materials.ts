import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { verifyProducerSourceArchive } from '../src/producer-source';

/** Public producer inputs travel with the package, never through sibling sources. */
export async function exportProducerMaterials(packageRoot: string): Promise<void> {
  const root = path.join(packageRoot, 'dist/producer-materials');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(path.join(packageRoot, 'licenses/javascript'), path.join(root, 'javascript'), { recursive: true });
  cpSync(path.join(packageRoot, '.test-data/build/client-inputs.json'), path.join(root, 'client-inputs.json'));
  const source = path.join(root, 'source');
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (['node_modules', 'dist', '.test-data', 'build'].includes(name)) continue;
      const file = path.join(directory, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) { visit(file); continue; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('CLI producer source contains nonregular material');
      const relative = path.relative(packageRoot, file).split(path.sep).join('/');
      const destination = path.join(source, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(file, destination);
      const bytes = readFileSync(destination);
      files.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  };
  visit(packageRoot);
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
  const state = spawnSync('git', ['status', '--porcelain', '--', '.'], { cwd: packageRoot, encoding: 'utf8' });
  // A copied producer under an ignored test directory must not inherit its
  // ancestor repository's commit or appear clean merely because it is ignored.
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', 'package.json', 'src/client.ts'],
    { cwd: packageRoot, encoding: 'utf8' });
  const sourceCommit = tracked.status === 0 && commit.status === 0 && /^[a-f0-9]{40}$/.test(commit.stdout.trim()) ? commit.stdout.trim() : null;
  const payload = (filename: string): string => createHash('sha256').update(readFileSync(path.join(packageRoot, 'dist', filename))).digest('hex');
  writeFileSync(path.join(root, 'index.json'), JSON.stringify({ schemaVersion: 1,
    status: 'producer-materials-only',
    producer: { name: producer.name, version: producer.version, bunVersion: process.versions.bun ?? null },
    sourceAuthority: { sourceCommit, dirty: sourceCommit && state.status === 0 ? Boolean(state.stdout.trim()) : null,
      snapshotSHA256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
      scope: 'Package source snapshot only; no claim of release acceptance or dependency closure.' },
    clientPayloads: { cjsSHA256: payload('client.cjs'), esmSHA256: payload('client.mjs') },
    supplements: 'javascript', generatedRoot: 'javascript/generated', clientMetafile: 'client-inputs.json',
    clientSource: 'client-source.tar.gz', sourceDirectory: 'source', sourceInventory: 'source-inventory.json',
    files: inventory }, null, 2) + '\n');
}
