import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';
const cwd = path.resolve(__dirname, '../..');
it('retains every declared orig component/debian byte and rejects missing, extra, changed and linked originals', () => {
  const code = `import importlib.util,pathlib,tempfile,hashlib,json,shutil
s=importlib.util.spec_from_file_location('d','qlever/scripts/sdk-debian-source-materials.py');d=importlib.util.module_from_spec(s);s.loader.exec_module(d)
base=pathlib.Path(tempfile.mkdtemp(prefix='debian-source-',dir='.test-data')).resolve();results=[]
try:
 for action in ['complete','missing','extra','changed','linked','budget','race','deadline','added-late','root-replaced','read-dsc-changed','read-archive-changed']:
  root=base/action;root.mkdir();files={'example_1.0.orig.tar.xz':b'original main bytes','example_1.0.orig-data.tar.xz':b'original component bytes','example_1.0-2.debian.tar.xz':b'debian source bytes'}
  for name,data in files.items():(root/name).write_bytes(data)
  rows=''.join(' '+hashlib.sha256(data).hexdigest()+' '+str(len(data))+' '+name+'\\n' for name,data in files.items())
  (root/'example_1.0-2.dsc').write_text('Format: 3.0 (quilt)\\nSource: example\\nVersion: 1.0-2\\nChecksums-Sha256:\\n'+rows)
  member=root/'example_1.0.orig-data.tar.xz'
  if action=='missing':member.unlink()
  if action=='extra':(root/'unregistered.tar.xz').write_bytes(b'extra')
  if action=='changed':member.write_bytes(b'different bytes')
  if action=='linked':member.unlink();member.symlink_to(root/'example_1.0.orig.tar.xz')
  calls=[0]
  def check():
   calls[0]+=1
   if calls[0]==3 and action=='race':
    p=root/'example_1.0-2.dsc';p.write_bytes(p.read_bytes()+b'\\n')
   if calls[0]==3 and action=='deadline':raise TimeoutError('actual cumulative deadline reached')
   if calls[0]==5 and action=='added-late':(root/'unexpected.original').write_bytes(b'new member after initial closed set')
   if calls[0]==5 and action=='root-replaced':
    root.rename(base/'retained-old-root');root.mkdir()
   if calls[0]==5 and action=='read-dsc-changed':
    p=root/'example_1.0-2.dsc';p.write_bytes(p.read_bytes()+b'\\n')
   if calls[0]==7 and action=='read-archive-changed':
    p=root/'example_1.0-2.debian.tar.xz';p.write_bytes(b'changed after read')
  try:
   result=d.verify_source_directory(root,'example','1.0-2',10 if action=='budget' else 65536,check_budget=check)
   assert len(result['files'])==3 and result['pending'];results.append('complete-mechanical-set')
  except (ValueError,OSError):results.append('rejected')
 print(json.dumps(results))
finally:shutil.rmtree(base)`;
  expect(JSON.parse(execFileSync('python3', ['-c', code], {cwd, encoding: 'utf8'}))).toEqual(['complete-mechanical-set', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
});
it('selects exact Debian source versions through actual ownership and keeps unowned generated files unresolved', () => {
  const code = `import importlib.util,json
s=importlib.util.spec_from_file_location('d','qlever/scripts/sdk-debian-source-materials.py');d=importlib.util.module_from_spec(s);s.loader.exec_module(d)
ledger=b'libc6:amd64\\t2.36-1+b1\\tglibc\\t2.36-1\\ngcc-12\\t12.2.0-14\\tgcc-12\\t12.2.0-14\\n'
r=d.required_sources(['/usr/include/stdio.h','/usr/bin/gcc-12','/build/generated.h'],{'libc6:amd64':b'/usr/include/stdio.h\\n','gcc-12':b'/usr/bin/gcc-12\\n'},ledger)
assert r['unresolvedInputs']==['/build/generated.h'];assert r['packages']==[{'name':'gcc-12','version':'12.2.0-14'},{'name':'glibc','version':'2.36-1'}]
try:d.parse_source_ledger(ledger+ledger);raise AssertionError('duplicate accepted')
except ValueError:pass
print('actual-owner-source-version-bound;generated-unresolved')`;
  expect(execFileSync('python3', ['-c', code], {cwd, encoding: 'utf8'}).trim()).toBe('actual-owner-source-version-bound;generated-unresolved');
});
it('does not treat clear-signed armor as signature verification and rejects incomplete source descriptions', () => {
  const code = `import importlib.util,json
s=importlib.util.spec_from_file_location('d','qlever/scripts/sdk-debian-source-materials.py');d=importlib.util.module_from_spec(s);s.loader.exec_module(d)
body='Format: 3.0 (native)\\nSource: example\\nVersion: 1:1.0\\nChecksums-Sha256:\\n '+'a'*64+' 2 example_1.0.tar.xz\\n'
raw=('-----BEGIN PGP SIGNED MESSAGE-----\\nHash: SHA256\\n\\n'+body+'-----BEGIN PGP SIGNATURE-----\\nnot-a-verified-signature\\n-----END PGP SIGNATURE-----\\n').encode()
r=d.parse_dsc(raw);assert r['clearSignedOriginalPresent'] and r['pending']
for value in [body.replace('example_1.0.tar.xz','../escape'),body+'Source: other\\n',body+'sOuRcE: other\\n',body.replace(' 2 example',' 0 example'),body.replace('3.0 (native)','3.0 (quilt)')]:
 try:d.parse_dsc(value.encode());raise AssertionError('malformed description accepted')
 except ValueError:pass
print('armor-is-not-authority;malformed-rejected')`;
  expect(execFileSync('python3', ['-c', code], {cwd, encoding: 'utf8'}).trim()).toBe('armor-is-not-authority;malformed-rejected');
});

it('uses the same bounded parser from the fixed isolated controller CLI', () => {
  const output = execFileSync('/usr/bin/python3', ['-I', '-S', '-B', 'qlever/scripts/sdk-debian-source-materials.py', '--parse-ledger'], {cwd, input: 'gcc-12\t12.2.0-14\tgcc-12\t12.2.0-14\n', encoding: 'utf8'});
  expect(JSON.parse(output)['gcc-12'].source).toEqual({name: 'gcc-12', version: '12.2.0-14'});
});
