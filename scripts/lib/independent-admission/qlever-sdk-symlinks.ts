import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import limits from '../module-artifact-limits.json';
const need = (value: unknown, why: string): void => { if (!value) throw Error('SDK symlink originals: ' + why); };
const absolute = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && path.posix.normalize(value) === value
  && !/[\\\u0000-\u001f\u007f]/u.test(value) && !value.endsWith('/');
const same = isDeepStrictEqual;
/** Pure mechanics on originals already read through the SDK private custody.
 * Input content hashes must have been checked by inspectSdkInputOwnership. */
export function inspectSdkSymlinkOriginals(input: {before: any; after: any; inputRows: readonly any[]; legacyLinks: readonly any[]; check(): void}) {
  const snapshots = [input.before, input.after].map(snapshot => {
    need(snapshot?.schemaVersion === 1 && snapshot.kind === 'sdk-readlink-originals' && Array.isArray(snapshot.links)
      && snapshot.links.length <= limits.sourceMembers && snapshot.inputBindings && typeof snapshot.inputBindings === 'object' && !Array.isArray(snapshot.inputBindings), 'bounded actual before/after snapshots required');
    const links = new Map<string, any>();
    for (const row of snapshot.links) {
      input.check(); need(absolute(row.originalPath) && !links.has(row.originalPath) && absolute(row.resolvedTarget)
        && typeof row.linkTarget === 'string' && row.linkTarget.length > 0 && !/[\u0000-\u001f\u007f]/u.test(row.linkTarget), 'canonical unique readlink original required');
      const raw = Buffer.from(row.linkTarget);
      need(row.bytes === raw.length && row.sha256 === createHash('sha256').update(raw).digest('hex') && row.readlinkBase64 === raw.toString('base64'), 'readlink original bytes differ');
      for (const [identity, symbolic] of [[row.linkIdentity, true], [row.targetIdentity, false]] as const) {
        need(identity && ['st_dev', 'st_ino', 'st_mode'].every(key => typeof identity[key] === 'string' && /^[0-9]+$/u.test(identity[key])), 'actual filesystem identity required');
        const mode = Number(identity.st_mode), kind = mode & 0o170000;
        need(Number.isSafeInteger(mode) && (symbolic ? kind === 0o120000 : kind === 0o040000 || kind === 0o100000), 'actual link/target file kind differs');
        if (kind !== 0o040000) need(['st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink'].every(key => typeof identity[key] === 'string' && /^[0-9]+$/u.test(identity[key])), 'complete actual file identity required');
      }
      need(Number(row.linkIdentity.st_size) === raw.length, 'lstat/readlink size differs'); links.set(row.originalPath, row);
    }
    need(Object.keys(snapshot.inputBindings).length <= limits.sourceMembers, 'input binding count bound');
    return {links, bindings: snapshot.inputBindings};
  });
  const before = snapshots[0]!, after = snapshots[1]!, rows = new Map(input.inputRows.map(row => [row.originalPath, row]));
  // Resolve components from observed readlink bytes, never the controller filesystem.
  const resolve = (name: string, links: Map<string, any>) => {
    let parts = name.split('/').filter(Boolean), result: string[] = [], hops = 0; const used = new Set<string>();
    while (parts.length) {
      input.check(); const part = parts.shift()!;
      if (part === '.') continue;
      if (part === '..') { result.pop(); continue; }
      const candidate = '/' + [...result, part].join('/'), link = links.get(candidate);
      if (!link) { result.push(part); continue; }
      need(++hops <= 40, 'readlink chain cycle/depth'); used.add(candidate);
      if (link.linkTarget.startsWith('/')) result = [];
      parts = [...link.linkTarget.split('/').filter(Boolean), ...parts];
    }
    return {resolved: '/' + result.join('/'), used};
  };
  const unresolved: Readonly<{path: string; reason: string}>[] = [], bindings: unknown[] = [], selectedLinks = new Set<string>();
  for (const [name, row] of after.links) {
    const actual = resolve(name, after.links);
    need(actual.resolved === row.resolvedTarget, 'recorded target differs from actual lexical chain');
    if (!before.links.has(name)) unresolved.push(Object.freeze({path: name, reason: 'symlink-original-unavailable-before-compile'}));
    else need(same(before.links.get(name), row), 'before/after readlink original identity changed');
  }
  for (const [lexical, binding] of Object.entries(after.bindings) as [string, any][]) {
    input.check(); need(absolute(lexical) && absolute(binding?.resolvedTarget) && same(before.bindings[lexical], binding), 'actual input binding unavailable/changed before compile');
    const resolution = resolve(lexical, after.links);
    need(resolution.used.size > 0 && resolution.resolved === binding.resolvedTarget, 'actual input lexical-chain binding differs');
    for (const link of resolution.used) need(before.links.has(link) && same(before.links.get(link), after.links.get(link)), 'input link missing/changed before compile');
    const row = rows.get(binding.resolvedTarget);
    need(row && Number(binding.targetIdentity?.st_size) === row.bytes && (Number(binding.targetIdentity?.st_mode) & 0o7777) === row.mode
      && (Number(binding.targetIdentity?.st_mode) & 0o170000) === 0o100000, 'resolved input absent from verified actual shard rows');
    // The binding identity must equal the endpoint identity observed by the last link.
    const endpoint = [...resolution.used].map(name => after.links.get(name)).filter(link => link.resolvedTarget === resolution.resolved);
    need(endpoint.every(link => same(link.targetIdentity, binding.targetIdentity)), 'input endpoint identity differs from readlink observation');
    need([...resolution.used].every(name => { const link = after.links.get(name); return link.resolvedTarget === resolution.resolved ||
      (Number(link.targetIdentity.st_mode) & 0o170000) === 0o040000 && resolution.resolved.startsWith(link.resolvedTarget + '/'); }), 'directory link does not contain actual input endpoint');
    for (const name of resolution.used) selectedLinks.add(name);
    bindings.push(Object.freeze({path: lexical, resolvedTarget: row.originalPath, bytes: row.bytes, sha256: row.sha256, links: Object.freeze([...resolution.used])}));
  }
  for (const row of input.legacyLinks) need(after.links.has(row.originalPath) && ['linkTarget', 'bytes', 'sha256'].every(key => after.links.get(row.originalPath)[key] === row[key]), 'actual input readlink inventory not covered by snapshot');
  // Removed links only matter when selected: every actual input lexical path must
  // still resolve through the same precompile chain, including directory links.
  for (const row of input.inputRows) {
    const old = resolve(row.originalPath, before.links), current = resolve(row.originalPath, after.links);
    for (const name of current.used) selectedLinks.add(name);
    need(old.resolved === current.resolved && [...old.used].every(name => after.links.has(name) && same(before.links.get(name), after.links.get(name))), 'selected input link removed or changed');
  }
  for (const row of input.legacyLinks) need(selectedLinks.has(row.originalPath) || !before.links.has(row.originalPath), 'selected alias lacks actual lexical input binding');
  return Object.freeze({bindings: Object.freeze(bindings), linkCount: after.links.size, unresolved: Object.freeze(unresolved)});
}
