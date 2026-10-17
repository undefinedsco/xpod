import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
it('verifies real no-delta Git PACK/root-tree/preimages and rejects changed or incomplete bindings', () => {
  const parent = path.resolve('.test-data/sdk-git-source-bindings'); mkdirSync(parent, {recursive: true}); const root = mkdtempSync(path.join(parent, 'actual-'));
  try {
    const program = String.raw`
import base64,hashlib,importlib.util,io,json,pathlib,subprocess,sys,shutil,time,zipfile
root=pathlib.Path(sys.argv[1]);spec=importlib.util.spec_from_file_location('bindings',sys.argv[2]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def git(*args,data=None):return subprocess.check_output(['git',*args],cwd=root,input=data,stderr=subprocess.PIPE)
git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid')
(root/'sub').mkdir();(root/'sub/input').write_bytes(b'actual source\n');(root/'empty').write_bytes(b'');(root/'large').write_bytes(bytes(range(256))*1500);(root/'alias').symlink_to('sub/input')
git('add','sub/input','empty','alias','large');git('commit','-qm','tiny original')
commit=git('rev-parse','HEAD').decode().strip();root_tree=git('rev-parse','HEAD^{tree}').decode().strip();listing=git('ls-tree','-r','-t','-z','--full-tree',commit)
ids=[commit,root_tree];inventory=[]
for item in listing.split(b'\0'):
 if not item:continue
 header,name=item.split(b'\t',1);mode,kind,oid=header.decode().split();ids.append(oid)
 if kind=='blob':
  raw=git('cat-file','blob',oid);row=dict(path=name.decode(),mode=mode,blobOid=oid,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
  if mode=='120000':row['readlinkBase64']=base64.b64encode(raw).decode()
  inventory.append(row)
ids=list(dict.fromkeys(ids));pack=git('pack-objects','--stdout','--window=0','--depth=0',data=('\n'.join(ids)+'\n').encode())
def verify(p=pack,ls=listing,objects=ids,rows=inventory):return m.verify_git_originals(io.BytesIO(p),commit,ls,objects,rows,lambda:None)
result=verify();assert result['verified'] and result['rootTreeOid']==root_tree and result['files']==4
bad=[]
for label,run in [
 ('missing-root',lambda:verify(objects=[oid for oid in ids if oid!=root_tree])),
 ('changed-listing',lambda:verify(ls=listing.replace(b'sub/input',b'sub/other'))),
 ('wrong-preimage',lambda:verify(rows=[dict(row,sha256='0'*64) for row in inventory])),
 ('missing-path',lambda:verify(rows=inventory[:-1])),
 ('changed-readlink',lambda:verify(rows=[dict(row,readlinkBase64='AAAA') if row['mode']=='120000' else row for row in inventory])),
 ('pack-checksum',lambda:verify(p=pack[:-1]+bytes([pack[-1]^1]))),
 ('trailing-data',lambda:verify(p=pack+b'x')),
 ('delta-type',lambda:verify(p=pack[:12]+bytes([(pack[12]&143)|96])+pack[13:])),
]:
 try:run()
 except (ValueError,RuntimeError):bad.append(label)
 else:raise AssertionError('accepted '+label)
spec2=importlib.util.spec_from_file_location('projection',pathlib.Path(sys.argv[2]).with_name('sdk-git-patch-projection.py'));projection=importlib.util.module_from_spec(spec2);spec2.loader.exec_module(projection)
patch=b'diff --git a/sub/input b/sub/input\n--- a/sub/input\n+++ b/sub/input\n@@ -1 +1 @@\n-actual source\n+patched source\n'
original=m.verify_git_originals(io.BytesIO(pack),commit,listing,ids,inventory,lambda:None,{'sub/input'})
post=dict(schemaVersion=1,files=[dict(row) for row in inventory],addedPaths=[],deletedPaths=[])
for row in post['files']:
 if row['path']=='sub/input':row.update(blobOid=hashlib.sha1(b'blob 15\0patched source\n').hexdigest(),bytes=len(b'patched source\n'),sha256=hashlib.sha256(b'patched source\n').hexdigest())
args=[original['_retainedPreimages'],original['_prepatchRows'],[dict(name='reviewed.patch',bytes=patch)],post,shutil.which('git'),time.monotonic()+30,lambda:None]
projected=projection.project(*args);assert projected['verified']
for label,change in [('double-apply',lambda a:a.__setitem__(2,a[2]*2)),('false-post',lambda a:a[3]['files'][0].update(sha256='0'*64))]:
 import copy
 current=copy.deepcopy(args);change(current)
 try:projection.project(*current)
 except ValueError:bad.append(label)
 else:raise AssertionError('accepted '+label)
spec3=importlib.util.spec_from_file_location('observer',pathlib.Path(sys.argv[2]).with_name('sdk-git-source-observer.py'));observer=importlib.util.module_from_spec(spec3);spec3.loader.exec_module(observer)
zip_path=root/'original.zip';originals={}
def original(name,raw):
 path='inner/upstream-source/'+name;originals[path]=raw;return dict(path=path,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
plan=dict(addedPaths=[],deletedPaths=[],remainingMilliseconds=30000,commit=commit,rootTree=root_tree,gitExecutable=shutil.which('git'),
 treeListing=original('ls-tree.raw',listing),objectIds=original('object-ids.raw',('\n'.join(sorted(ids))+'\n').encode()),
 prepatchInventory=original('pre.json',json.dumps(dict(schemaVersion=1,files=inventory)).encode()),objectPack=original('objects.pack',pack),
 commitOriginal=original('commit.raw',git('cat-file','commit',commit)),postpatchInventory=original('post.json',json.dumps(post).encode()),
 patchSeries=original('series',b'tiny.patch\n'),reviewedSeriesBase64=base64.b64encode(b'tiny.patch\n').decode(),
 reviewedPatches=[dict(name='tiny.patch',file=original('tiny.patch',patch),base64=base64.b64encode(patch).decode())])
with zipfile.ZipFile(zip_path,'w',compression=zipfile.ZIP_DEFLATED) as z:
 for name,raw in originals.items():z.writestr(name,raw)
observed=observer.observe(str(zip_path),plan);assert observed['verified'] and observed['patchProjection']['verified']
print(json.dumps(dict(result=result,rejected=bad,projection=projected,zipObserved=observed)))
`;
    const value = JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', program, root, path.resolve('qlever/scripts/sdk-git-source-bindings.py')], {encoding: 'utf8', timeout: 30000}));
    expect(value.result.verified).toBe(true); expect(value.result.files).toBe(4); expect(value.rejected).toHaveLength(10); expect(value.projection.verified).toBe(true); expect(value.zipObserved.patchProjection.verified).toBe(true);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
it('parses every actual registered patch and replays real ordinary/timestamp header samples', () => {
  const program = String.raw`
import hashlib,importlib.util,json,pathlib,re,shutil,sys,time
spec=importlib.util.spec_from_file_location('projection',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[2]);names=[name.strip() for name in (root/'series').read_text().splitlines() if name.strip()]
ordinary=0;files=0
for name in names:
 raw=(root/name).read_bytes();files+=len(m.patch_targets(raw));ordinary+=not raw.startswith(b'diff --git ')
assert len(names)==67 and ordinary==33 and files==84
replayed=[]
for name in ['qlever-exists-join-test-accessor.patch','qlever-operation-physical-cancellation.patch']:
 raw=(root/name).read_bytes();lines=raw.splitlines(keepends=True);first=next(i for i,line in enumerate(lines) if line.startswith(b'@@ '));end=next((i for i in range(first+1,len(lines)) if lines[i].startswith((b'@@ ',b'diff --git ',b'--- '))),len(lines))
 sample=b''.join(lines[:end]);target=m.patch_targets(sample)[0];start=int(re.match(rb'@@ -([0-9]+)',lines[first])[1]);prefix=b'fixture-padding\n'*(start-1)
 old=prefix+b''.join(line[1:] if line[:1] in (b' ',b'-') else b'' for line in lines[first+1:end]);new=prefix+b''.join(line[1:] if line[:1] in (b' ',b'+') else b'' for line in lines[first+1:end])
 def row(data):return dict(path=target,mode='100644',bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),blobOid=hashlib.sha1(('blob '+str(len(data))+'\0').encode()+data).hexdigest())
 result=m.project({target:old},{target:row(old)},[dict(name=name,bytes=sample)],dict(schemaVersion=1,files=[row(new)],addedPaths=[],deletedPaths=[]),shutil.which('git'),time.monotonic()+30,lambda:None)
 assert result['verified'];replayed.append(name)
valid=b'--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n'
invalid=[valid.replace(b'a/file',b'/dev/null'),valid.replace(b'b/file',b'b/../outside'),valid.replace(b'b/file',b'b/other'),valid.replace(b'a/file',b'"a/file"'),b'GIT binary patch\n'+valid,b'rename from file\n'+valid,b'new file mode 100644\n'+valid,valid.replace(b'--- a/file',b'--- a/file\tunknown-timestamp')]
for raw in invalid:
 try:m.patch_targets(raw)
 except ValueError:pass
 else:raise AssertionError('accepted unsafe operator/path')
# Removed/added source text that resembles file headers stays hunk data.
assert m.patch_targets(b'--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n--- a/evil\n+++ b/evil\n context\n')==['file']
print(json.dumps(dict(patches=len(names),ordinary=ordinary,fileHeaders=files,replayed=replayed,rejected=len(invalid))))
`;
  const value = JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', program, path.resolve('qlever/scripts/sdk-git-patch-projection.py'), path.resolve('qlever/patches')], {encoding: 'utf8', timeout: 30000}));
  expect(value).toMatchObject({patches: 67, ordinary: 33, fileHeaders: 84, rejected: 8}); expect(value.replayed).toHaveLength(2);
});
