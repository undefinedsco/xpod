import { verifyProducerSourceArchive } from '@undefineds.co/xpod-cli/build-tools';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
interface MaterialFile { path: string; bytes: number; sha256: string }
interface MaterialIndex {
  schemaVersion: number; status: string; producer: { name: string; version: string; bunVersion: string };
  sourceAuthority: { sourceCommit: string | null; dirty: boolean | null; snapshotSHA256: string; scope: string };
  clientPayloads: { cjsSHA256: string; esmSHA256: string }; supplements: string; generatedRoot: string;
  clientMetafile: string; clientSource: string; sourceDirectory: string; sourceInventory: string; files: MaterialFile[];
}
/** Resolve only the public producer-materials index; repository siblings are not authorities. */
export async function resolveProducerMaterials(indexPath: string) {
  const root = path.dirname(realpathSync(indexPath));
  const bytes = readFileSync(indexPath);
  const index = JSON.parse(bytes.toString()) as MaterialIndex;
  if (index.schemaVersion !== 1 || index.status !== 'producer-materials-only' || !Array.isArray(index.files) || !index.files.length) throw new Error('Invalid public CLI producer materials');
  const safe = (relative: string) => {
    if (typeof relative !== 'string' || !relative || /[\x00-\x1f\x7f]/.test(relative) || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe public producer material path');
    return path.join(root, relative);
  };
  for (const field of ['sourceDirectory', 'generatedRoot', 'supplements'] as const) safe(index[field]);
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const validateSnapshot = () => {
    const expected = new Set<string>();
    for (const file of index.files) {
      const filename = safe(file.path);
      if (expected.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256) || !lstatSync(filename).isFile()) throw new Error('Invalid public producer inventory');
      expected.add(file.path); const actual = readFileSync(filename);
      if (actual.length !== file.bytes || hash(actual) !== file.sha256) throw new Error('Public producer material hash mismatch');
    }
    const actual: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const file = path.join(directory, entry); const stat = lstatSync(file);
        if (stat.isSymbolicLink()) throw new Error('Public producer material symlink');
        if (stat.isDirectory()) walk(file);
        else if (stat.isFile()) actual.push(path.relative(root, file).split(path.sep).join('/'));
        else throw new Error('Public producer material nonregular file');
      }
  };
  walk(root);
  const indexRelative = path.relative(root, realpathSync(indexPath)).split(path.sep).join('/');
  if (actual.filter(name => name !== indexRelative).length !== expected.size || actual.some(name => name !== indexRelative && !expected.has(name))) throw new Error('Public producer inventory file set mismatch');
  for (const field of ['clientMetafile', 'clientSource', 'sourceInventory'] as const) if (!expected.has(index[field])) throw new Error('Public producer authority missing');
  const source = JSON.parse(readFileSync(safe(index.sourceInventory), 'utf8')) as { schemaVersion: number; files: MaterialFile[] };
  if (source.schemaVersion !== 1 || !Array.isArray(source.files) || !source.files.length) throw new Error('Invalid public client source inventory');
  const sourceSet = new Set<string>();
  for (const file of source.files) {
    safe(file.path); const relative = index.sourceDirectory + '/' + file.path;
    if (sourceSet.has(relative) || !expected.has(relative)) throw new Error('Public client source authority mismatch');
    sourceSet.add(relative);
    const entry = index.files.find(row => row.path === relative)!;
    if (entry.sha256 !== file.sha256 || entry.bytes !== file.bytes) throw new Error('Public client source inventory hash mismatch');
  }
  if (index.files.filter(file => file.path.startsWith(index.sourceDirectory + '/')).length !== sourceSet.size) throw new Error('Public client source inventory incomplete');
  if (!index.files.some(file => file.path.startsWith(index.supplements + '/')) || !index.files.some(file => file.path.startsWith(index.generatedRoot + '/'))) throw new Error('Public producer notice authority missing');
  const authority = index.sourceAuthority;
  if (!authority || (authority.sourceCommit !== null && !/^[a-f0-9]{40}$/.test(authority.sourceCommit)) || (authority.dirty !== null && typeof authority.dirty !== 'boolean') || typeof authority.scope !== 'string' || !authority.scope || authority.snapshotSHA256 !== hash(Buffer.from(JSON.stringify(source.files)))) throw new Error('Public producer source authority mismatch');
  const clientRoot = path.resolve(root, '../..');
  const clientPackage = JSON.parse(readFileSync(path.join(clientRoot, 'package.json'), 'utf8'));
  if (index.producer?.name !== '@undefineds.co/xpod-cli' || index.producer.name !== clientPackage.name || index.producer.version !== clientPackage.version || typeof index.producer.bunVersion !== 'string' || !/^\d+\.\d+\.\d+/.test(index.producer.bunVersion)) throw new Error('Public producer package authority mismatch');
  for (const [filename, expectedHash] of [['client.cjs', index.clientPayloads?.cjsSHA256], ['client.mjs', index.clientPayloads?.esmSHA256]]) {
    const payload = path.join(clientRoot, 'dist', filename!);
    if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash) || !lstatSync(payload).isFile() || hash(readFileSync(payload)) !== expectedHash) throw new Error('Public producer client payload mismatch');
  }
  };
  validateSnapshot();
  await verifyProducerSourceArchive({ archive: safe(index.clientSource), inventory: safe(index.sourceInventory) });
  validateSnapshot();
  if (!readFileSync(indexPath).equals(bytes)) throw new Error('Public producer index changed during validation');
  return { indexPath, supplements: safe(index.supplements), generatedRoot: safe(index.generatedRoot), clientMetafile: safe(index.clientMetafile), clientSource: safe(index.clientSource), sourceInventory: safe(index.sourceInventory),
    binding: { indexSHA256: hash(bytes), files: index.files.length, clientSourceSHA256: index.files.find(file => file.path === index.clientSource)!.sha256, sourceInventorySHA256: index.files.find(file => file.path === index.sourceInventory)!.sha256, producer: index.producer, clientPayloads: index.clientPayloads, sourceAuthority: index.sourceAuthority } };
}
