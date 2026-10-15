import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyApiSourcekits } from '../scripts/sourcekit';

test('source-only archives verify exact streamed bytes and enforce separate aggregate bounds without extraction', () => {
  const base = path.resolve('.test-data/api-sourcekits'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'case-'));
  const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
  const indexPath = path.join(root, 'index.json'), archive = path.join(root, 'source.tgz');
  const contents = 'original source bytes\n';
  const index = { schemaVersion: 1, role: 'source-only', rootName: 'source', files: [{ path: 'original.ts', sha256: hash(contents), sizeBytes: Buffer.byteLength(contents), mode: 0o644 }] };
  function make(kind = 'valid', body = contents) {
    writeFileSync(indexPath, JSON.stringify({ ...index, files: [{ ...index.files[0], sizeBytes: Buffer.byteLength(body), sha256: hash(body) }] }));
    const result = spawnSync('python3', ['-c', `import sys,tarfile,io,json,gzip
index,archive,kind,body=sys.argv[1:]
raw=open(index,'rb').read()
with tarfile.open(archive,'w:gz',format=tarfile.USTAR_FORMAT) as t:
 for name,data in [('source/source-kit.json',raw),('source/original.ts',body.encode())]:
  info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o644
  if kind=='traversal' and name.endswith('original.ts'):info.name='source/../escaped'
  if kind=='symlink' and name.endswith('original.ts'):info.type=tarfile.SYMTYPE;info.linkname='/tmp/escaped';info.size=0
  if kind=='mode' and name.endswith('original.ts'):info.mode=0o755
  if kind=='bytes' and name.endswith('original.ts'):data=b'x'*len(data)
  t.addfile(info,io.BytesIO(data))
  if kind=='duplicate' and name.endswith('original.ts'):t.addfile(info,io.BytesIO(data))
raw=gzip.decompress(open(archive,'rb').read())
if kind=='minimal':
 with tarfile.open(fileobj=io.BytesIO(raw)) as t:
  last=t.getmembers()[-1];end=last.offset_data+((last.size+511)//512)*512
 open(archive,'wb').write(gzip.compress(raw[:end]+bytes(1024)))
if kind=='append-tar':open(archive,'wb').write(gzip.compress(raw+raw))
if kind=='append-gzip':open(archive,'ab').write(gzip.compress(raw))
if kind=='zero-tail':open(archive,'wb').write(gzip.compress(raw+bytes(40960)))
if kind=='nonzero-tail':open(archive,'wb').write(gzip.compress(raw+b'x'))
if kind=='pax-bomb':
 info=tarfile.TarInfo('source/extended');info.type=tarfile.XHDTYPE;info.size=64*1024*1024
 with gzip.open(archive,'wb') as stream:
  stream.write(info.tobuf(format=tarfile.USTAR_FORMAT))
  for _ in range(64):stream.write(bytes(1024*1024))
`, indexPath, archive, kind, body], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return { archive, index: indexPath, sha256: hash(readFileSync(archive)) };
  }
  try {
    const kit = make(); const before = readdirSync(root).sort();
    const result = verifyApiSourcekits([kit], 10);
    assert.equal(result.sourceMembers, 2);
    assert.equal(result.sourceExpandedBytes, Buffer.byteLength(JSON.stringify(index)) + Buffer.byteLength(contents));
    assert.deepEqual(readdirSync(root).sort(), before);
    assert.throws(() => verifyApiSourcekits([kit], 2 * 1024 ** 3), /aggregate expanded/);
    assert.throws(() => verifyApiSourcekits([], 0), /required/);
    assert.throws(() => verifyApiSourcekits([{ ...kit, sha256: '0'.repeat(64) }], 0), /archive drift/);
    for (const kind of ['traversal', 'symlink', 'mode', 'bytes', 'duplicate']) assert.throws(() => verifyApiSourcekits([make(kind)], 0), /verification failed/);
    for (const kind of ['append-tar', 'append-gzip', 'zero-tail', 'nonzero-tail']) assert.throws(() => verifyApiSourcekits([make(kind)], 0), /tail|second gzip/);
    assert.throws(() => verifyApiSourcekits([make('pax-bomb')], 0), /before body: decoded=512/);
    assert.equal(verifyApiSourcekits([make('minimal', 'x')], 0).sourceMembers, 2);
    assert.equal(verifyApiSourcekits([make('valid', 'x')], 0).sourceMembers, 2);
    const boundKit = make();
    writeFileSync(indexPath, JSON.stringify({ ...index, files: Array.from({ length: 100000 }, (_, i) => ({ ...index.files[0], path: 'file-' + i, sizeBytes: 0, sha256: hash('') })) }));
    assert.throws(() => verifyApiSourcekits([boundKit], 0), /aggregate source member bound/);
    writeFileSync(indexPath, JSON.stringify({ ...index, role: 'runtime' }));
    assert.throws(() => verifyApiSourcekits([boundKit], 0), /unknown sourcekit role/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
