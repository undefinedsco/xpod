import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile, link, unlink, chmod, rm, rename, utimes } from 'node:fs/promises';
import { captureLegalFileIdentity, assertLegalFileIdentity } from '../../scripts/lib/independent-admission/legal-file-custody';
import { assertLegalOriginalCustody } from '../../scripts/lib/independent-admission/legal-original-custody';
test('actual original identity accepts observed hardlink count two and rejects subsequent mutation', async () => {
  await mkdir('.test-data/legal-original-custody', { recursive: true });
  const directory = await mkdtemp('.test-data/legal-original-custody/tiny-');
  const filename = directory + '/audit.original', alias = directory + '/download.original';
  try {
    await writeFile(filename, 'verified inert original'); await link(filename, alias);
    const original = captureLegalFileIdentity(filename);
    expect(original.nlink).toBe(2n);
    assertLegalFileIdentity(original);
    await writeFile(alias, 'modified inert original');
    expect(() => assertLegalFileIdentity(original)).toThrow('custody changed');
    const modified = captureLegalFileIdentity(filename);
    await unlink(alias);
    expect(() => assertLegalFileIdentity(modified)).toThrow('custody changed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('same size inode replacement and mode changes cannot reuse a verified original identity', async () => {
  await mkdir('.test-data/legal-original-custody', { recursive: true });
  const directory = await mkdtemp('.test-data/legal-original-custody/tiny-');
  const filename = directory + '/audit.original';
  try {
    await writeFile(filename, 'fixed original');
    const original = captureLegalFileIdentity(filename);
    await writeFile(directory + '/replacement', 'other original');
    await rename(directory + '/replacement', filename);
    await utimes(filename, Number(original.mtimeNs) / 1e9, Number(original.mtimeNs) / 1e9);
    expect(() => assertLegalFileIdentity(original)).toThrow('custody changed');
    const replacement = captureLegalFileIdentity(filename);
    await chmod(filename, 0o400);
    expect(() => assertLegalFileIdentity(replacement)).toThrow('custody changed');
  } finally { await chmod(filename, 0o600).catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
test('serialized snapshots, views and callbacks never become legal original capabilities', () => {
  expect(() => assertLegalOriginalCustody({ status: 'verified', assertCurrent() { throw Error('untrusted callback'); } })).toThrow('unknown private capability');
  expect(() => assertLegalOriginalCustody(undefined)).toThrow('unknown private capability');
});
