"""Actual Git PACK/URL tar fixtures; mechanical bytes only, no grant issuer."""
import contextlib,copy,hashlib,importlib.util,io,json,lzma,tarfile,tempfile,unittest,zipfile
from pathlib import Path
import subprocess
ROOT=Path(__file__).resolve().parents[2]
def load(name):
 spec=importlib.util.spec_from_file_location(name,ROOT/'qlever/scripts'/f'{name}.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
sources=load('sdk-fetchcontent-source-bindings');observer=load('sdk-fetchcontent-source-observer')
NOTICE=b'Upstream fixture license\n'
class Workspace(unittest.TestCase):
 def setUp(self):
  self.raw={};(ROOT/'.test-data').mkdir(exist_ok=True);self.tmp=tempfile.TemporaryDirectory(dir=ROOT/'.test-data')
 def tearDown(self):self.tmp.cleanup()
 def ref(self,name,raw):self.raw[name]=raw;return dict(path=name,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
 @contextlib.contextmanager
 def member(self,ref):yield io.BytesIO(self.raw[ref['path']])
class GitFixture(Workspace):
 def setUp(self):
  super().setUp();self.root=Path(self.tmp.name)/'repo';self.root.mkdir()
  def run(*args,input=None):return subprocess.check_output(['git','-c','core.hooksPath=/dev/null',*args],cwd=self.root,input=input,stderr=subprocess.PIPE)
  run('init');run('config','user.name','Fixture');run('config','user.email','fixture@example.invalid')
  (self.root/'LICENSE').write_bytes(NOTICE);(self.root/'src').mkdir();(self.root/'src/x.c').write_bytes(b'int main(void){return 0;}\n')
  run('add','LICENSE','src/x.c');run('commit','-m','fixture');self.commit=run('rev-parse','HEAD').decode().strip();self.tree=run('rev-parse','HEAD^{tree}').decode().strip()
  listing=run('ls-tree','-r','-t','-z','--full-tree',self.commit);ids={self.commit,self.tree}
  for record in listing.split(b'\0'):
   if record:ids.add(record.split(b'\t',1)[0].split()[-1].decode())
  ordered='\n'.join(sorted(ids))+'\n';self.pack=run('pack-objects','--stdout','--window=0','--depth=0','--no-reuse-delta','--no-reuse-object',input=ordered.encode())
  inventory=[dict(path='LICENSE',mode='100644',blobOid=run('rev-parse','HEAD:LICENSE').decode().strip(),bytes=len(NOTICE),sha256=hashlib.sha256(NOTICE).hexdigest()),dict(path='src/x.c',mode='100644',blobOid=run('rev-parse','HEAD:src/x.c').decode().strip(),bytes=len(b'int main(void){return 0;}\n'),sha256=hashlib.sha256(b'int main(void){return 0;}\n').hexdigest())]
  self.original=dict(schemaVersion=1,kind='qlever-sdk-dependency-git-originals',repository='https://example.invalid/repo.git',commit=self.commit,rootTree=self.tree,objectFormat='sha1',objectIdsFormat='ascii-sorted-unique-sha1-lf',sourceRoot='/opt/qlever-sdk/dependencies/demo',commitOriginal=self.ref('commit',run('cat-file','commit',self.commit)),treeListing=self.ref('tree',listing),objectIds=self.ref('ids',ordered.encode()),objectPack=self.ref('pack',self.pack),prepatchInventory=self.ref('pre',json.dumps(dict(schemaVersion=1,files=inventory)).encode()))
  self.rows={'LICENSE':dict(kind='file',mode=0o644,bytes=len(NOTICE),sha256=hashlib.sha256(NOTICE).hexdigest()),'src/x.c':dict(kind='file',mode=0o644,bytes=len(b'int main(void){return 0;}\n'),sha256=hashlib.sha256(b'int main(void){return 0;}\n').hexdigest()),'.git/HEAD':dict(kind='file',mode=0o644,bytes=4,sha256=hashlib.sha256(b'HEAD').hexdigest())}
  self.declaration=dict(method='git',repository=self.original['repository'],commit=self.commit)
 def verify(self,selected=(),rows=None):return sources.verify_git(self.original,self.declaration,rows or self.rows,lambda ref:self.raw[ref['path']],self.member,lambda:None,selected_paths=selected)
 def test_selected_source_and_ancestor_notice_exact(self):
  result=self.verify(['src/x.c']);rows={row['path']:row for row in result['selectedOriginals']}
  self.assertEqual(set(rows),{'LICENSE','src/x.c'})
  self.assertEqual(rows['src/x.c']['base64'],__import__('base64').b64encode(b'int main(void){return 0;}\n').decode());self.assertTrue(rows['src/x.c']['requested']);self.assertFalse(rows['LICENSE']['requested']);self.assertEqual(rows['src/x.c']['sha256'],hashlib.sha256(b'int main(void){return 0;}\n').hexdigest())
 def test_default_shape_unchanged(self):
  result=self.verify();self.assertNotIn('selectedOriginals',result);self.assertEqual(result['files'],2)
 def test_missing_escape_duplicate_symlink_rejected(self):
  for selected in (['src/missing.c'],['../escape'],['src/x.c','src/x.c']):
   with self.subTest(selected=selected),self.assertRaises(ValueError):self.verify(selected)
  (self.root/'link').symlink_to('src/x.c')
  def run(*args,input=None):return subprocess.check_output(['git','-c','core.hooksPath=/dev/null',*args],cwd=self.root,input=input,stderr=subprocess.PIPE)
  run('add','link');run('commit','-m','link');commit=run('rev-parse','HEAD').decode().strip();tree=run('rev-parse','HEAD^{tree}').decode().strip();listing=run('ls-tree','-r','-t','-z','--full-tree',commit);ids={commit,tree}
  for record in listing.split(b'\0'):
   if record:ids.add(record.split(b'\t',1)[0].split()[-1].decode())
  ordered='\n'.join(sorted(ids))+'\n';self.original.update(commit=commit,rootTree=tree,commitOriginal=self.ref('commit2',run('cat-file','commit',commit)),treeListing=self.ref('tree2',listing),objectIds=self.ref('ids2',ordered.encode()),objectPack=self.ref('pack2',run('pack-objects','--stdout','--window=0','--depth=0','--no-reuse-delta','--no-reuse-object',input=ordered.encode())))
  self.rows['link']=dict(kind='symlink',mode=0o777,target='src/x.c',bytes=10,sha256=hashlib.sha256(b'src/x.c').hexdigest())
  with self.assertRaises(ValueError):self.verify(['link'])
 def test_same_bytes_different_path_and_missing_notice_rejected(self):
  result=self.verify(['src/x.c']);self.assertEqual([row['path'] for row in result['selectedOriginals']],['src/x.c','LICENSE'])
  changed=copy.deepcopy(self.original);changed['prepatchInventory']=self.ref('pre2',json.dumps(dict(schemaVersion=1,files=[dict(path='LICENSE',mode='100644',blobOid=self.original['prepatchInventory'] and next(row['blobOid'] for row in json.loads(self.raw[self.original['prepatchInventory']['path']])['files'] if row['path']=='LICENSE'),bytes=len(NOTICE),sha256=hashlib.sha256(NOTICE).hexdigest()),dict(path='other.c',mode='100644',blobOid='0'*40,bytes=len(b'int main(void){return 0;}\n'),sha256=hashlib.sha256(b'int main(void){return 0;}\n').hexdigest())])).encode())
  with self.assertRaises(ValueError):sources.verify_git(changed,self.declaration,self.rows,lambda ref:self.raw[ref['path']],self.member,lambda:None,selected_paths=['src/x.c'])
 def test_cumulative_selected_limit_rejected(self):
  big=b'x'*(sources.LIMITS['metadataBytes']+1);self.rows['big.bin']=dict(kind='file',mode=0o644,bytes=len(big),sha256=hashlib.sha256(big).hexdigest())
  inventory=json.loads(self.raw[self.original['prepatchInventory']['path']]);inventory['files'].append(dict(path='big.bin',mode='100644',blobOid='0'*40,bytes=len(big),sha256=hashlib.sha256(big).hexdigest()));self.original['prepatchInventory']=self.ref('pre3',json.dumps(inventory).encode())
  with self.assertRaises((ValueError,KeyError)):self.verify(['big.bin'])
class UrlFixture(Workspace):
 def setUp(self):
  super().setUp();raw=io.BytesIO()
  with tarfile.open(fileobj=raw,mode='w') as tar:
   root=tarfile.TarInfo('root');root.type=tarfile.DIRTYPE;tar.addfile(root)
   for name,data,mode in [('LICENSE',NOTICE,0o644),('src/x.c',b'abc',0o644)]:
    item=tarfile.TarInfo('root/'+name);item.mode=mode;item.size=len(data);tar.addfile(item,io.BytesIO(data))
  packed=lzma.compress(raw.getvalue());self.declaration=dict(method='url',url='https://example.invalid/source.tar.xz',algorithm='sha3_224',digest=hashlib.sha3_224(packed).hexdigest())
  self.original=dict(schemaVersion=1,kind='qlever-sdk-dependency-archive-originals',**{k:v for k,v in self.declaration.items() if k!='method'},archive=self.ref('archive.tar.xz',packed))
  self.rows={'LICENSE':dict(kind='file',mode=0o644,bytes=len(NOTICE),sha256=hashlib.sha256(NOTICE).hexdigest()),'src/x.c':dict(kind='file',mode=0o644,bytes=3,sha256=hashlib.sha256(b'abc').hexdigest())}
 def test_selected_url_source_and_ancestor(self):
  result=sources.verify_url(self.original,self.declaration,self.rows,self.member,lambda:None,selected_paths=['src/x.c']);rows={row['path']:row for row in result['selectedOriginals']}
  self.assertEqual(set(rows),{'LICENSE','src/x.c'});self.assertEqual(rows['src/x.c']['base64'],__import__('base64').b64encode(b'abc').decode());self.assertEqual(sources.verify_url(self.original,self.declaration,self.rows,self.member,lambda:None)['files'],2)
 def test_selected_url_missing_and_symlink_rejected(self):
  with self.assertRaises(ValueError):sources.verify_url(self.original,self.declaration,self.rows,self.member,lambda:None,selected_paths=['src/missing.c'])
class ObserverSelected(Workspace):
 def test_observer_selected_exact_and_rejections(self):
  root=Path(self.tmp.name)/'repo';root.mkdir()
  def run(*args,input=None):return subprocess.check_output(['git','-c','core.hooksPath=/dev/null',*args],cwd=root,input=input,stderr=subprocess.PIPE)
  run('init');run('config','user.name','Fixture');run('config','user.email','fixture@example.invalid');(root/'LICENSE').write_bytes(NOTICE);(root/'x.txt').write_bytes(b'actual Git file\n');run('add','LICENSE','x.txt');run('commit','-m','fixture')
  commit=run('rev-parse','HEAD').decode().strip();tree=run('rev-parse','HEAD^{tree}').decode().strip();listing=run('ls-tree','-r','-t','-z','--full-tree',commit);ids={commit,tree}
  for record in listing.split(b'\0'):
   if record:ids.add(record.split(b'\t',1)[0].split()[-1].decode())
  ordered='\n'.join(sorted(ids))+'\n';pack=run('pack-objects','--stdout','--window=0','--depth=0','--no-reuse-delta','--no-reuse-object',input=ordered.encode());data=(root/'x.txt').read_bytes();notice=(root/'LICENSE').read_bytes()
  files=[dict(path='LICENSE',mode='100644',blobOid=run('rev-parse','HEAD:LICENSE').decode().strip(),bytes=len(notice),sha256=hashlib.sha256(notice).hexdigest()),dict(path='x.txt',mode='100644',blobOid=run('rev-parse','HEAD:x.txt').decode().strip(),bytes=len(data),sha256=hashlib.sha256(data).hexdigest())]
  original=dict(schemaVersion=1,kind='qlever-sdk-dependency-git-originals',repository='https://github.com/example/demo.git',commit=commit,rootTree=tree,objectFormat='sha1',objectIdsFormat='ascii-sorted-unique-sha1-lf',sourceRoot='/opt/qlever-sdk/dependencies/demo',commitOriginal=self.ref('c',run('cat-file','commit',commit)),treeListing=self.ref('t',listing),objectIds=self.ref('i',ordered.encode()),objectPack=self.ref('p',pack),prepatchInventory=self.ref('pre',json.dumps(dict(schemaVersion=1,files=files)).encode()))
  for field in ['commitOriginal','treeListing','objectIds','objectPack','prepatchInventory']:
   item=original[field];self.raw['inner/fetchcontent/'+item['path']]=self.raw.pop(item['path']);item['path']='fetchcontent/'+item['path']
  text=('FetchContent_Declare(demo GIT_REPOSITORY https://github.com/example/demo.git GIT_TAG '+commit+')\nFetchContent_MakeAvailable(demo)\n').encode();declared=observer.shared.parse_fetchcontent_declarations(text.decode())[0]
  physical=[dict(path=name,**row) for name,row in {'LICENSE':dict(kind='file',mode=0o644,bytes=len(notice),sha256=hashlib.sha256(notice).hexdigest()),'x.txt':dict(kind='file',mode=0o644,bytes=len(data),sha256=hashlib.sha256(data).hexdigest())}.items()]
  shard=dict(path='fetchcontent/shard.json',bytes=len(json.dumps(dict(schemaVersion=1,files=physical)).encode()),sha256=hashlib.sha256(json.dumps(dict(schemaVersion=1,files=physical)).encode()).hexdigest());self.raw['inner/fetchcontent/shard.json']=json.dumps(dict(schemaVersion=1,files=physical)).encode();index=dict(path='fetchcontent/index.json',bytes=len(json.dumps(dict(schemaVersion=1,files=2,bytes=len(notice)+len(data),shards=[shard])).encode()),sha256=hashlib.sha256(json.dumps(dict(schemaVersion=1,files=2,bytes=len(notice)+len(data),shards=[shard])).encode()).hexdigest());self.raw['inner/fetchcontent/index.json']=json.dumps(dict(schemaVersion=1,files=2,bytes=len(notice)+len(data),shards=[shard])).encode()
  row=dict(name='demo',sourceRoot='/opt/qlever-sdk/dependencies/demo',declaration=declared,sourceInventory=index,sourceOriginals=dict(kind='git',file=dict(path='fetchcontent/git.json',bytes=len(json.dumps(original).encode()),sha256=hashlib.sha256(json.dumps(original).encode()).hexdigest())));self.raw['inner/fetchcontent/git.json']=json.dumps(original).encode()
  collection=dict(schemaVersion=1,kind='qlever-sdk-fetchcontent-prepared-originals',sourceRoot='/opt/qlever-sdk/source',dependenciesRoot='/opt/qlever-sdk/dependencies',declarationSource=dict(file=dict(path='fetchcontent/CMakeLists.txt',bytes=len(text),sha256=hashlib.sha256(text).hexdigest())),dependencies=[row],cmakeCache=dict(path='fetchcontent/cache.cmake',bytes=len(observer.shared.fetchcontent_source_bindings([row]).encode()),sha256=hashlib.sha256(observer.shared.fetchcontent_source_bindings([row]).encode()).hexdigest()),cmakeCachePath='/opt/qlever-sdk/dependencies/sources.cmake')
  self.raw['inner/fetchcontent/CMakeLists.txt']=text;self.raw['inner/fetchcontent/cache.cmake']=observer.shared.fetchcontent_source_bindings([row]).encode();collection_bytes=json.dumps(collection).encode();self.raw['inner/fetchcontent/materials.json']=collection_bytes;ref=dict(path='fetchcontent/materials.json',bytes=len(collection_bytes),sha256=hashlib.sha256(collection_bytes).hexdigest());plan=dict(collection=dict(ref,path='inner/fetchcontent/materials.json'),declarationSha256=hashlib.sha256(text).hexdigest(),remainingMilliseconds=30000,inputRecords=[dict(selected=True,captures=0,path='/opt/qlever-sdk/dependencies/demo/x.txt',bytes=len(data),mode=0o644,sha256=hashlib.sha256(data).hexdigest())],selectedOriginalPaths=['/opt/qlever-sdk/dependencies/demo/x.txt'])
  archive=Path(self.tmp.name)/'sdk.zip'
  with zipfile.ZipFile(archive,'w') as out:
   for name,value in self.raw.items():out.writestr(name,value)
  result=observer.observe(archive,plan);selected={item['path']:item for item in result['selectedOriginals']}
  self.assertEqual(set(selected),{'/opt/qlever-sdk/dependencies/demo/x.txt','/opt/qlever-sdk/dependencies/demo/LICENSE'})
  self.assertEqual(__import__('base64').b64decode(selected['/opt/qlever-sdk/dependencies/demo/x.txt']['base64']),data);self.assertTrue(selected['/opt/qlever-sdk/dependencies/demo/x.txt']['requested']);self.assertFalse(selected['/opt/qlever-sdk/dependencies/demo/LICENSE']['requested'])
  plan['selectedOriginalPaths']=['/opt/qlever-sdk/dependencies/demo/missing.c']
  with self.assertRaises(ValueError):observer.observe(archive,plan)

class ExtraSelected(Workspace):
 def test_url_selected_large_multiblock_and_sparse_rejected(self):
  big=bytes(range(256))*300  # >64KiB, multi-block
  raw=io.BytesIO()
  with tarfile.open(fileobj=raw,mode='w') as tar:
   root=tarfile.TarInfo('root');root.type=tarfile.DIRTYPE;tar.addfile(root)
   for name,data in [('LICENSE',NOTICE),('src/big.bin',big)]:
    item=tarfile.TarInfo('root/'+name);item.mode=0o644;item.size=len(data);tar.addfile(item,io.BytesIO(data))
  packed=lzma.compress(raw.getvalue());declaration=dict(method='url',url='https://example.invalid/source.tar.xz',algorithm='sha3_224',digest=hashlib.sha3_224(packed).hexdigest())
  original=dict(schemaVersion=1,kind='qlever-sdk-dependency-archive-originals',**{k:v for k,v in declaration.items() if k!='method'},archive=self.ref('archive.tar.xz',packed))
  rows={'LICENSE':dict(kind='file',mode=0o644,bytes=len(NOTICE),sha256=hashlib.sha256(NOTICE).hexdigest()),'src/big.bin':dict(kind='file',mode=0o644,bytes=len(big),sha256=hashlib.sha256(big).hexdigest())}
  result=sources.verify_url(original,declaration,rows,self.member,lambda:None,selected_paths=['src/big.bin']);selected={row['path']:row for row in result['selectedOriginals']}
  self.assertGreater(len(big),65536);self.assertEqual(len(__import__('base64').b64decode(selected['src/big.bin']['base64'])),len(big));self.assertEqual(__import__('base64').b64decode(selected['src/big.bin']['base64']),big);self.assertEqual(set(selected),{'LICENSE','src/big.bin'})
  with self.assertRaises(ValueError):
   sources.verify_url(dict(original,archive=self.ref('bad.tar.xz',packed[:-5])),declaration,rows,self.member,lambda:None,selected_paths=['src/big.bin'])
 def test_url_actual_regular_modes_preserved(self):
  for mode in [0o664,0o640,0o600,0o444]:
   with self.subTest(mode=oct(mode)):
    raw=io.BytesIO();data=b'actual source\n'
    with tarfile.open(fileobj=raw,mode='w') as tar:
     root=tarfile.TarInfo('root');root.type=tarfile.DIRTYPE;tar.addfile(root)
     item=tarfile.TarInfo('root/x.c');item.size=len(data);item.mode=mode;tar.addfile(item,io.BytesIO(data))
    packed=raw.getvalue();declaration=dict(method='url',url='https://example.invalid/a.tar',algorithm='sha3_224',digest=hashlib.sha3_224(packed).hexdigest())
    original=dict(schemaVersion=1,kind='qlever-sdk-dependency-archive-originals',**{k:v for k,v in declaration.items() if k!='method'},archive=self.ref('mode.tar',packed))
    rows={'x.c':dict(kind='file',mode=mode,bytes=len(data),sha256=hashlib.sha256(data).hexdigest())}
    baseline=sources.verify_url(original,declaration,rows,self.member,lambda:None)
    selected=sources.verify_url(original,declaration,rows,self.member,lambda:None,selected_paths=['x.c'])
    self.assertEqual(baseline,{key:value for key,value in selected.items() if key!='selectedOriginals'})
    self.assertEqual(selected['selectedOriginals'][0]['mode'],mode)
 def test_sparse_four_codecs_rejected(self):
  import gzip,bz2
  raw=io.BytesIO()
  with tarfile.open(fileobj=raw,mode='w',format=tarfile.PAX_FORMAT) as tar:
   root=tarfile.TarInfo('root');root.type=tarfile.DIRTYPE;tar.addfile(root)
   item=tarfile.TarInfo('root/x.c');item.size=1;item.mode=0o644;item.pax_headers={'GNU.sparse.map':'0,1','GNU.sparse.size':'1048576'};tar.addfile(item,io.BytesIO(b'x'))
  for suffix,encode in [('.tar',lambda x:x),('.tar.gz',gzip.compress),('.tar.xz',lzma.compress),('.tar.bz2',bz2.compress)]:
   with self.subTest(codec=suffix):
    packed=encode(raw.getvalue());declaration=dict(method='url',url='https://example.invalid/a'+suffix,algorithm='sha3_224',digest=hashlib.sha3_224(packed).hexdigest())
    original=dict(schemaVersion=1,kind='qlever-sdk-dependency-archive-originals',**{k:v for k,v in declaration.items() if k!='method'},archive=self.ref('sparse'+suffix,packed))
    rows={'x.c':dict(kind='file',mode=0o644,bytes=1,sha256=hashlib.sha256(b'x').hexdigest())}
    with self.assertRaisesRegex(ValueError,'sparse|unsupported/duplicate PAX semantics'):
     sources.verify_url(original,declaration,rows,self.member,lambda:None,selected_paths=['x.c'])
 def test_shared_retention_rejected_before_open(self):
  budget={'bytes':0,'encoded':0,'retained':sources.LIMITS['metadataBytes']-1,'planned':0}
  rows={'x.c':dict(kind='file',mode=0o644,bytes=2,sha256=hashlib.sha256(b'xx').hexdigest())}
  declaration=dict(method='url',url='https://example.invalid/a.tar',algorithm='sha3_224',digest='0'*56)
  original=dict(schemaVersion=1,kind='qlever-sdk-dependency-archive-originals',**{k:v for k,v in declaration.items() if k!='method'},archive=dict(path='a.tar',bytes=512,sha256='0'*64))
  def forbidden(_):raise AssertionError('must reserve before opening archive')
  with self.assertRaisesRegex(ValueError,'retained source bound'):
   sources.verify_url(original,declaration,rows,forbidden,lambda:None,selected_paths=['x.c'],_budget=budget)
 def test_nested_git_selected_prefixed_once_with_parent_notice(self):
  outer=Path(self.tmp.name)/'outer';inner=Path(self.tmp.name)/'inner';outer.mkdir();inner.mkdir()
  def run(root,*args,input=None):return subprocess.check_output(['git','-c','core.hooksPath=/dev/null',*args],cwd=root,input=input,stderr=subprocess.PIPE)
  for repo,notice,source in [(inner,b'child notice\n',b'child source\n'),(outer,b'outer notice\n',None)]:
   run(repo,'init');run(repo,'config','user.name','Fixture');run(repo,'config','user.email','fixture@example.invalid')
   (repo/'LICENSE').write_bytes(notice)
   if source is not None:(repo/'src').mkdir();(repo/'src/child.c').write_bytes(source)
   run(repo,'add','.');run(repo,'commit','-m','fixture')
  def snapshot(repo,root,prefix=''):
   commit=run(repo,'rev-parse','HEAD').decode().strip();tree=run(repo,'rev-parse','HEAD^{tree}').decode().strip();listing=run(repo,'ls-tree','-r','-t','-z','--full-tree',commit);ids={commit,tree};files=[]
   for record in listing.split(b'\0'):
    if not record:continue
    header,name=record.split(b'\t',1);mode,kind,oid=header.decode().split();name=name.decode()
    if kind!='commit':ids.add(oid)
    if kind=='blob':
     data=run(repo,'cat-file','blob',oid);files.append(dict(path=name,mode=mode,blobOid=oid,bytes=len(data),sha256=hashlib.sha256(data).hexdigest()))
   ordered='\n'.join(sorted(ids))+'\n';pack=run(repo,'pack-objects','--stdout','--window=0','--depth=0','--no-reuse-delta','--no-reuse-object',input=ordered.encode())
   original=dict(schemaVersion=1,kind='qlever-sdk-dependency-git-originals',repository='https://github.com/example/'+repo.name+'.git',commit=commit,rootTree=tree,objectFormat='sha1',objectIdsFormat='ascii-sorted-unique-sha1-lf',sourceRoot=root,commitOriginal=self.ref(prefix+'commit',run(repo,'cat-file','commit',commit)),treeListing=self.ref(prefix+'tree',listing),objectIds=self.ref(prefix+'ids',ordered.encode()),objectPack=self.ref(prefix+'pack',pack),prepatchInventory=self.ref(prefix+'pre',json.dumps(dict(schemaVersion=1,files=files)).encode()))
   return original,{row['path']:dict(kind='file',mode=0o644,bytes=row['bytes'],sha256=row['sha256']) for row in files}
  child_original,child_rows=snapshot(inner,'/opt/qlever-sdk/dependencies/nested/child',prefix='child-')
  child_commit=child_original['commit']
  (outer/'.gitmodules').write_text('[submodule "child"]\n\tpath = child\n\turl = https://github.com/example/inner.git\n')
  run(outer,'add','.gitmodules');run(outer,'update-index','--add','--cacheinfo','160000,'+child_commit+',child');run(outer,'commit','-m','actual gitlink')
  outer_original,outer_rows=snapshot(outer,'/opt/qlever-sdk/dependencies/nested',prefix='outer-')
  inventory=json.loads(self.raw[outer_original['prepatchInventory']['path']]);inventory['gitlinks']=[dict(path='child',mode='160000',commitOid=child_commit)]
  outer_original['prepatchInventory']=self.ref('outer-pre2',json.dumps(inventory).encode())
  outer_original['materializedGitlinks']=[dict(path='child',repository='https://github.com/example/inner.git',commit=child_commit,original=self.ref('child-original.json',json.dumps(child_original).encode()))]
  rows=dict(outer_rows);rows['child/LICENSE']=child_rows['LICENSE'];rows['child/src/child.c']=child_rows['src/child.c']
  declaration=dict(method='git',repository=outer_original['repository'],commit=outer_original['commit'])
  result=sources.verify_git(outer_original,declaration,rows,lambda ref:self.raw[ref['path']],self.member,lambda:None,selected_paths=['child/src/child.c'])
  selected={row['path']:row for row in result['selectedOriginals']}
  self.assertIn('child/src/child.c',selected);self.assertTrue(selected['child/src/child.c']['requested'])
  self.assertIn('child/LICENSE',selected);self.assertIn('LICENSE',selected)
  self.assertEqual([name for name in selected if name.startswith('child/child/')],[])
  with self.assertRaises(ValueError):sources.verify_git(outer_original,declaration,rows,lambda ref:self.raw[ref['path']],self.member,lambda:None,selected_paths=['child/src/missing.c'])

if __name__=='__main__':unittest.main()
