import {test, expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectDebianSourceArchiveCore} from '../../scripts/lib/independent-admission/qlever-debian-source-archive-core';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const parent = 'inner/debian-source/package-0000', name = 'sqlite3_1.0.orig.tar.xz';
  const archive = Buffer.alloc(75650, 120), debian = Buffer.from('debian source patch');
  const dsc = Buffer.from(`Format: 3.0 (quilt)\nSource: sqlite3\nVersion: 1.0-1\nChecksums-Sha256:\n ${hash(archive)} ${archive.length} ${name}\n ${hash(debian)} ${debian.length} sqlite3_1.0-1.debian.tar.xz\n`);
  const rows = [{path: parent + '/sqlite3_1.0-1.dsc', bytes: dsc.length, sha256: hash(dsc)},
    {path: parent + '/' + name, bytes: archive.length, sha256: hash(archive)},
    {path: parent + '/sqlite3_1.0-1.debian.tar.xz', bytes: debian.length, sha256: hash(debian)}];
  const bodies = new Map([[rows[0].path, dsc], [rows[1].path, archive], [rows[2].path, debian]]), sizes: number[] = [];
  const input = {packages: [{name: 'sqlite3', version: '1.0-1', dsc: rows[0], files: [rows[1], rows[2]]}],
    allowedCoordinates: [{name: 'sqlite3', version: '1.0-1'}],
    reader: {members: rows, readOriginalRange(path: string, offset: number, length: number) {sizes.push(length); return Buffer.from(bodies.get(path)!.subarray(offset, offset + length));}},
    reference(value: any) {const row = rows.find(row => row.path === value.path); if (!row || row.bytes !== value.bytes || row.sha256 !== value.sha256) throw Error('original mismatch'); return row;},
    small(value: {path: string}) {return Buffer.from(bodies.get(value.path)!);},
    parseDsc(bytes: Buffer) {return JSON.parse(execFileSync('python3', ['-I', '-S', '-B', fileURLToPath(new URL('../../qlever/scripts/sdk-debian-source-materials.py', import.meta.url)), '--parse-dsc'], {input: bytes, timeout: 5000}).toString());},
    maximumFileBytes: 100000, maximumTotalBytes: 100000, check() {},
  };
  return {input, rows, bodies, sizes};
}
test('complete actual DSC parser + archive SHA, bounded ranges and frozen result', () => {
  const {input, sizes} = fixture(); const result = inspectDebianSourceArchiveCore(input);
  expect(result.coordinates.length).toBe(1); expect(sizes.length).toBe(3); expect(Math.max(...sizes)).toBe(65536);
  expect(Object.isFrozen(result.coordinates[0].archives)).toBe(true);
});
test('reject changed archive bytes and short physical range', () => {
  const changed = fixture(); changed.bodies.get(changed.rows[1].path)![0] ^= 1;
  expect(() => inspectDebianSourceArchiveCore(changed.input)).toThrow();
  const short = fixture(); short.input.reader.readOriginalRange = () => Buffer.alloc(0);
  expect(() => inspectDebianSourceArchiveCore(short.input)).toThrow();
});
test('reject missing, extra and repeated exact source members', () => {
  const missing = fixture(); missing.input.packages[0].files = [];
  expect(() => inspectDebianSourceArchiveCore(missing.input)).toThrow();
  const extra = fixture(); extra.rows.push({...extra.rows[1], path: 'inner/debian-source/package-0000/extra'});
  expect(() => inspectDebianSourceArchiveCore(extra.input)).toThrow();
  const duplicate = fixture(); duplicate.input.packages.push(duplicate.input.packages[0]);
  expect(() => inspectDebianSourceArchiveCore(duplicate.input)).toThrow();
});
test('reject wrong ownership coordinate and fixed file/aggregate budget overflow', () => {
  const wrong = fixture(); wrong.input.allowedCoordinates[0].version = '2';
  expect(() => inspectDebianSourceArchiveCore(wrong.input)).toThrow();
  const file = fixture(); file.input.maximumFileBytes = 100;
  expect(() => inspectDebianSourceArchiveCore(file.input)).toThrow();
  const total = fixture(); total.input.maximumTotalBytes = 100;
  expect(() => inspectDebianSourceArchiveCore(total.input)).toThrow();
});
test('propagate parent budget cancellation', () => {
  const value = fixture(), failure = Error('parent deadline'); value.input.check = () => {throw failure;};
  let actual: unknown; try {inspectDebianSourceArchiveCore(value.input);} catch (error) {actual = error;}
  expect(actual).toBe(failure);
});
