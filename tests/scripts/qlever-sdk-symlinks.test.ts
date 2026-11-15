import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, readlinkSync, lstatSync, statSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { inspectSdkSymlinkOriginals } from '../../scripts/lib/independent-admission/qlever-sdk-symlinks';
const identity = (mode: number, bytes = 4) => ({st_dev: '1', st_ino: '2', st_mode: String(mode), ...(mode === 0o040755 ? {} : {st_size: String(bytes), st_mtime_ns: '1', st_ctime_ns: '1', st_nlink: '1'})});
function fixture(directory = false) {
  const linkTarget = directory ? '/real' : '/real/input', raw = Buffer.from(linkTarget), resolvedTarget = linkTarget;
  const link = {originalPath: '/alias', linkTarget, bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex'), readlinkBase64: raw.toString('base64'),
    linkIdentity: identity(0o120777, raw.length), resolvedTarget, targetIdentity: identity(directory ? 0o040755 : 0o100644)};
  const lexical = directory ? '/alias/input' : '/alias';
  const snapshot = {schemaVersion: 1, kind: 'sdk-readlink-originals', links: [link], inputBindings: {[lexical]: {resolvedTarget: '/real/input', targetIdentity: identity(0o100644)}}};
  return {before: structuredClone(snapshot), after: structuredClone(snapshot), inputRows: [{originalPath: '/real/input', bytes: 4, mode: 0o644, sha256: 'a'.repeat(64)}], legacyLinks: [{originalPath: '/alias', linkTarget, bytes: raw.length, sha256: link.sha256}], check() {}};
}
describe('SDK before/after readlink originals mechanics', () => {
  it('binds actual file and directory aliases to the verified resolved input', () => {
    for (const directory of [false, true]) {
      const result = inspectSdkSymlinkOriginals(fixture(directory));
      expect(result.bindings).toHaveLength(1); expect(result.unresolved).toEqual([]); expect(result.linkCount).toBe(1);
    }
  });
  it('checks actual filesystem readlink and target identities without dereferencing in the receiver', () => {
    const parent = path.resolve('.test-data/sdk-readlink-receiver'); mkdirSync(parent, {recursive: true});
    const root = mkdtempSync(path.join(parent, 'actual-'));
    try {
      mkdirSync(path.join(root, 'real')); writeFileSync(path.join(root, 'real/input'), 'data');
      symlinkSync('real', path.join(root, 'alias'));
      const linkPath = path.join(root, 'alias'), target = readlinkSync(linkPath), raw = Buffer.from(target);
      const statIdentity = (name: string, link = false) => {
        const value = link ? lstatSync(name, {bigint: true}) : statSync(name, {bigint: true});
        const fields = ['dev', 'ino', 'mode', ...(value.isDirectory() ? [] : ['size', 'mtimeNs', 'ctimeNs', 'nlink'])];
        return Object.fromEntries(fields.map(key => ['st_' + key.replace('Ns', '_ns'), String((value as any)[key])]));
      };
      const row = {originalPath: linkPath, linkTarget: target, bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex'),
        readlinkBase64: raw.toString('base64'), linkIdentity: statIdentity(linkPath, true), resolvedTarget: realpathSync(linkPath), targetIdentity: statIdentity(linkPath)};
      const lexical = path.join(root, 'alias/input'), resolved = realpathSync(lexical);
      const snapshot = {schemaVersion: 1, kind: 'sdk-readlink-originals', links: [row], inputBindings: {[lexical]: {resolvedTarget: resolved, targetIdentity: statIdentity(lexical)}}};
      const result = inspectSdkSymlinkOriginals({before: snapshot, after: structuredClone(snapshot), inputRows: [{originalPath: resolved, bytes: 4, mode: Number(statSync(resolved).mode) & 0o7777, sha256: createHash('sha256').update('data').digest('hex')}], legacyLinks: [row], check() {}});
      expect(result.bindings).toHaveLength(1); expect(result.unresolved).toEqual([]);
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
  it('rejects byte, identity, missing-before, input and chain substitutions', () => {
    const mutations: ((x: ReturnType<typeof fixture>) => void)[] = [
      x => { x.after.links[0]!.readlinkBase64 = 'AAAA'; },
      x => { x.after.links[0]!.linkIdentity.st_ino = '3'; },
      x => { x.before.links = []; },
      x => { x.after.links[0]!.resolvedTarget = '/other'; },
      x => { x.inputRows[0]!.bytes = 5; },
      x => { x.after.inputBindings['/alias']!.resolvedTarget = '/other'; },
      x => { x.after.links = []; },
      x => { x.after.inputBindings = {}; },
      x => { x.legacyLinks[0]!.linkTarget = '/other'; },
    ];
    for (const mutate of mutations) { const value = fixture(); mutate(value); expect(() => inspectSdkSymlinkOriginals(value)).toThrow(); }
  });
  it('retains newly observed unselected links as explicit unresolved facts', () => {
    const value = fixture(); value.before.links = []; value.before.inputBindings = {}; value.after.inputBindings = {};
    expect(inspectSdkSymlinkOriginals(value).unresolved).toEqual([{path: '/alias', reason: 'symlink-original-unavailable-before-compile'}]);
  });
});
