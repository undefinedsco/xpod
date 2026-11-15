import { createHash } from 'node:crypto';
import limits from '../module-artifact-limits.json';

type Ref = Readonly<{path: string; bytes: number; sha256: string}>;
type Source = Readonly<{name: string; version: string}>;
type Ledger = Readonly<Record<string, Readonly<{binaryVersion: string; source: Source}>>>;
const need = (value: unknown, why: string): void => { if (!value) throw Error('SDK input originals: ' + why); };
const safe = (name: unknown): name is string => typeof name === 'string' && Boolean(name) && !name.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..');
const absolute = (name: unknown): name is string => typeof name === 'string' && name.startsWith('/') && safe(name.slice(1));
const sha = /^[a-f0-9]{64}$/u;
/** Mechanical bytes/ownership only. Caller must supply the already checked
 * private SDK readers and the fixed parser's actual dpkg ledger result. */
export function inspectSdkInputOwnership(input: {
  before: any; after: any; shards: readonly Ref[]; ledger: Ledger;
  readRange(path: string, offset: number, length: number): Buffer; check(): void;
}) {
  const {before, after} = input;
  need(before && typeof before === 'object' && !Array.isArray(before) && after?.schemaVersion === 1 && Array.isArray(after.files)
    && after.files.length > 0 && after.files.length <= limits.sourceMembers && Array.isArray(after.packageOwnershipOriginals), 'actual before/after inventory required');
  need(Object.keys(before).length <= limits.sourceMembers && Object.entries(before).every(([name, value]: [string, any]) => absolute(name)
    && value && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && sha.test(value.sha256) && Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o7777), 'canonical before identities required');
  const rows = new Map<string, any>(), originals = new Set<string>();
  for (const row of after.files) {
    need(absolute(row.originalPath) && safe(row.archivePath) && row.archivePath === row.originalPath.slice(1) && !rows.has(row.archivePath)
      && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= limits.shardBytes && sha.test(row.sha256)
      && Number.isInteger(row.mode) && row.mode >= 0 && row.mode <= 0o7777
      && ['observed-input', 'compile-output', 'installed-metadata'].includes(row.role), 'canonical complete actual input row required');
    rows.set(row.archivePath, row);
  }
  need(after.packageOwnershipOriginals.length <= limits.sourceMembers, 'ownership count bound');
  for (const name of after.packageOwnershipOriginals) {
    need(absolute(name) && /^\/var\/lib\/dpkg\/info\/[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?\.list$/u.test(name)
      && rows.get(name.slice(1))?.role === 'installed-metadata' && !originals.has(name), 'registered dpkg ownership original required'); originals.add(name);
  }
  need(input.shards.length > 0 && input.shards.length <= limits.sourceMaterialFiles && new Set(input.shards.map(row => row.path)).size === input.shards.length, 'complete unique input shard set required');
  const ownership = new Map<string, Buffer>(), seen = new Set<string>(); let cached = 0, total = 0;
  for (const archive of input.shards) {
    need(safe(archive.path) && Number.isSafeInteger(archive.bytes) && archive.bytes >= 1024 && archive.bytes <= limits.shardBytes && sha.test(archive.sha256), 'bounded actual input shard required');
    total += archive.bytes; need(total <= limits.sourceMaterialBytes, 'shared input shard byte bound');
    let windowStart = -1, window = Buffer.alloc(0);
    const archiveHash = createHash('sha256');
    const read = (offset: number, size: number) => {
      input.check(); need(size >= 0 && size <= limits.rangeBytes && offset >= 0 && offset + size <= archive.bytes, 'tar range bound');
      const result = Buffer.alloc(size); let used = 0;
      while (used < size) {
        const at = offset + used, start = Math.floor(at / limits.rangeBytes) * limits.rangeBytes;
        if (windowStart !== start) {
          need(start === windowStart + limits.rangeBytes || windowStart === -1 && start === 0, 'tar reads must remain sequential');
          window = input.readRange(archive.path, start, Math.min(limits.rangeBytes, archive.bytes - start));
          need(window.length === Math.min(limits.rangeBytes, archive.bytes - start), 'truncated original shard'); archiveHash.update(window); windowStart = start;
        }
        const count = Math.min(size - used, window.length - (at - start)); need(count > 0, 'truncated tar window');
        window.copy(result, used, at - start, at - start + count); used += count;
      }
      return result;
    };
    const string = (bytes: Buffer) => bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)).toString('utf8');
    const octal = (bytes: Buffer) => { const text = string(bytes).trim(); need(/^[0-7]+$/u.test(text), 'tar numeric encoding'); return parseInt(text, 8); };
    let offset = 0, extendedPath: string | undefined, ended = false;
    while (offset + 512 <= archive.bytes) {
      const header = read(offset, 512); offset += 512;
      if (header.every(value => value === 0)) { ended = true; break; }
      need([...header].reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0) === octal(header.subarray(148, 156)), 'tar header checksum');
      const size = octal(header.subarray(124, 136)), type = header[156];
      need(Number.isSafeInteger(size) && size >= 0 && offset + Math.ceil(size / 512) * 512 <= archive.bytes, 'tar payload bound');
      if (type === 120) {
        need(extendedPath === undefined && size > 0 && size <= 4096, 'bounded single PAX path required');
        const raw = read(offset, size); let at = 0;
        while (at < raw.length) {
          const space = raw.indexOf(32, at), text = raw.subarray(at, space).toString();
          need(space > at && /^[1-9][0-9]*$/u.test(text), 'PAX length encoding'); const length = Number(text);
          need(length > space - at + 1 && at + length <= raw.length && raw[at + length - 1] === 10, 'PAX record bound');
          const record = raw.subarray(space + 1, at + length - 1).toString();
          need(record.startsWith('path=') && extendedPath === undefined && safe(record.slice(5)), 'unsupported PAX field'); extendedPath = record.slice(5); at += length;
        }
      } else {
        const name = extendedPath ?? [string(header.subarray(345, 500)), string(header.subarray(0, 100))].filter(Boolean).join('/'); extendedPath = undefined;
        const row = rows.get(name);
        need((type === 0 || type === 48) && safe(name) && row && !seen.has(name) && row.bytes === size && row.mode === octal(header.subarray(100, 108)), 'tar actual member universe/metadata differs'); seen.add(name);
        const keep = originals.has(row.originalPath), digest = createHash('sha256'), chunks: Buffer[] = [];
        if (keep) { cached += size; need(size <= limits.metadataBytes && cached <= 16 * 1024 ** 2, 'bounded ownership original cache exceeded'); }
        for (let at = 0; at < size; at += limits.rangeBytes) { const bytes = read(offset + at, Math.min(limits.rangeBytes, size - at)); digest.update(bytes); if (keep) chunks.push(bytes); }
        need(digest.digest('hex') === row.sha256, 'actual input bytes differ');
        if (keep) ownership.set(row.originalPath, Buffer.concat(chunks));
      }
      const padded = Math.ceil(size / 512) * 512;
      // Read padding too so the sequential whole-shard digest includes every byte.
      for (let at = size; at < padded; at += limits.rangeBytes) read(offset + at, Math.min(limits.rangeBytes, padded - at));
      offset += padded;
    }
    need(ended && extendedPath === undefined, 'tar termination required');
    while (offset < archive.bytes) { const size = Math.min(limits.rangeBytes, archive.bytes - offset); need(read(offset, size).every(value => value === 0), 'tar trailing original data'); offset += size; }
    need(archiveHash.digest('hex') === archive.sha256, 'complete input shard hash differs');
  }
  need(seen.size === rows.size && ownership.size === originals.size, 'incomplete actual input/ownership shard set');
  const owners = new Map<string, string[]>();
  for (const [name, raw] of ownership) {
    const binary = name.slice('/var/lib/dpkg/info/'.length, -'.list'.length);
    need(input.ledger[binary], 'ownership binary absent from actual source ledger');
    need(!raw.includes(0) && Buffer.from(raw.toString('utf8')).equals(raw), 'ownership original must be UTF-8');
    for (const file of new Set(raw.toString('utf8').split('\n'))) if (absolute(file) && rows.has(file.slice(1))) owners.set(file, [...(owners.get(file) ?? []), binary]);
  }
  const coverage = [], unresolved = [], required = new Map<string, Source>();
  for (const row of rows.values()) {
    const prior = before[row.originalPath];
    if (prior) need(prior.bytes === row.bytes && prior.sha256 === row.sha256 && prior.mode === row.mode, 'before/after actual input changed');
    const binaries = owners.get(row.originalPath) ?? [];
    const sources = binaries.map(binary => { const source = input.ledger[binary]!.source; required.set(source.name + '\0' + source.version, source); return {binary, binaryVersion: input.ledger[binary]!.binaryVersion, source}; });
    if (prior === undefined && row.role === 'observed-input') unresolved.push(Object.freeze({path: row.originalPath, role: row.role, reason: 'generated-or-unobserved-before-compile'}));
    coverage.push(Object.freeze({path: row.originalPath, role: row.role, observedBeforeCompile: Boolean(prior), owners: Object.freeze(sources)}));
    if (!binaries.length && (prior !== undefined || row.role !== 'observed-input')) unresolved.push(Object.freeze({path: row.originalPath, role: row.role,
      reason: row.role === 'compile-output' ? 'generated-build-output-source-causality-unverified' : row.role === 'installed-metadata' ? 'retained-install-metadata' : !prior ? 'generated-or-unobserved-before-compile' : 'non-Debian-input-source-authority-unresolved'}));
  }
  need(after.symlinkOriginalTargets === undefined || Array.isArray(after.symlinkOriginalTargets) && after.symlinkOriginalTargets.length <= limits.sourceMembers, 'bounded symlink original inventory required');
  const unresolvedSymlinkOriginalTargets = (after.symlinkOriginalTargets ?? []).map((row: any) => {
    need(absolute(row.originalPath) && typeof row.linkTarget === 'string' && !/[\u0000-\u001f\u007f]/u.test(row.linkTarget)
      && Buffer.byteLength(row.linkTarget) === row.bytes && createHash('sha256').update(row.linkTarget).digest('hex') === row.sha256, 'actual symlink target encoding differs');
    return Object.freeze({path: row.originalPath, target: row.linkTarget, reason: 'symlink-original-observed-after-compile-only'});
  });
  return Object.freeze({unresolvedSymlinkOriginalTargets: Object.freeze(unresolvedSymlinkOriginalTargets), inputRows: Object.freeze(coverage), requiredSources: Object.freeze([...required.values()]), unresolvedInputs: Object.freeze(unresolved), inputShardBytes: total});
}

/** Exact producer diagnostics accepted by the execution planner. They remain
 * unresolved until the independent same-SDK raw/full-shard join proves bytes. */
export const SDK_OBSERVED_TOOL_PENDING_REASONS = Object.freeze([
  'observed-tool-file-missing-from-after-full-shard',
  'observed-tool-file-differs-from-after-full-shard',
] as const);

/** Pure projection only; no before observation or source capability is issued. */
export function inspectSdkObservedToolAfterFiles(input: {
  files: readonly any[];
  verifiedRows: readonly Readonly<{originalPath:string;bytes:number;sha256:string;mode:number}>[];
  binaryFiles: readonly Readonly<{installedPath:string;bytes:number;sha256:string;mode:number;binary:unknown;source:unknown}>[];
}) {
  const rows=new Map(input.verifiedRows.map(row=>[row.originalPath,row]));
  need(rows.size===input.verifiedRows.length && input.files.length<=limits.sourceMembers,'bounded unique verified after rows');
  const seen=new Set<string>(), files=[], pending=[];
  for(const row of input.files){
    need(absolute(row.path) && ['configure','compile'].includes(row.phase) && Number.isSafeInteger(row.captureSequence) && row.captureSequence>0
      && Number.isSafeInteger(row.bytes) && row.bytes>=0 && row.bytes<=limits.shardBytes && sha.test(row.sha256)
      && Number.isInteger(row.mode) && row.mode>=0 && row.mode<=0o7777 && row.observedBeforeCompile===false
      && Array.isArray(row.identityDecimal) && row.identityDecimal.length===6 && row.identityDecimal.every((v:unknown)=>typeof v==='string' && /^[0-9]+$/u.test(v)), 'actual observed-after tool row required');
    const key=row.phase+':'+row.captureSequence;need(!seen.has(key),'duplicate tool capture');seen.add(key);
    const actual=rows.get(row.path);need(actual && actual.bytes===row.bytes && actual.sha256===row.sha256 && actual.mode===row.mode,'tool differs from same verified after-shard row');
    const official=input.binaryFiles.filter(value=>value.installedPath===row.path && value.bytes===row.bytes && value.sha256===row.sha256 && value.mode===row.mode);
    need(official.length<=1,'ambiguous private Debian binary file');
    if(!official.length)pending.push(Object.freeze({path:row.path,reason:'observed-tool-official-Debian-binary-original-unavailable'}));
    files.push(Object.freeze({...row,identityDecimal:Object.freeze([...row.identityDecimal]),signedDebianBinary:official[0]?.binary,declaredSource:official[0]?.source}));
  }
  return Object.freeze({files:Object.freeze(files),pending:Object.freeze(pending)});
}
