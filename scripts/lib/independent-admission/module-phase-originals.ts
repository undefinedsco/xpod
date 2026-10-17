import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

interface InventoryMember { path: string; kind: 'file' | 'directory'; bytes: number; sha256: string; mode: number }
interface PhaseOriginalInput {
  archivePath: string; archiveSha256: string;
  inventory: { members: readonly InventoryMember[]; expandedBytes: number };
  producer: unknown;
}
export interface ModulePhaseOriginals {
  readonly members: readonly Readonly<{ path: string; bytes: number; sha256: string; mode: number }>[];
  readSmallReceipt(name: string, maximum: number): Buffer;
}
const require = createRequire(import.meta.url);
const { withOwnedTempRoot } = require('../owned-temp-root.cjs');
const { inspectArtifact } = require('../product-artifact-command.cjs');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => { throw new Error('Module phase originals: ' + message); };

/** Bounded original-byte reader only. This helper cannot issue admission. */
export async function collectModulePhaseOriginals(input: PhaseOriginalInput): Promise<ModulePhaseOriginals> {
  if (typeof input.archiveSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.archiveSha256)
    || !input.inventory || !Array.isArray(input.inventory.members) || input.inventory.members.length > 50_000) return fail('full archive identity and inventory required');
  const producer = input.producer as any;
  if (!Array.isArray(producer?.phases) || !producer.phases.length || producer.phases.length > 64) return fail('bounded nonempty producer phases required');
  const member = (name: string): InventoryMember => {
    const matches = input.inventory.members.filter(row => row.path === name);
    const row = matches[0];
    if (matches.length !== 1 || row.kind !== 'file' || !Number.isSafeInteger(row.bytes) || row.bytes < 0
      || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256)) return fail('unique ordinary original member required');
    return row;
  };
  const selected: InventoryMember[] = [member('producer.receipt.json')];
  const names = new Set<string>();
  for (const phase of producer.phases) {
    if (!phase || typeof phase.name !== 'string' || !/^[a-z0-9-]+$/u.test(phase.name) || names.has(phase.name)) return fail('unique fixed phase name required');
    names.add(phase.name);
    for (const [key, suffix] of [['receipt', 'receipt.json'], ['raw', 'raw.log']] as const) {
      const name = `evidence/${phase.name}.${suffix}`, row = member(name), reference = phase[key];
      if (reference?.path !== name || reference.bytes !== row.bytes || reference.sha256 !== row.sha256) return fail('phase original reference mismatch');
      if (key === 'receipt') selected.push(row);
    }
  }
  if (selected.some(row => row.bytes > 1024 ** 2) || selected.reduce((sum, row) => sum + row.bytes, 0) > 8 * 1024 ** 2) return fail('small receipt projection bound');
  return withOwnedTempRoot('xpod-module-phase-originals-', async (temporary: string) => {
    const result = inspectArtifact([path.resolve(import.meta.dir, '../inspect-product-artifact.py'), input.archivePath, input.archiveSha256,
      String(512 * 1024 ** 2), String(1024 ** 3), '50000', '--selection-stdin', temporary, 'module-source-originals'],
    { timeout: 30_000, maxBuffer: 16 * 1024 ** 2, input: Buffer.from(JSON.stringify(selected.map(row => ({ path: row.path,
      destination: row.path, bytes: row.bytes, sha256: row.sha256 })))) });
    if (result.error || result.status !== 0 || result.signal) return fail('complete artifact inspection failed');
    const actual = JSON.parse(result.stdout);
    if (!isDeepStrictEqual(actual.members, input.inventory.members) || actual.expandedBytes !== input.inventory.expandedBytes
      || actual.selectedMembersProjected !== selected.length || actual.innerArchiveExpanded !== false) return fail('complete actual inventory differs');
    const originals = new Map<string, Buffer>();
    const digests = new Map<string, string>();
    for (const row of selected) {
      const file = path.join(temporary, row.path), stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== row.bytes) return fail('projected ordinary receipt required');
      const bytes = readFileSync(file);
      if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) return fail('projected original digest mismatch');
      const value = JSON.parse(bytes.toString('utf8'));
      if (row.path === 'producer.receipt.json' && !isDeepStrictEqual(value, producer)) return fail('producer differs from original JSON');
      originals.set(row.path, Buffer.from(bytes)); digests.set(row.path, row.sha256);
    }
    const members = Object.freeze((actual.members as InventoryMember[]).filter(row => row.kind === 'file').map(row => Object.freeze({
      path: row.path, bytes: row.bytes, sha256: row.sha256, mode: row.mode })));
    return Object.freeze({ members,
      readSmallReceipt(name: string, maximum: number): Buffer {
        const bytes = originals.get(name);
        if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 1024 ** 2 || !bytes || bytes.length > maximum) return fail('selected bounded small receipt required');
        if (hash(bytes) !== digests.get(name)) return fail('saved original digest changed');
        return Buffer.from(bytes);
      } });
  });
}
