import { createHash } from 'node:crypto';
import limits from '../module-artifact-limits.json';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { openBoundOriginalFile } from './bound-original-file';
import type { CollectedArtifactMember } from './artifact-contract';
const { inspectArtifact } = createRequire(import.meta.url)('../product-artifact-command.cjs');
const GiB = 1024 ** 3, MiB = 1024 ** 2;
const fail = (reason: string): never => { throw Error('Module source originals: ' + reason); };
export async function collectModuleSourceOriginals(input: {
  archivePath: string; archiveSha256: string;
  inventory: { members: readonly (CollectedArtifactMember & { kind: string })[]; expandedBytes: number };
  producer: any;
}) {
  const reference = input.producer?.sourceMaterials;
  if (!reference) return undefined;
  if (reference.path !== 'source-materials/materials.json' || reference.bytes > limits.metadataBytes) fail('registered bounded source master required');
  const rows = input.inventory.members.filter(row => row.kind === 'file' && row.path.startsWith('source-materials/'));
  if (!rows.length || rows.length > limits.sourceMaterialFiles || rows.some(row => !/^source-materials\/(?:materials\.json|(?:source|dependencies|toolchain)-\d{4}\.tar|(?:source|dependencies|toolchain)-inventory-\d{4}\.json|outputs-\d{4}\.json)$/u.test(row.path)
    || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > (row.path.endsWith('.tar') ? limits.shardBytes : limits.metadataBytes))) fail('registered source original layout/budget required');
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  if (total > limits.sourceMaterialBytes || input.inventory.expandedBytes > limits.expandedBytes) fail('unified source/archive aggregate budget exceeded');
  for (const [domain, maximum] of [['source', limits.sourceBytes], ['dependencies', limits.dependencyBytes], ['toolchain', limits.toolchainBytes]] as const) {
    if (rows.filter(row => row.path.startsWith('source-materials/' + domain + '-') && row.path.endsWith('.tar')).reduce((sum, row) => sum + row.bytes, 0) > maximum) fail('source domain byte budget exceeded');
  }
  const master = rows.filter(row => row.path === reference.path);
  if (master.length !== 1 || master[0]!.bytes !== reference.bytes || master[0]!.sha256 !== reference.sha256) fail('source master receipt/inventory mismatch');
  const parent = fs.realpathSync(os.tmpdir()), stat = fs.statfsSync(parent, { bigint: true });
  if (stat.bavail * stat.bsize < BigInt(total + limits.freeFloorBytes + limits.queueReserveBytes)) fail('source snapshot free-space floor insufficient');
  const root = fs.mkdtempSync(path.join(parent, 'xpod-module-source-originals-'));
  const readers = new Map<string, ReturnType<typeof openBoundOriginalFile>>();
  const dispose = () => { for (const reader of readers.values()) reader.close(); readers.clear(); fs.rmSync(root, { recursive: true, force: true }); };
  try {
    const result = inspectArtifact([path.resolve(import.meta.dir, '../inspect-product-artifact.py'), input.archivePath, input.archiveSha256,
      String(limits.packedBytes), String(limits.expandedBytes), String(limits.members), '--selection-stdin', root, 'module-material-originals'],
    { timeout: limits.timeoutMs, maxBuffer: 32 * MiB, input: Buffer.from(JSON.stringify(rows.map(row => ({ path: row.path,
      destination: row.path, bytes: row.bytes, sha256: row.sha256 })))) });
    if (result.error || result.status !== 0 || result.signal) fail('owned source-original projection failed: ' + String(result.stderr).slice(0, 1200));
    const actual = JSON.parse(result.stdout);
    if (!isDeepStrictEqual(actual.members, input.inventory.members) || actual.expandedBytes !== input.inventory.expandedBytes
      || actual.selectedMembersProjected !== rows.length || actual.innerArchiveExpanded !== false) fail('source original complete ZIP inventory changed');
    for (const row of rows) {
      const file = path.join(root, row.path); fs.chmodSync(file, 0o400);
      readers.set(row.path, openBoundOriginalFile(file, row));
    }
    return Object.freeze({ members: Object.freeze(rows.map(({ path, bytes, sha256, mode }) => Object.freeze({ path, bytes, sha256, mode }))),
      readRange(name: string, offset: number, length: number) { const reader = readers.get(name); if (!reader) return fail('registered source original required'); return reader.readRange(offset, length); },
      readSmall(name: string, maximum: number) {
        const row = rows.find(row => row.path === name);
        if (!row || !Number.isSafeInteger(maximum) || maximum < 0 || maximum > 8 * MiB || row.bytes > maximum) return fail('bounded source manifest/inventory required');
        const bytes = Buffer.alloc(row.bytes);
        for (let offset = 0; offset < row.bytes; offset += 65536) this.readRange(name, offset, Math.min(65536, row.bytes - offset)).copy(bytes, offset);
        return bytes;
      },
      compact() {
        // Only a byte-identical retained outer original makes this projection
        // disposable. Never infer reconstructibility from a saved JSON URL.
        const file = input.archivePath, before = fs.lstatSync(file);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limits.packedBytes) fail('retained unique ZIP original required before compaction');
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const hash = createHash('sha256'), scratch = Buffer.alloc(limits.rangeBytes), deadline = Date.now() + limits.timeoutMs;
          const unchanged = (stat: fs.Stats) => before.dev === stat.dev && before.ino === stat.ino && before.size === stat.size
            && before.ctimeMs === stat.ctimeMs && before.mtimeMs === stat.mtimeMs && before.nlink === stat.nlink;
          if (!unchanged(fs.fstatSync(fd))) fail('retained ZIP changed before compaction');
          for (;;) {
            if (Date.now() >= deadline) fail('retained ZIP hash deadline exceeded');
            const count = fs.readSync(fd, scratch, 0, scratch.length, null); if (!count) break; hash.update(scratch.subarray(0, count));
          }
          if (hash.digest('hex') !== input.archiveSha256 || !unchanged(fs.fstatSync(fd)) || !unchanged(fs.lstatSync(file))) fail('retained ZIP identity changed before compaction');
        } finally { fs.closeSync(fd); }
        dispose();
      }, dispose });
  } catch (error) { dispose(); throw error; }
}
