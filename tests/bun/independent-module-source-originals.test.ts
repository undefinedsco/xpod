import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectModuleSourceOriginals } from '../../scripts/lib/independent-admission/module-source-originals';
import { openBoundOriginalFile } from '../../scripts/lib/independent-admission/bound-original-file';
import { createHash } from 'node:crypto';

test('actual tiny same-ZIP source originals expose bounded fd ranges and revoke on dispose', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xpod-source-original-test-'));
  try {
    const result = spawnSync('python3', ['-c', String.raw`
import zipfile,json,hashlib,pathlib,sys
root=pathlib.Path(sys.argv[1]); archive=root/'artifact.zip'
rows={'source-materials/materials.json':b'{}','source-materials/source-0000.tar':b'actual original tar byte fixture'}
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as z:
 for name,body in rows.items():z.writestr(name,body)
spec={name:dict(path=name,bytes=len(body),sha256=hashlib.sha256(body).hexdigest(),mode=384,kind='file') for name,body in rows.items()}
print(json.dumps(dict(archiveSha256=hashlib.sha256(archive.read_bytes()).hexdigest(),inventory=dict(members=list(spec.values()),expandedBytes=sum(len(b) for b in rows.values())),producer=dict(sourceMaterials={k:v for k,v in spec['source-materials/materials.json'].items() if k in ['path','bytes','sha256']}))))
`, root], { encoding: 'utf8' });
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    const input = JSON.parse(result.stdout);
    const material = (await collectModuleSourceOriginals({ ...input, archivePath: path.join(root, 'artifact.zip') }))!;
    expect(material.readSmall('source-materials/materials.json', 8)).toEqual(Buffer.from('{}'));
    expect(material.readRange('source-materials/source-0000.tar', 0, 6)).toEqual(Buffer.from('actual'));
    expect(() => material.readRange('source-materials/source-0000.tar', 0, 65537)).toThrow('64KiB');
    material.compact();
    expect(fs.existsSync(path.join(root, 'artifact.zip'))).toBe(true);
    expect(() => material.readRange('source-materials/source-0000.tar', 0, 1)).toThrow('registered');
    const retained = (await collectModuleSourceOriginals({ ...input, archivePath: path.join(root, 'artifact.zip') }))!;
    fs.writeFileSync(path.join(root, 'artifact.zip'), 'not the retained immutable ZIP');
    expect(() => retained.compact()).toThrow('identity');
    expect(() => retained.readRange('source-materials/source-0000.tar', 0, 6)).toThrow('identity');
    retained.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('same-fd full hash reader rejects a mutated inode and incorrect initial digest', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xpod-bound-original-test-')), file = path.join(root, 'original');
  try {
    const bytes = Buffer.from('same fd original'); fs.writeFileSync(file, bytes);
    const reference = { path: 'original', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    expect(() => openBoundOriginalFile(file, { ...reference, sha256: '0'.repeat(64) })).toThrow('identity');
    const reader = openBoundOriginalFile(file, reference);
    expect(reader.readRange(0, 4)).toEqual(Buffer.from('same'));
    fs.writeFileSync(file, Buffer.alloc(bytes.length));
    expect(() => reader.readRange(0, 4)).toThrow('changed'); reader.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
