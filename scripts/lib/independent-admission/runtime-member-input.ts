import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { safeMaterialPath } from '../../../packages/xpod-cli/src/source-materials';
import type { CollectedArtifactView } from './artifact-contract';
const { MANIFEST_MAX_BYTES } = createRequire(import.meta.url)('../../workspace-package-payload.cjs');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export class RuntimeReadPending extends Error {}
export interface RuntimeMemberInput {
  path: string; type: string; mode: number; size: number; sha256: string;
  readonly content: Buffer;
  readPrefix(): Buffer;
  readNativeMaterial(): Buffer;
}
/** Structural byte adapter only, not a capability issuer. Operational callers
 * must obtain the view from the collector's private getter. No workspace reads. */
export function collectedRuntimeMembers(view: CollectedArtifactView): RuntimeMemberInput[] {
  if (!view.members.length || view.members.length > 100000) throw Error('Runtime member inventory bound');
  const names = new Set<string>(); let total = 0;
  const result = view.members.map(row => {
    if (!safeMaterialPath(row.path) || names.has(row.path) || !Number.isSafeInteger(row.bytes) || row.bytes < 0
      || !/^[a-f0-9]{64}$/u.test(row.sha256) || !Number.isInteger(row.mode) || row.mode < 0 || row.mode > 0o777)
      throw Error('Runtime member identity/path invalid');
    names.add(row.path);
    let cached: Buffer | undefined;
    const read = (): Buffer => {
      if (cached) return cached;
      const limit = row.path === 'package.json' || row.path.endsWith('/package.json') ? MANIFEST_MAX_BYTES
        : /\.(?:[cm]?js|jsx|ts|tsx)$/u.test(row.path) ? 16 * 1024 ** 2 : 8 * 1024 ** 2;
      if (row.bytes > limit || total + row.bytes > 128 * 1024 ** 2)
        throw new RuntimeReadPending('bounded-runtime-member-reader-required:' + row.path);
      const bytes = view.readMember(row.path, Math.max(1, row.bytes));
      if (!Buffer.isBuffer(bytes) || bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw Error('Runtime member original digest mismatch');
      total += bytes.length; cached = bytes; return bytes;
    };
    const range = (length: number): Buffer => {
      const reader = view.readBoundMemberRange ?? view.readMemberRange;
      if (!reader) return read().subarray(0, length);
      const bytes = reader.call(view, row.path, 0, Math.min(row.bytes, length));
      if (!Buffer.isBuffer(bytes) || bytes.length !== Math.min(row.bytes, length)) throw Error('Runtime native header range mismatch');
      return bytes;
    };
    return { path: 'package/' + row.path, type: 'file', mode: row.mode, size: row.bytes, sha256: row.sha256,
      get content() { return read(); }, readPrefix: () => range(2),
      readNativeMaterial(): Buffer {
        const header = range(64), magic = header.subarray(0, 4).toString('hex');
        if (magic === '7f454c46') return header;
        if (['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe'].includes(magic) && header.length >= 28) {
          const little = magic.startsWith('cefa') || magic.startsWith('cffa');
          const commands = little ? header.readUInt32LE(20) : header.readUInt32BE(20);
          const length = (magic === 'feedfacf' || magic === 'cffaedfe' ? 32 : 28) + commands;
          if (length > 16 * 1024 ** 2 || length > row.bytes) throw new RuntimeReadPending('bounded-native-command-table-required:' + row.path);
          return range(length);
        }
        // WASM validation and fat/PE layouts require actual complete bytes.
        return read();
      } };
  });
  if (!names.has('package.json')) throw Error('Runtime package manifest missing');
  for (const name of names) {
    const segments = name.split('/'); segments.pop();
    while (segments.length) { if (names.has(segments.join('/'))) throw Error('Runtime member file/directory conflict'); segments.pop(); }
  }
  return result;
}
