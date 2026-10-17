import path from 'node:path';
import { isNativeLegalMaterial } from './legal-coverage';
import type { CollectedArtifactView } from './artifact-contract';
import { registryLegalOriginalView } from './legal-registry-originals';

const canonical = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && !value.includes('\\') && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..');
function reject(message: string): never { throw new Error('Legal material inventory: ' + message); }
const isNotice = (name: string) => /^(?:licen[cs]e|copying|notice)(?:[._-]|$)/iu.test(path.posix.basename(name));

/** Checks the existing physical-module-notices format against the collected
 * archive. Integrity is deliberately separate from original issuer authority. */
export function inspectPhysicalLegalMaterials(artifact: CollectedArtifactView, originals: readonly unknown[] = [], verifyGrant?: (bytes: Buffer, declaredLicense?: unknown) => boolean, declarations?: (bytes: Buffer, declaredLicense: unknown) => string[]): { pending: string[]; qualifiedPaths: string[]; packages: number; files: number } | undefined {
  const members = new Map(artifact.members.map(member => [member.path, member]));
  if (!members.has('provenance/terms/index.json') && !artifact.members.some(row => /^provenance\/packages\/[^/]+\.json$/u.test(row.path))) return undefined;
  const read = (name: string) => JSON.parse(artifact.readMember(name, 1024 * 1024).toString('utf8'));
  const index = members.has('provenance/terms/index.json') ? read('provenance/terms/index.json') : undefined;
  if (index && (index.schemaVersion !== 1 || index.status !== 'original-material-collection' || index.legalClearance !== false
    || !Array.isArray(index.entries) || !Array.isArray(index.missingNamedOriginalTerms))) reject('unsupported terms format');
  const records = new Map<string, { placements: string[]; originals: { path: string; sha256: string; bytes: number }[] }>();
  const covered = new Set<string>();
  for (const member of artifact.members.filter(row => /^provenance\/packages\/[^/]+\.json$/u.test(row.path))) {
    const inventory = read(member.path);
    if (!canonical(inventory.path) || !inventory.path.startsWith('node_modules/') || typeof inventory.name !== 'string'
      || typeof inventory.version !== 'string' || !Array.isArray(inventory.files) || inventory.files.length > 20000) reject('invalid package inventory');
    const manifest = read(inventory.path + '/package.json');
    if (manifest.name !== inventory.name || manifest.version !== inventory.version) reject('package identity mismatch');
    const key = JSON.stringify([inventory.name, inventory.version]);
    const record = records.get(key) ?? { placements: [], originals: [] };
    if (record.placements.includes(inventory.path)) reject('duplicate package placement');
    record.placements.push(inventory.path); records.set(key, record);
    const declared = new Set<string>();
    for (const row of inventory.files) {
      if (!canonical(row.path) || row.path.split('/').includes('node_modules') || declared.has(row.path)) reject('unsafe or duplicate package member');
      declared.add(row.path);
      const filename = inventory.path + '/' + row.path, actual = members.get(filename);
      if (!actual || actual.bytes !== row.bytes || actual.sha256 !== row.sha256) reject('original package member differs: ' + filename);
      covered.add(filename);
      if (isNotice(row.path)) record.originals.push({ path: filename, sha256: actual.sha256, bytes: actual.bytes });
    }
    for (const actual of artifact.members) {
      if (!actual.path.startsWith(inventory.path + '/')) continue;
      const relative = actual.path.slice(inventory.path.length + 1);
      if (!relative.split('/').includes('node_modules') && !declared.has(relative)) reject('unlisted original package member: ' + actual.path);
    }
  }
  for (const member of artifact.members) if (member.path.startsWith('node_modules/') && !covered.has(member.path)) reject('uncovered physical dependency: ' + member.path);
  if (!index) {
    const pending = ['Physical package original terms index missing: provenance/terms/index.json'];
    for (const [key, record] of records) if (!record.originals.length) {
      const [name, version] = JSON.parse(key) as [string, string]; pending.push('Original terms missing: ' + name + '@' + version);
    }
    return { pending, qualifiedPaths: [], packages: records.size, files: covered.size };
  }
  const pending: string[] = [], missing: { name: string; version: string }[] = [], seen = new Set<string>();
  for (const entry of index.entries) {
    const key = JSON.stringify([entry.name, entry.version]), record = records.get(key);
    if (!record || seen.has(key) || JSON.stringify(entry.placements) !== JSON.stringify(record.placements)
      || (!Array.isArray(entry.originals) || entry.originals.length !== record.originals.length || record.originals.some((row, i) => row.path !== entry.originals[i]?.path || row.sha256 !== entry.originals[i]?.sha256 || row.bytes !== entry.originals[i]?.bytes)) || !Array.isArray(entry.supplements)) reject('terms inventory differs from actual packages');
    seen.add(key);
    for (const supplement of entry.supplements) {
      if (!Array.isArray(supplement.files) || !supplement.files.length) reject('empty supplement');
      for (const row of supplement.files) {
        if (!canonical(row.sourcePath) || !/^[a-f0-9]{64}$/u.test(row.sha256) || row.object !== 'objects/' + row.sha256 + '.txt') reject('invalid supplement binding');
        const actual = members.get('provenance/terms/' + row.object);
        if (!actual || !actual.bytes || actual.bytes !== row.bytes || actual.sha256 !== row.sha256) reject('supplement original differs');
      }
      pending.push('Immutable original issuer capability required for supplemental terms: ' + entry.name + '@' + entry.version);
    }
    if (!record.originals.length && !entry.supplements.length) {
      missing.push({ name: entry.name, version: entry.version });
      pending.push('Original terms missing: ' + entry.name + '@' + entry.version);
    }
  }
  if (seen.size !== records.size || JSON.stringify(index.missingNamedOriginalTerms) !== JSON.stringify(missing)) reject('missing original inventory differs');
  const qualifiedPaths: string[] = [];
  for (const [key, record] of records) {
    const [name, version] = JSON.parse(key) as [string, string];
    const original = originals.map(registryLegalOriginalView).find(view => view?.sourceSha === artifact.identity.sourceSha && view.name === name && view.version === version);
    if (!original) { pending.push('Immutable registry/source issuer required: ' + name + '@' + version); continue; }
    const upstream = new Map(original.members.map(member => [member.path, member]));
    const declaredLicense = JSON.parse(original.readMember('package.json').toString()).license;
    for (const placement of record.placements) {
      for (const member of artifact.members.filter(row => covered.has(row.path) && row.path.startsWith(placement + '/'))) {
        const before = pending.length;
        const relative = member.path.slice(placement.length + 1);
        if (relative.split('/').includes('node_modules')) continue;
        const actual = upstream.get(relative);
        if (!actual || actual.sha256 !== member.sha256 || actual.bytes !== member.bytes) {
          pending.push('Modified dependency member requires source derivation: ' + member.path); continue;
        }
        const signature = original.readMemberRange(relative, 0, Math.min(actual.bytes, 4));
        if (isNativeLegalMaterial(signature)) {
          pending.push('Native original requires native grant scope: ' + member.path); continue;
        }
        if (!declarations) pending.push('Explicit per-member declaration audit required: ' + member.path);
        else if (actual.bytes > 1024 * 1024) pending.push('Bounded per-member declaration audit requires range adapter: ' + member.path);
        else for (const conflict of declarations(original.readMember(relative), declaredLicense)) pending.push(member.path + ': ' + conflict);
        let directory = path.posix.dirname(relative), grants: string[] = [];
        for (;;) {
          grants = original.members.filter(row => path.posix.dirname(row.path) === directory && /^(?:licen[cs]e|copying)(?:[._-]|$)/iu.test(path.posix.basename(row.path))).map(row => row.path);
          if (grants.length || directory === '.') break;
          directory = path.posix.dirname(directory);
        }
        if (!grants.length || grants.some(grant => !verifyGrant?.(original.readMember(grant), declaredLicense))) pending.push('Unverified original scoped grant: ' + member.path);
        let ancestor = path.posix.dirname(relative);
        for (;;) {
          for (const notice of original.members.filter(row => path.posix.dirname(row.path) === ancestor && isNotice(row.path))) {
            const retained = members.get(placement + '/' + notice.path);
            if (!retained || retained.sha256 !== notice.sha256 || retained.bytes !== notice.bytes) pending.push('Applicable original notice is not retained: ' + placement + '/' + notice.path);
          }
          if (ancestor === '.') break;
          ancestor = path.posix.dirname(ancestor);
        }
        if (pending.length === before) qualifiedPaths.push(member.path);
      }
    }
  }
  return { pending, qualifiedPaths, packages: records.size, files: covered.size };
}
