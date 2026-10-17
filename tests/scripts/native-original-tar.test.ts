import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { observeRegisteredNativeTar } from '../../scripts/lib/independent-admission/native-tar-observation';
import type { CollectedNativeOriginalsView } from '../../scripts/lib/independent-admission/native-originals';
import path from 'node:path';
describe('streamed native source tar original objects', () => {
  it('keeps internal symlink objects and rejects external targets without reading them', async () => {
    const parent = path.resolve('.test-data/native-original-tar'); mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(path.join(parent, 'tiny-'));
    try {
      const result = execFileSync('/usr/bin/python3', ['-I', '-B', '-c', `import importlib.util,sys,pathlib,tarfile,zipfile,io,json,hashlib
s=importlib.util.spec_from_file_location('scanner',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);root=pathlib.Path(sys.argv[2])
def make(target,name):
 tar=root/(name+'.tar')
 with tarfile.open(tar,'w') as archive:
  b=b'actual native source';f=tarfile.TarInfo('engine/CMakeLists.txt');f.size=len(b);archive.addfile(f,io.BytesIO(b))
  l=tarfile.TarInfo('engine/config.cmake');l.type=tarfile.SYMTYPE;l.linkname=target;l.mode=511;archive.addfile(l)
 with zipfile.ZipFile(root/(name+'.zip'),'w') as archive:archive.write(tar,'native-materials/source-kit.tar')
 return root/(name+'.zip')
good=make('CMakeLists.txt','good');rows=m.scan(good,'native-materials/source-kit.tar','source')
assert rows[1]['type']=='symlink' and rows[1]['linkTarget']=='CMakeLists.txt' and rows[1]['sha256']==hashlib.sha256(b'CMakeLists.txt').hexdigest()
for target in ['../../secret','/etc/passwd','config.cmake']:
 bad=make(target,'bad-'+str(len(target)))
 try:m.scan(bad,'native-materials/source-kit.tar','source')
 except ValueError:pass
 else:raise AssertionError('unsafe native link accepted')
try:m.scan(good,'native-materials/source-kit.tar','runtime')
except (ValueError,tarfile.ReadError):pass
else:raise AssertionError('source tar treated as runtime')
print(json.dumps({'members':len(rows),'unsafeTargetsRejected':3}))`, path.resolve('scripts/lib/independent-admission/native-original-tar.py'), root], { encoding: 'utf8' });
      expect(JSON.parse(result)).toEqual({ members: 2, unsafeTargetsRejected: 3 });
      // A structural byte view exercises only the fixed observer process. It
      // cannot pass the native context's private capability lookup.
      const archive = path.join(root, 'good.zip'), sha = createHash('sha256').update(readFileSync(archive)).digest('hex');
      const member = 'native-materials/source-kit.tar';
      const view = { members: [{ path: member, bytes: statSync(path.join(root, 'good.tar')).size }],
        withArchiveFile: async (operation: any) => operation({ path: archive, identity: { bytes: statSync(archive).size, sha256: sha } }),
      } as unknown as CollectedNativeOriginalsView;
      const observed = await observeRegisteredNativeTar(view, member, 'source');
      expect(observed).toHaveLength(2);
      expect(observed[1].linkTarget).toBe('CMakeLists.txt');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
