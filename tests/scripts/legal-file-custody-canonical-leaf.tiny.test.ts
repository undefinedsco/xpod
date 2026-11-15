/** Retained regular-original custody, on a real temporary filesystem.
 *
 * These are INVARIANT tests for `captureLegalFileIdentity`: the retained
 * `realPath` must be a pure function of the requested path (canonical parent +
 * requested leaf), and every real mutation must still be refused. They do not
 * claim to reproduce the runtime's hardlink-alias behaviour; that is exercised
 * separately in the subprocess probe, because it depends on host runtime
 * behaviour that cannot be forced in-process.
 */
import {test, expect} from 'bun:test';
import {mkdtemp, writeFile, link, unlink, rm, chmod, rename, utimes, symlink, mkdir, realpath} from 'node:fs/promises';
import {lstatSync} from 'node:fs';
import path from 'node:path';
import {captureLegalFileIdentity, assertLegalFileIdentity} from '../../scripts/lib/independent-admission/legal-file-custody';

const root = path.resolve('.test-data/legal-file-custody-canonical');
async function dir(): Promise<string> {
  await mkdir(root, {recursive: true});
  return await realpath(await mkdtemp(path.join(root, 'case-')));
}

test('retained realPath is canonical parent + requested leaf', async () => {
  const d = await dir();
  try {
    const file = path.join(d, 'audit.original');
    await writeFile(file, 'bytes');
    const id = captureLegalFileIdentity(file);
    expect(id.realPath).toBe(path.join(d, 'audit.original'));
    expect(id.realPath).toBe(file);
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('a hardlink sibling is never substituted for the requested leaf', async () => {
  const d = await dir();
  try {
    const file = path.join(d, 'python3.11'), alias = path.join(d, 'git');
    await writeFile(file, '#!/bin/sh\n'); await link(file, alias);
    const a = lstatSync(file, {bigint: true}), b = lstatSync(alias, {bigint: true});
    expect(b.ino).toBe(a.ino); expect(b.dev).toBe(a.dev);   // genuinely the same inode
    const id = captureLegalFileIdentity(file);
    expect(id.realPath).toBe(file);
    expect(id.realPath).not.toBe(alias);
    expect(id.nlink).toBe(2n);                               // shared inode count observed
    expect(captureLegalFileIdentity(alias).realPath).toBe(alias);
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('all structural fields are captured and re-asserted', async () => {
  const d = await dir();
  try {
    const file = path.join(d, 'fields.original');
    await writeFile(file, 'fixed original');
    const id = captureLegalFileIdentity(file);
    for (const key of ['dev', 'ino', 'size', 'ctimeNs', 'mtimeNs', 'mode', 'nlink'] as const)
      expect(typeof (id as any)[key]).toBe('bigint');
    expect(() => assertLegalFileIdentity(id)).not.toThrow();
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('in-place bytes and link-count changes are refused', async () => {
  const d = await dir();
  try {
    const file = path.join(d, 'a.original'), alias = path.join(d, 'a.alias');
    await writeFile(file, 'verified inert original'); await link(file, alias);
    const original = captureLegalFileIdentity(file);
    expect(original.nlink).toBe(2n);
    await writeFile(alias, 'modified inert original');
    expect(() => assertLegalFileIdentity(original)).toThrow('custody changed');
    const modified = captureLegalFileIdentity(file);
    await unlink(alias);
    expect(() => assertLegalFileIdentity(modified)).toThrow('custody changed');
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('mode change is refused', async () => {
  const d = await dir();
  try {
    const file = path.join(d, 'mode.original');
    await writeFile(file, 'x');
    const id = captureLegalFileIdentity(file);
    await chmod(file, 0o400);
    expect(() => assertLegalFileIdentity(id)).toThrow('custody changed');
    await chmod(file, 0o600);
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('same-size inode replacement is refused', async () => {
  const d = await dir();
  try {
    const file = path.join(d, 'audit.original');
    await writeFile(file, 'fixed original');
    const original = captureLegalFileIdentity(file);
    await writeFile(path.join(d, 'replacement'), 'other original');
    await rename(path.join(d, 'replacement'), file);
    await utimes(file, Number(original.mtimeNs) / 1e9, Number(original.mtimeNs) / 1e9);
    expect(() => assertLegalFileIdentity(original)).toThrow('custody changed');
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('leaf symlinks and non-regular files are refused', async () => {
  const d = await dir();
  try {
    const target = path.join(d, 'real.original'), leaf = path.join(d, 'link.original');
    await writeFile(target, 'bytes');
    await symlink('real.original', leaf);
    expect(() => captureLegalFileIdentity(leaf)).toThrow('regular original file required');
    // A directory is refused earlier, by the shared resolver's own regularity
    // guard; either refusal is fail-closed and no identity is issued.
    expect(() => captureLegalFileIdentity(d)).toThrow(/regular (original|executable) file required|regular executable required/u);
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('a valid relative path resolves to the same absolute identity', async () => {
  const d = await dir();
  try {
    const file = path.join(d, 'relative.original');
    await writeFile(file, 'relative bytes');
    const absolute = captureLegalFileIdentity(file);
    const rel = captureLegalFileIdentity(path.relative(process.cwd(), file));
    expect(path.isAbsolute(rel.realPath)).toBe(true);
    expect(rel.realPath).toBe(absolute.realPath);
    expect(rel.dev).toBe(absolute.dev);
    expect(rel.ino).toBe(absolute.ino);
    expect(rel.size).toBe(absolute.size);
    expect(() => assertLegalFileIdentity(rel)).not.toThrow();
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('a missing file fails closed', async () => {
  const d = await dir();
  try {
    expect(() => captureLegalFileIdentity(path.join(d, 'absent.original'))).toThrow();
  } finally { await rm(d, {recursive: true, force: true}); }
});

test('parent directory replacement is refused', async () => {
  const d = await dir();
  try {
    const inner = path.join(d, 'inner'); await mkdir(inner);
    const file = path.join(inner, 'a.original');
    await writeFile(file, 'bytes');
    const original = captureLegalFileIdentity(file);
    await rm(inner, {recursive: true, force: true});
    await mkdir(inner);
    await writeFile(file, 'bytes');
    expect(() => assertLegalFileIdentity(original)).toThrow('custody changed');
  } finally { await rm(d, {recursive: true, force: true}); }
});
