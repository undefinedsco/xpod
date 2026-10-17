import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { inspectSdkInputOwnership } from '../../scripts/lib/independent-admission/qlever-sdk-inputs';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function sample(change?: (files: Record<string, string>) => void) {
  const files: Record<string, string> = {
    '/usr/bin/gcc-12': 'actual-compiler-original'.repeat(4000),
    '/var/lib/dpkg/info/gcc-12:amd64.list': '/usr/bin/gcc-12\n/usr/bin/alias-not-observed\n',
    '/build/generated.o': 'actual-generated-object',
    ['/opt/qlever/' + 'long-source-directory/'.repeat(7) + 'input.cc']: 'actual-unowned-source',
  };
  const rows = Object.entries(files).map(([name, value]) => ({originalPath: name, archivePath: name.slice(1), bytes: Buffer.byteLength(value), sha256: hash(Buffer.from(value)), mode: 0o644,
    role: name.endsWith('.list') ? 'installed-metadata' : name.endsWith('.o') ? 'compile-output' : 'observed-input'}));
  const before = Object.fromEntries(rows.filter(row => row.role === 'observed-input').map(row => [row.originalPath, {bytes: row.bytes, sha256: row.sha256, mode: row.mode}]));
  change?.(files);
  const archive = execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', 'import sys,json,tarfile,io\nf=json.load(sys.stdin)\nwith tarfile.open(fileobj=sys.stdout.buffer,mode="w|",format=tarfile.PAX_FORMAT) as t:\n for n,v in f.items():\n  b=v.encode();i=tarfile.TarInfo(n[1:]);i.size=len(b);i.mode=0o644;t.addfile(i,io.BytesIO(b))'], {input: JSON.stringify(files)});
  const calls: number[] = [];
  const input = {before, after: {schemaVersion: 1, files: rows, packageOwnershipOriginals: ['/var/lib/dpkg/info/gcc-12:amd64.list']},
    shards: [{path: 'inner/domains/inputs-0.tar', bytes: archive.length, sha256: hash(archive)}],
    ledger: {'gcc-12:amd64': {binaryVersion: '12.2.0-14+b1', source: {name: 'gcc-12', version: '12.2.0-14'}}},
    readRange: (_name: string, offset: number, length: number) => { expect(length).toBeLessThanOrEqual(65536); calls.push(offset); return archive.subarray(offset, offset + length); }, check() { /* fixture cumulative deadline */ }};
  return {input, archive, calls};
}
describe('actual SDK tar → installed ownership → exact source tuple', () => {
  it('scans real Python PAX originals, preserves binNMU source version and separates generated/unowned input', () => {
    const {input, calls} = sample(), result = inspectSdkInputOwnership(input);
    expect(result.requiredSources).toEqual([{name: 'gcc-12', version: '12.2.0-14'}]);
    expect(result.inputRows.find(row => row.path === '/usr/bin/gcc-12')?.owners).toEqual([{binary: 'gcc-12:amd64', binaryVersion: '12.2.0-14+b1', source: {name: 'gcc-12', version: '12.2.0-14'}}]);
    expect(result.unresolvedInputs.map(row => row.reason)).toContain('generated-build-output-source-causality-unverified');
    expect(result.unresolvedInputs.map(row => row.reason)).toContain('non-Debian-input-source-authority-unresolved');
    expect(result.inputRows.some(row => row.path === '/usr/bin/alias-not-observed')).toBe(false);
    expect(calls).toEqual(Array.from({length: Math.ceil(input.shards[0]!.bytes / 65536)}, (_, index) => index * 65536));
  });

  it('retains after-only symlink aliases as unresolved and checks their actual target bytes', () => {
    const {input} = sample(), target = 'gcc-12';
    const after = {...input.after, symlinkOriginalTargets: [{originalPath: '/usr/bin/cc', linkTarget: target, bytes: Buffer.byteLength(target), sha256: hash(Buffer.from(target))}]};
    const result = inspectSdkInputOwnership({...input, after});
    expect(result.unresolvedSymlinkOriginalTargets).toEqual([{path: '/usr/bin/cc', target, reason: 'symlink-original-observed-after-compile-only'}]);
    after.symlinkOriginalTargets[0]!.sha256 = '0'.repeat(64);
    expect(() => inspectSdkInputOwnership({...input, after})).toThrow(/symlink target/);
  });
  it('rejects changed source bytes, extra or missing actual tar members and changed before image', () => {
    expect(() => inspectSdkInputOwnership(sample(files => { files['/usr/bin/gcc-12'] = 'changed-compiler'; }).input)).toThrow(/member universe|bytes differ/);
    expect(() => inspectSdkInputOwnership(sample(files => { files['/unexpected'] = 'extra'; }).input)).toThrow(/member universe/);
    expect(() => inspectSdkInputOwnership(sample(files => { delete files['/usr/bin/gcc-12']; }).input)).toThrow(/incomplete/);
    const {input} = sample(); input.before['/usr/bin/gcc-12']!.sha256 = '0'.repeat(64);
    expect(() => inspectSdkInputOwnership(input)).toThrow(/before\/after/);
  });
  it('refuses missing actual ledger authority, forged shard SHA, symlink-type and unregistered ownership', () => {
    const missing = sample(); missing.input.ledger = {} as typeof missing.input.ledger;
    expect(() => inspectSdkInputOwnership(missing.input)).toThrow(/binary absent/);
    const forged = sample(); forged.input.shards[0]!.sha256 = '0'.repeat(64);
    expect(() => inspectSdkInputOwnership(forged.input)).toThrow(/shard hash/);
    const linked = sample(); linked.archive[156] = 50; linked.archive.fill(32, 148, 156);
    const checksum = [...linked.archive.subarray(0, 512)].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0'); linked.archive.write(checksum + '\0 ', 148);
    linked.input.shards[0]!.sha256 = hash(linked.archive);
    expect(() => inspectSdkInputOwnership(linked.input)).toThrow(/member universe/);
    const unknown = sample(); unknown.input.after.packageOwnershipOriginals.push('/var/lib/dpkg/info/unregistered.list');
    expect(() => inspectSdkInputOwnership(unknown.input)).toThrow(/registered dpkg/);
  });
});
