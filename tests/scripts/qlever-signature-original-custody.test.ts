import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {expect, it, vi} from 'vitest';
import {hashSignatureControllerFile, readSignatureOriginal, assertSignatureOriginalSet} from '../../scripts/lib/independent-admission/qlever-signature-original-custody';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function temporary(run: (root: string) => void) {
  const parent = path.resolve('.test-data/signature-custody-tests'); fs.mkdirSync(parent, {recursive: true});
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  try {run(root);} finally {fs.rmSync(root, {recursive: true, force: true});}
}
it('stops a growing executable at its initial byte count instead of reading to a moving EOF', () => temporary(root => {
  const file = path.join(root, 'gpgv'), original = Buffer.alloc(128 * 1024, 65); fs.writeFileSync(file, original); let checks = 0;
  expect(() => hashSignatureControllerFile(file, () => {if (++checks === 2) fs.appendFileSync(file, Buffer.alloc(4 * 1024 ** 2));})).toThrow('grew beyond initial byte budget');
  expect(checks).toBe(3);
}));
it('rejects a tiny raw reference backed by a larger file before opening or allocating its contents', () => temporary(root => {
  const file = path.join(root, 'stdout.raw'); fs.writeFileSync(file, Buffer.alloc(128 * 1024));
  const open = vi.spyOn(fs, 'openSync');
  try {expect(() => readSignatureOriginal(file, {bytes: 1, sha256: hash(Buffer.from('x'))}, 65536, () => {})).toThrow('actual size'); expect(open).not.toHaveBeenCalled();}
  finally {open.mockRestore();}
}));
it('retains first verified raw/body/key identities and rejects changes before final enumeration', () => {
  for (const changed of ['stdout.raw', 'signed-body.original', 'official-key.asc']) temporary(root => {
    fs.mkdirSync(path.join(root, 'empty-home'), {mode: 0o700});
    const identities = ['stdout.raw', 'signed-body.original', 'official-key.asc'].map(name => {
      const bytes = Buffer.from('verified original ' + name), file = path.join(root, name); fs.writeFileSync(file, bytes);
      return readSignatureOriginal(file, {bytes: bytes.length, sha256: hash(bytes)}, 65536, () => {}).identity;
    });
    assertSignatureOriginalSet(root, identities);
    const changedFile = path.join(root, changed); fs.writeFileSync(changedFile, Buffer.alloc(Number(identities.find(row => row.path === changedFile)!.size), 66));
    expect(() => assertSignatureOriginalSet(root, identities)).toThrow('custody changed');
  });
});
it('seals exactly the retained roles without adopting extras, missing originals or homedir substitution', () => temporary(root => {
  const home = path.join(root, 'empty-home'); fs.mkdirSync(home); const file = path.join(root, 'raw'), bytes = Buffer.from('original'); fs.writeFileSync(file, bytes);
  const identity = readSignatureOriginal(file, {bytes: bytes.length, sha256: hash(bytes)}, 65536, () => {}).identity;
  assertSignatureOriginalSet(root, [identity]);
  fs.writeFileSync(path.join(root, 'extra'), 'unregistered'); expect(() => assertSignatureOriginalSet(root, [identity])).toThrow('role set'); fs.unlinkSync(path.join(root, 'extra'));
  fs.writeFileSync(path.join(home, 'unexpected'), 'config'); expect(() => assertSignatureOriginalSet(root, [identity])).toThrow('empty home'); fs.unlinkSync(path.join(home, 'unexpected'));
  fs.unlinkSync(file); expect(() => assertSignatureOriginalSet(root, [identity])).toThrow('role set');
}));
it('retains the actual existing supervisor receipt and closed dual raw identities', async () => {
  const parent = path.resolve('.test-data/signature-custody-tests'); fs.mkdirSync(parent, {recursive: true});
  const root = fs.mkdtempSync(path.join(parent, 'supervised-'));
  const {runPublicationCommand} = createRequire(import.meta.url)('../../scripts/lib/afs-publication-command.cjs') as {
    runPublicationCommand(command: string, args: string[], options: object): Promise<{raw: {path: string; bytes: number; sha256: string}[]}>;
  };
  try {
    fs.mkdirSync(path.join(root, 'empty-home'));
    const outcome = await runPublicationCommand(process.execPath, ['--version'], {cwd: root, evidence: root, env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}, label: 'signature-custody-probe', timeoutMs: 5000, rawLimit: 65536});
    const identities = outcome.raw.map(row => readSignatureOriginal(path.join(root, row.path), row, 65536, () => {}).identity);
    const receipt = Buffer.from(JSON.stringify(outcome, null, 2) + '\n');
    identities.push(readSignatureOriginal(path.join(root, 'signature-custody-probe.receipt.json'), {bytes: receipt.length, sha256: hash(receipt)}, 65536, () => {}).identity);
    assertSignatureOriginalSet(root, identities); expect(identities).toHaveLength(3);
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});
