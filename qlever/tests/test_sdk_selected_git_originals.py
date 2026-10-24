"""Actual Git pack/patch fixtures only; no origin, legal, or release authority."""
import base64,hashlib,importlib.util,json,os,stat,subprocess,tempfile,unittest,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def load(name):
 spec=importlib.util.spec_from_file_location(name,ROOT/'qlever/scripts'/f'{name}.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
observer=load('sdk-git-source-observer');projection=observer.projection;LIMITS=observer.LIMITS

def git(root,*args,input=None):
 return subprocess.check_output(['git','-c','core.hooksPath=/dev/null',*args],cwd=root,input=input,stderr=subprocess.PIPE)
def observe(root,*args):return git(root,*args).decode().strip()
def patched_env(home):return dict(PATH='/usr/bin:/bin',HOME=str(home),LANG='C.UTF-8',GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL='/dev/null',GIT_CONFIG_SYSTEM='/dev/null',GIT_ATTR_NOSYSTEM='1',GIT_CEILING_DIRECTORIES=str(Path(home).parent))
def blob_oid(data):return hashlib.sha1(('blob '+str(len(data))+'\0').encode()+data).hexdigest()

class Fixture(unittest.TestCase):
 def setUp(self):
  (ROOT/'.test-data').mkdir(exist_ok=True)
  self.tmp=tempfile.TemporaryDirectory(dir=ROOT/'.test-data');self.root=Path(self.tmp.name)/'repo';self.root.mkdir()
  git(self.root,'init');git(self.root,'config','user.name','Fixture');git(self.root,'config','user.email','fixture@example.invalid')
  (self.root/'main.c').write_bytes(b'int main(void){return 0;}\n')
  (self.root/'LICENSE').write_bytes(b'MIT fixture license\n')
  (self.root/'tool.sh').write_bytes(b'#!/bin/sh\nexit 0\n');(self.root/'tool.sh').chmod(0o755)
  os.symlink('main.c',self.root/'link')
  git(self.root,'add','main.c','LICENSE','tool.sh','link');git(self.root,'commit','-m','fixture')
  self.commit=observe(self.root,'rev-parse','HEAD')
  self.patch=self.make_patch()
 def tearDown(self):self.tmp.cleanup()
 def names(self):
  listing=git(self.root,'ls-tree','-r','-z','--full-tree',self.commit)
  return sorted(record.split(b'\t',1)[1].decode() for record in listing.split(b'\0') if record)
 def prepatch_rows(self):
  listing=git(self.root,'ls-tree','-r','-z','--full-tree',self.commit)
  rows=[]
  for record in listing.split(b'\0'):
   if not record:continue
   header,name=record.split(b'\t',1);mode,kind,oid=header.decode().split();name=name.decode()
   if kind!='blob':continue
   data=git(self.root,'cat-file','blob',oid)
   row=dict(path=name,mode=mode,blobOid=oid,bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
   if mode=='120000':row['readlinkBase64']=base64.b64encode(data).decode()
   rows.append(row)
  return dict(schemaVersion=1,files=sorted(rows,key=lambda row:row['path']))
 def make_patch(self):
  before=(self.root/'main.c').read_bytes()
  (self.root/'main.c').write_bytes(b'int main(void){return 7;}\n')
  raw=git(self.root,'diff','--no-ext-diff','--no-color')
  (self.root/'main.c').write_bytes(before);git(self.root,'reset','--hard','HEAD')
  return raw
 def build(self,selected,post_change=None):
  names=self.names();prepatch=self.prepatch_rows()
  commit_raw=git(self.root,'cat-file','commit',self.commit);root_tree=commit_raw.split(b'\n',1)[0][5:].decode()
  listing=git(self.root,'ls-tree','-r','-t','-z','--full-tree',self.commit)
  objects={self.commit,root_tree}
  for line in listing.split(b'\0'):
   if line:objects.add(line.split(b'\t',1)[0].split()[-1].decode())
  ids=('\n'.join(sorted(objects))+'\n').encode()
  pack=git(self.root,'pack-objects','--stdout','--window=0','--depth=0','--no-reuse-delta','--no-reuse-object',input=ids)
  patched=Path(tempfile.mkdtemp(dir=self.tmp.name))
  for name in names:
   source=self.root/name;target=patched/name
   if source.is_symlink():os.symlink(os.readlink(source),target)
   else:target.write_bytes(source.read_bytes());target.chmod(source.stat().st_mode&0o7777)
  subprocess.run(['git','-c','core.hooksPath=/dev/null','apply','--whitespace=nowarn','-'],cwd=patched,input=self.patch,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=patched_env(self.tmp.name))
  self.assertNotEqual((patched/'main.c').read_bytes(),b'int main(void){return 0;}\n','actual patch fixture must change main.c')
  postrows={}
  for row in prepatch['files']:
   name=row['path'];source=patched/name
   if name=='main.c':
    data=source.read_bytes();postrows[name]=dict(path=name,mode='100755' if source.stat().st_mode&0o111 else '100644',blobOid=blob_oid(data),bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
   else:postrows[name]=dict(row)
  post=dict(schemaVersion=1,files=[postrows[name] for name in sorted(postrows)])
  if post_change:post_change(post)
  prefix='inner/upstream-source/';members={}
  def add(name,data):members[prefix+name]=data;return dict(path=prefix+name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
  patch_ref=add('patches/change.patch',self.patch);series_ref=add('patches/series',b'change.patch\n')
  refs=dict(commitOriginal=add('commit.original',commit_raw),treeListing=add('tree.listing',listing),objectIds=add('object-ids',ids),prepatchInventory=add('prepatch.json',json.dumps(prepatch).encode()),postpatchInventory=add('postpatch.json',json.dumps(post).encode()),objectPack=add('objects.pack',pack),patchSeries=series_ref)
  plan=dict(remainingMilliseconds=5000,commit=self.commit,rootTree=root_tree,gitExecutable='git',reviewedPatches=[dict(name='change.patch',file=patch_ref,base64=base64.b64encode(self.patch).decode())],reviewedSeriesBase64=base64.b64encode(b'change.patch\n').decode(),addedPaths=[],deletedPaths=[],selectedOriginalPaths=selected,**refs)
  archive=Path(self.tmp.name)/'sdk.zip'
  with zipfile.ZipFile(archive,'w') as out:
   for path,data in members.items():out.writestr(path,data)
  return observer.observe(archive,plan)

class Tests(Fixture):
 def test_changed_source_and_untouched_license_exact_bytes(self):
  result=self.build(['main.c','LICENSE','tool.sh'])
  selected={row['path']:row for row in result['patchProjection']['selectedOriginals']}
  self.assertEqual(selected['main.c']['base64'],base64.b64encode(b'int main(void){return 7;}\n').decode())
  self.assertEqual(selected['LICENSE']['base64'],base64.b64encode(b'MIT fixture license\n').decode())
  self.assertEqual(selected['main.c']['sha256'],hashlib.sha256(b'int main(void){return 7;}\n').hexdigest())
  self.assertEqual((selected['LICENSE']['mode'],selected['tool.sh']['mode']),(0o644,0o755))
  self.assertEqual(selected['tool.sh']['base64'],base64.b64encode(b'#!/bin/sh\nexit 0\n').decode())
  self.assertEqual([row['path'] for row in result['patchProjection']['selectedOriginals']],['main.c','LICENSE','tool.sh'])
  self.assertEqual(result['patchProjection']['patchedPaths'],['main.c'])
  self.assertNotIn('selectedOriginals',result)
 def test_absent_requests_keep_existing_shape(self):
  result=self.build([])
  self.assertNotIn('selectedOriginals',result);self.assertNotIn('selectedOriginals',result['patchProjection'])
 def test_missing_escape_duplicate_and_symlink_rejected(self):
  for selected,reason in [(['missing.c'],'patch target absent'),(['../escape'],'canonical unique selected'),(['main.c','main.c'],'canonical unique selected'),(['link'],'regular retained selected')]:
   with self.subTest(selected=selected),self.assertRaisesRegex(ValueError,reason):self.build(selected)
 def test_declared_postpatch_hash_is_not_used_instead_of_actual_bytes(self):
  def change(post):
   for row in post['files']:
    if row['path']=='main.c':row['sha256']='0'*64
  with self.assertRaisesRegex(ValueError,'selected actual bytes differ|postpatch projection'):self.build(['main.c'],post_change=change)

class PureProjection(unittest.TestCase):
 def project(self,rows,patches=()):
  preimages={row['path']:row.pop('_raw') for row in rows}
  pre={row['path']:dict(row) for row in rows}
  post=dict(schemaVersion=1,files=[dict(row) for row in rows],addedPaths=[],deletedPaths=[])
  return projection.project(preimages,pre,list(patches),post,'git',1e18,lambda:None,selected_paths=[row['path'] for row in rows])
 def row(self,name,size,fill):
  raw=(fill*((size//len(fill))+1))[:size]
  return dict(path=name,mode='100644',blobOid=blob_oid(raw),bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest(),_raw=raw)
 def test_cumulative_selected_bytes_bound_with_real_digests(self):
  a=self.row('a.bin',2*1024**2+1,b'a');b=self.row('b.bin',2*1024**2+1,b'b')
  self.assertGreater(a['bytes']+b['bytes'],LIMITS['metadataBytes'])
  with self.assertRaisesRegex(ValueError,'cumulative selected original bytes bound'):self.project([a,b])
 def test_selected_output_encoded_bound_with_real_digests(self):
  a=self.row('a.bin',3*1024**2+200*1024,b'a')
  self.assertLessEqual(a['bytes'],LIMITS['metadataBytes'])
  self.assertGreater(len(base64.b64encode(a['_raw'])),LIMITS['metadataBytes'])
  with self.assertRaisesRegex(ValueError,'selected originals JSON/base64 metadata bound'):self.project([a])

if __name__=='__main__':unittest.main()
