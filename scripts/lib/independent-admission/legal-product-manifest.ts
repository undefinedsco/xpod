import { createRequire } from 'node:module';
import type { CollectedArtifactView } from './artifact-contract';
const require = createRequire(import.meta.url);
const { MANIFEST_MAX_BYTES } = require('../../workspace-package-payload.cjs') as { MANIFEST_MAX_BYTES: number };
interface StreamingParser {
  stack: { key?: string | number }[];
  key?: string | number;
  value?: Record<string | number, unknown> | unknown[];
  tState: number;
  onValue(value: unknown): void;
  write(bytes: Buffer): void;
}
const Parser = require('jsonparse') as new () => StreamingParser;
/** Project identity only, discarding provenance rows as they complete. The
 * canonical product manifest limit stays 16MiB; no full manifest Buffer/string
 * is constructed and every custody read is at most 64KiB. No authority issued. */
export function readLegalProductManifest(artifact: CollectedArtifactView): { name: string; version: string; xpodModule?: { id: string } } {
  const member = artifact.members.find(row => row.path === 'package.json');
  if (!member || member.bytes > MANIFEST_MAX_BYTES || !artifact.readMemberRange) throw Error('Legal product manifest: canonical range/budget required');
  const parser = new Parser(), selected = new Map<string, string>(); let completed = 0;
  parser.onValue = function(value) {
    if (this.stack.length > 64 || typeof value === 'string' && value.length > 65536) throw Error('Legal product manifest: token/depth budget');
    const keys = [...this.stack.map(row => row.key).filter(key => key !== undefined), ...(this.key === undefined ? [] : [this.key])];
    const key = keys.length === 1 && (keys[0] === 'name' || keys[0] === 'version') ? keys[0]
      : keys.length === 2 && keys[0] === 'xpodModule' && keys[1] === 'id' ? 'xpodModule/id' : undefined;
    if (key !== undefined) {
      if (typeof value !== 'string' || selected.has(key)) throw Error('Legal product manifest: invalid/duplicate identity');
      selected.set(key, value);
    }
    if (!this.stack.length) completed++;
    if (this.value && this.key !== undefined) {
      if (Array.isArray(this.value)) this.value.length = 0;
      else delete this.value[this.key];
    }
  };
  for (let offset = 0; offset < member.bytes; offset += 65536) {
    const length = Math.min(65536, member.bytes - offset), bytes = artifact.readMemberRange('package.json', offset, length);
    if (bytes.length !== length) throw Error('Legal product manifest: truncated custody range');
    parser.write(bytes);
    if (parser.stack.length > 64) throw Error('Legal product manifest: depth budget');
  }
  parser.write(Buffer.from(' '));
  const name = selected.get('name'), version = selected.get('version'), id = selected.get('xpodModule/id');
  if (completed !== 1 || parser.stack.length || parser.tState !== 0x11 || !name || !version) throw Error('Legal product manifest: incomplete identity JSON');
  return { name, version, ...(id ? { xpodModule: { id } } : {}) };
}
