import { openSync, closeSync, fstatSync, lstatSync, readSync, readdirSync, constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MODULE_CATALOG, modulePackageName } from '../../../packages/xpod-cli/src/module-catalog';
import { productConsumerOriginalLimits } from './product-consumer-limits';
import { afsConsumerOriginalSelection } from './afs-consumer-originals';
import { afsConsumerRegisteredShards } from './afs-consumer-shard-registration';
import { afsConsumerBudget } from '../afs-consumer-budget';
import { isDeepStrictEqual } from 'node:util';
import type { CollectedArtifactIdentity, CollectedArtifactMember } from './artifact-contract';
const fail = (message: string): never => { throw Error('Product consumer original inventory: ' + message); };
const safe = (name: string) => name.length > 0 && !name.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(name)
  && name.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const same = (a: BigIntStats, b: BigIntStats) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key as keyof BigIntStats] === b[key as keyof BigIntStats]);
const ordinary = (stat: BigIntStats) => stat.isFile() && stat.nlink === 1n;
/** A product identifier selects policy; a caller approval flag cannot raise it. */
export function consumerOriginalModule(product: Pick<CollectedArtifactIdentity, 'package' | 'target'>) {
  if (product.target === undefined) {
    if (product.package === '@undefineds.co/xpod-client') return 'client' as const;
    if (product.package === '@undefineds.co/xpod-cli') return 'cli' as const;
  } else if (/^(?:linux|darwin)-(?:x64|arm64)$/u.test(product.target)) {
    const [platform, arch] = product.target.split('-');
    for (const module of MODULE_CATALOG) if (modulePackageName(module.id, platform, arch) === product.package) return module.id;
  }
  return fail('canonical actual product module required');
}
/** No following links, no whole-file Buffer for hashing. The same descriptor,
 * byte count and path identity are checked before and after the64KiB scan. */
export function scanProductConsumerOriginal(file: string, maximum: number, capture = false, deadline = Number.POSITIVE_INFINITY) {
  if (Date.now() > deadline) return fail('original scan deadline exhausted');
  const pathBefore = lstatSync(file, { bigint: true });
  if (!ordinary(pathBefore) || pathBefore.isSymbolicLink() || pathBefore.size > BigInt(maximum)) return fail('bounded ordinary original required');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!ordinary(before) || !same(before, pathBefore)) return fail('original identity changed before scan');
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(64 * 1024), parts: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null); if (!count) break;
      if (Date.now() > deadline) return fail('original scan deadline exhausted');
      bytes += count; if (bytes > maximum || BigInt(bytes) > before.size) return fail('original grew during scan');
      hash.update(chunk.subarray(0, count)); if (capture) parts.push(Buffer.from(chunk.subarray(0, count)));
    }
    const after = fstatSync(fd, { bigint: true }), pathAfter = lstatSync(file, { bigint: true });
    if (BigInt(bytes) !== before.size || !same(before, after) || !same(after, pathAfter)) return fail('original identity changed during scan');
    return { bytes, sha256: hash.digest('hex'), mode: Number(before.mode & 0o777n), body: capture ? Buffer.concat(parts) : undefined };
  } finally { closeSync(fd); }
}
export function collectProductConsumerOriginalInventory(output: string, product: CollectedArtifactIdentity, stage: 'prepublish' | 'postpublish' = 'prepublish') {
  const module = consumerOriginalModule(product), limits = productConsumerOriginalLimits(module);
  // Both fields belong to the shared authority, not an exporter-local table.
  const policy = limits;
  if (!Number.isSafeInteger(policy.smallMemberBytes) || !Number.isSafeInteger(policy.originalMembers))
    return fail('shared small-original and original-count policy required');
  const small = policy.smallMemberBytes!, countLimit = policy.originalMembers!;
  if (module === 'afs') return collectAfsPublicOriginalInventory(output, product, stage);
  const root = path.resolve(output), rootStat = lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return fail('owned ordinary original root required');
  const files: { relative: string; file: string; stat: BigIntStats; maximum: number }[] = [];
  const directories: { file: string; stat: BigIntStats }[] = [];
  let total = 0;
  const walk = (directory: string, depth: number): void => {
    if (depth > 64) return fail('original directory depth bound');
    const before = lstatSync(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) return fail('ordinary original directory required');
    directories.push({ file: directory, stat: before });
    for (const name of readdirSync(directory).sort()) {
      if (name === '.private-originals') continue; // Never inspect or descend private source originals.
      const file = path.join(directory, name), relative = path.relative(root, file).split(path.sep).join('/');
      if (!safe(relative)) return fail('unsafe original inventory path');
      const stat = lstatSync(file, { bigint: true });
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return fail('regular original member required');
      if (stat.isDirectory()) { walk(file, depth + 1); continue; }
      if (!ordinary(stat) || ['registry-consumer.manifest.json', 'archive-consumer.manifest.json'].includes(name)) return fail('fresh ordinary original inventory required');
      const maximum = small;
      if (stat.size > BigInt(maximum) || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) return fail('unregistered or oversized original member');
      total += Number(stat.size);
      if (total > limits.originalBytes || files.length >= countLimit) return fail('complete original inventory budget exceeded');
      files.push({ relative, file, stat, maximum });
    }
  };
  walk(root, 0);
  const originals: CollectedArtifactMember[] = [];
  for (const row of files) {
    if (!same(row.stat, lstatSync(row.file, { bigint: true }))) return fail('original changed after inventory planning');
    const observed = scanProductConsumerOriginal(row.file, row.maximum);
    originals.push({ path: row.relative, bytes: observed.bytes, sha256: observed.sha256, mode: observed.mode });
  }
  for (const directory of directories) if (!same(directory.stat, lstatSync(directory.file, { bigint: true }))) return fail('original directory changed during inventory scan');
  return Object.freeze({ module, originals: Object.freeze(originals), totalBytes: total, manifestBytes: limits.manifestBytes });
}


/** The central observer already published only its checked same-filesystem
 * selection. This parent rechecks that data-only frame and every actual byte;
 * it neither visits the private sibling nor chooses AFS scene roles itself. */
function collectAfsPublicOriginalInventory(output: string, product: CollectedArtifactIdentity, stage: 'prepublish' | 'postpublish') {
  const limits = productConsumerOriginalLimits('afs'), root = path.resolve(output);
  const deadline = Date.now() + afsConsumerBudget(stage).safeExportSeconds * 1000;
  const hintName = 'consumer-public-original-selection.json';
  for (let current = root;; current = path.dirname(current)) {
    const stat = lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) return fail('ordinary public original ancestor required');
    if (path.dirname(current) === current) break;
  }
  const fileFor = (name: string): string => {
    if (!safe(name) || name.split('/').some(part => part.startsWith('.'))) return fail('registered public original path required');
    let current = root;
    for (const part of name.split('/').slice(0, -1)) { current = path.join(current, part); const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return fail('linked public original ancestor'); }
    return path.join(root, name);
  };
  const read = (name: string, maximum: number): Buffer => {
    if (!safe(name) || name.split('/').some(part => part.startsWith('.')) || maximum > limits.smallMemberBytes)
      return fail('registered small public original required');
    return scanProductConsumerOriginal(fileFor(name), maximum, true, deadline).body!;
  };
  const hintBytes = read(hintName, limits.manifestBytes), hint = JSON.parse(hintBytes.toString());
  if (hint.schemaVersion !== 1 || hint.kind !== 'fixed-afs-consumer-public-original-selection'
    || hint.sourceSha !== product.sourceSha || hint.target !== product.target || !Array.isArray(hint.files)
    || !hint.files.length || hint.files.length > limits.originalMembers) return fail('fixed Source-owned AFS public projection required');
  const refs = new Map<string, CollectedArtifactMember & { role: string }>();
  for (const row of hint.files) {
    if (!row || !safe(row.path) || row.path.split('/').some((part: string) => part.startsWith('.')) || refs.has(row.path)
      || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[a-f0-9]{64}$/u.test(row.sha256)
      || !Number.isInteger(row.mode) || row.mode < 0 || row.mode > 0o777 || typeof row.role !== 'string') return fail('fixed unique public original reference required');
    refs.set(row.path, row);
  }
  const selection = afsConsumerOriginalSelection({ target: product.target!, originals: [...refs.values()], readOriginal: read });
  if (selection.pending.length) return fail('Source public selection pending: ' + selection.pending.join('; '));
  const selected = new Map(selection.files.map(row => [row.path, row]));
  for (const row of refs.values()) {
    const actual = selected.get(row.path);
    if (actual ? !isDeepStrictEqual(actual, row) : row.role !== 'central-owned-supervisor'
      || !/^central-supervision\/[a-z0-9-]+\.(?:receipt\.json|stdout\.raw\.log|stderr\.raw\.log)$/u.test(row.path))
      return fail('public original is outside Source selection and central-owned supervision');
  }
  const shards = afsConsumerRegisteredShards({ sourceSha: product.sourceSha, result: JSON.parse(read('result.json', limits.smallMemberBytes).toString()),
    originals: refs, read });
  const expected = new Map<string, CollectedArtifactMember>();
  for (const [name, ref] of refs) {
    if (ref.role === 'verifier-tool-archive' ? !shards.has(name) : ref.bytes > limits.smallMemberBytes)
      return fail('only registered verifier-tool shards may use the large member window');
    if (ref.bytes > (shards.has(name) ? limits.memberBytes : limits.smallMemberBytes)) return fail('public original size window exceeded');
    expected.set(name, ref);
  }
  // These small frames belong to the central observer and fixed parent, rather
  // than the AFS scene selector. Recheck their bytes with the full inventory.
  const parentNames = [hintName, 'consumer-observation.json', 'consumer-product-binding.json', ...['receipt.json', 'stdout.raw.log', 'stderr.raw.log']
    .map(suffix => 'producer-supervision/registry-consumer.' + suffix)];
  for (const name of parentNames) {
    if (expected.has(name)) return fail('parent original collides with consumer selection');
    const observed = scanProductConsumerOriginal(fileFor(name), name === hintName ? limits.manifestBytes : limits.smallMemberBytes, false, deadline);
    expected.set(name, { path: name, bytes: observed.bytes, sha256: observed.sha256, mode: observed.mode });
  }
  const binding = JSON.parse(read('consumer-product-binding.json', limits.smallMemberBytes).toString());
  if (!isDeepStrictEqual(binding.product, product)) return fail('public parent product binding mismatch');
  const directoryNames = new Set(['']);
  for (const name of expected.keys()) { const parts = name.split('/'); parts.pop(); while (parts.length) { directoryNames.add(parts.join('/')); parts.pop(); } }
  const directories: { file: string; stat: BigIntStats }[] = [];
  const visit = (relative: string): void => {
    const directory = path.join(root, relative), before = lstatSync(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) return fail('ordinary selected public directory required');
    directories.push({ file: directory, stat: before });
    for (const name of readdirSync(directory).sort()) {
      if (name === '.private-originals') continue; // Do not inspect even a private entry in this public tree.
      const child = relative ? relative + '/' + name : name;
      if (directoryNames.has(child)) visit(child);
      else if (!expected.has(child)) return fail('public tree contains an unselected original');
    }
  };
  visit('');
  let total = 0;
  for (const ref of expected.values()) { total += ref.bytes;
    if (total > limits.originalBytes || expected.size > limits.originalMembers) return fail('complete AFS public inventory budget exceeded'); }
  const originals: CollectedArtifactMember[] = [];
  for (const [name, ref] of expected) {
    const observed = scanProductConsumerOriginal(fileFor(name), shards.has(name) ? limits.memberBytes : name === hintName ? limits.manifestBytes : limits.smallMemberBytes, false, deadline);
    if (observed.bytes !== ref.bytes || observed.sha256 !== ref.sha256 || observed.mode !== ref.mode) return fail('public original changed from its fixed reference');
    originals.push({ path: name, bytes: observed.bytes, sha256: observed.sha256, mode: observed.mode });
  }
  for (const directory of directories) if (!same(directory.stat, lstatSync(directory.file, { bigint: true }))) return fail('public directory changed during full scan');
  return Object.freeze({ module: 'afs' as const, originals: Object.freeze(originals.sort((a, b) => a.path.localeCompare(b.path))), totalBytes: total, manifestBytes: limits.manifestBytes });
}
