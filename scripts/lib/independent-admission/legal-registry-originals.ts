import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { collectedArtifactView } from './artifact-collector';
import { derivedSourceView } from './source-context';
import type { CollectedArtifactMember } from './artifact-contract';
const { inspectTarballBuffer } = createRequire(import.meta.url)('../../workspace-package-payload.cjs');
function fail(message: string): never { throw Error('Legal registry originals: ' + message); }
const digest = (bytes: Buffer, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest();
export interface RegistryLegalOriginalView {
  readonly sourceSha: string; readonly name: string; readonly version: string; readonly integrity: string;
  readonly archiveSha256: string; readonly lockSha256: string; readonly metadataSha256: string;
  readonly archiveBytes: number; readonly expandedBytes: number;
  readonly members: readonly CollectedArtifactMember[];
  readArchiveRange(offset: number, length: number): Buffer;
  readMetadata(): Buffer;
  readMember(name: string): Buffer;
  readMemberRange(name: string, offset: number, length: number): Buffer;
}
interface Group { started: number; attempts: number; packed: number; expanded: number; active: boolean; caps: Map<string, object> }
const groups = new WeakMap<object, Group>();
const issued = new WeakMap<object, RegistryLegalOriginalView>();
export function registryLegalOriginalView(capability: unknown): RegistryLegalOriginalView | undefined {
  return capability && typeof capability === 'object' ? issued.get(capability) : undefined;
}
export function assertRegistryLegalOriginalCustody(value: unknown): void {
  if (!registryLegalOriginalView(value)) fail('issued registry original capability required');
  // Metadata, tar and member originals are private retained Buffers. Every
  // reader returns copies; no caller or mutable disk path owns these bytes.
}
/** Parse Bun's JSONC data, never evaluate the immutable candidate lock. */
export function registryLegalLockEntries(bytes: Buffer): Map<string, string> {
  const text = bytes.toString('utf8');
  // Bun lock files contain trailing commas. Remove them only outside strings.
  let clean = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) { clean += char; if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    if (char === ',' && /^\s*[}\]]/u.test(text.slice(i + 1))) continue;
    clean += char;
  }
  const lock = JSON.parse(clean), entries = new Map<string, string>();
  if (lock.lockfileVersion !== 1 || !lock.packages || typeof lock.packages !== 'object') fail('unsupported immutable Bun lock');
  for (const row of Object.values(lock.packages)) {
    if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
    const integrity = row[row.length - 1];
    if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)) continue;
    if (entries.has(row[0]) && entries.get(row[0]) !== integrity) fail('conflicting lock identities');
    entries.set(row[0], integrity);
  }
  return entries;
}
/** Pure original-format validation. Returning these bytes never issues the
 * operational registry capability; only the fixed transport below can do so. */
export function inspectRegistryLegalArchive(identity: { name: string; version: string; integrity: string }, metadataBytes: Buffer, archive: Buffer, maximumExpanded = 32 * 1024 ** 2): { entries: any[]; manifest: any } {
  if (archive.length > 8 * 1024 ** 2 || metadataBytes.length > 256 * 1024 || !Number.isSafeInteger(maximumExpanded) || maximumExpanded < 1 || maximumExpanded > 32 * 1024 ** 2) fail('original parser byte budget exceeded');
  const metadata = JSON.parse(metadataBytes.toString());
  if (metadata.name !== identity.name || metadata.version !== identity.version || metadata.dist?.integrity !== identity.integrity) fail('original metadata identity differs');
  if ('sha512-' + digest(archive, 'sha512').toString('base64') !== identity.integrity) fail('original archive SRI differs');
  const inspected = inspectTarballBuffer(archive, { expandedBytes: maximumExpanded, members: 20000, gnuLongNames: true });
  if (inspected.manifest.name !== identity.name || inspected.manifest.version !== identity.version) fail('original archive identity differs');
  for (const row of inspected.entries) if (!row.path.startsWith('package/')) fail('registry original outside package');
  return inspected;
}
/** Fixed official-registry GET only. Coordinates must be present in both the
 * actual collected package and its immutable Git lock. No callback can issue
 * this capability. Per request budgets keep all archives small and bounded. */
export async function observeRegistryLegalOriginal(input: { artifact: unknown; source: unknown; name: string; version: string }): Promise<object> {
  const artifact = collectedArtifactView(input.artifact), source = derivedSourceView(input.source);
  if (!artifact || !source || source.sourceSha !== artifact.identity.sourceSha) fail('bound collected archive and immutable Git required');
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(input.name)
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(input.version)) fail('exact registry identity required');
  let found = false;
  for (const member of artifact.members.filter(row => /(?:^|\/)package\.json$/u.test(row.path))) {
    if (member.bytes > 64 * 1024) continue;
    const manifest = JSON.parse(artifact.readMember(member.path, 64 * 1024).toString());
    if (manifest.name === input.name && manifest.version === input.version) { found = true; break; }
  }
  if (!found) {
    for (const member of artifact.members.filter(row => /(?:^|\/)licenses\/index\.json$/u.test(row.path)).slice(0, 64)) {
      const index = JSON.parse(artifact.readMember(member.path, 1024 * 1024).toString());
      if (index.packages?.some((row: any) => row.name === input.name && row.version === input.version)) found = true;
    }
  }
  if (!found || !source.trackedPaths.includes('bun.lock')) fail('actual package and immutable lock identity required');
  const lockBytes = source.readTracked('bun.lock');
  const integrity = registryLegalLockEntries(lockBytes).get(input.name + '@' + input.version);
  if (!integrity) fail('immutable registry SRI missing');
  const owner = input.artifact as object;
  const group = groups.get(owner) ?? { started: Date.now(), attempts: 0, packed: 0, expanded: 0, active: false, caps: new Map<string, object>() };
  groups.set(owner, group);
  const key = input.name + '@' + input.version;
  const existing = group.caps.get(key); if (existing) return existing;
  if (group.active || group.attempts >= 16 || group.packed >= 64 * 1024 ** 2 || group.expanded >= 128 * 1024 ** 2 || Date.now() - group.started >= 120000) fail('artifact group budget exhausted or acquisition already active; original admission pending');
  group.attempts++; group.active = true;
  try {
  const signal = AbortSignal.timeout(Math.min(30000, 120000 - (Date.now() - group.started)));
  const read = async (url: string, maximum: number, packed = false): Promise<Buffer> => {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://registry.npmjs.org' || parsed.username || parsed.password || parsed.hash) fail('noncanonical registry origin');
    const response = await fetch(url, { redirect: 'error', signal });
    if (response.status !== 200 || !response.body) fail('registry HTTP status ' + response.status);
    const reader = response.body!.getReader(), chunks: Buffer[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length;
      if (packed) group.packed += next.value.length;
      if (size > maximum || group.packed > 64 * 1024 ** 2) fail('registry byte budget exceeded; original admission pending'); chunks.push(Buffer.from(next.value)); } }
    finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks, size);
  };
  const metadataBytes = await read('https://registry.npmjs.org/' + encodeURIComponent(input.name) + '/' + encodeURIComponent(input.version), 256 * 1024);
  const metadata = JSON.parse(metadataBytes.toString());
  if (metadata.name !== input.name || metadata.version !== input.version || metadata.dist?.integrity !== integrity) fail('registry metadata conflicts with immutable lock');
  const archive = await read(metadata.dist.tarball, Math.min(8 * 1024 ** 2, 64 * 1024 ** 2 - group.packed), true);
  const expansionBudget = Math.min(32 * 1024 ** 2, 128 * 1024 ** 2 - group.expanded);
  // Reserve the full expansion ceiling even on malformed gzip/parser failure.
  group.expanded += expansionBudget;
  const inspected = inspectRegistryLegalArchive({ name: input.name, version: input.version, integrity }, metadataBytes, archive, expansionBudget);
  const expandedBytes = inspected.entries.reduce((total: number, row: any) => total + row.size, 0);

  const originals = new Map<string, Buffer>();
  for (const row of inspected.entries) if (row.type === 'file') {
    if (!row.path.startsWith('package/')) fail('registry original outside package');
    originals.set(row.path.slice(8), Buffer.from(row.content));
  }
  const members = Object.freeze([...originals].map(([name, bytes]) => Object.freeze({ path: name, bytes: bytes.length, sha256: digest(bytes).toString('hex'), mode: 0o644 })));
  const cap = Object.freeze({});
  issued.set(cap, Object.freeze({ sourceSha: source.sourceSha, name: input.name, version: input.version, integrity, members, archiveSha256: digest(archive).toString('hex'), lockSha256: digest(lockBytes).toString('hex'), metadataSha256: digest(metadataBytes).toString('hex'), archiveBytes: archive.length, expandedBytes,
    readMetadata() { return Buffer.from(metadataBytes); },
    readArchiveRange(offset: number, length: number) { if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > 65536 || offset + length > archive.length) return fail('bounded original archive range required'); return Buffer.from(archive.subarray(offset, offset + length)); },
    readMemberRange(name: string, offset: number, length: number) { const bytes = originals.get(name); if (!bytes || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > 65536 || offset + length > bytes.length) return fail('bounded original member range required'); return Buffer.from(bytes.subarray(offset, offset + length)); },
    readMember(name: string) { const bytes = originals.get(name); if (!bytes) return fail('original member absent'); return Buffer.from(bytes); } }));
  group.caps.set(key, cap); return cap;
  } finally { group.active = false; }
}
