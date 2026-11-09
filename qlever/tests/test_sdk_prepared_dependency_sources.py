"""Pure retained-original protocol tests, not private SDK authority or kernel runs."""
import copy,hashlib,importlib.util,json,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
s=importlib.util.spec_from_file_location('dependency_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');b=importlib.util.module_from_spec(s);s.loader.exec_module(b);m=b.bindings
class Tests(unittest.TestCase):
 def fixture(self):
  values={};rows=[]
  def emit(kind,**kw):
   row=dict(kind=kind,sequence=len(rows)+1,phase='configure',**kw);rows.append(row);return row
  def original(value):
   data=value if isinstance(value,bytes) else json.dumps(value,sort_keys=True).encode();name='capture-'+str(len(values)).zfill(4)+'.original';values[name]=data;ref=dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest());emit('write-original',original=ref);return ref
  member=dict(path='input.h',kind='file',mode=0o644,bytes=3,sha256=hashlib.sha256(b'abc').hexdigest());shard=original(dict(schemaVersion=1,files=[member]));shard_ref=dict(shard,path='fetchcontent/fsst/source-0000.json');index=original(dict(schemaVersion=1,files=1,bytes=3,shards=[shard_ref]));index_ref=dict(index,path='fetchcontent/fsst/source-inventory.json')
  cmake=b'FetchContent_Declare(fsst GIT_REPOSITORY https://github.com/cwida/fsst.git GIT_TAG '+b'a'*40+b')\nFetchContent_MakeAvailable(fsst)\n';declarations=m.parse_fetchcontent_declarations(cmake.decode());declaration=original(cmake);declaration_ref=dict(declaration,path='fetchcontent/declaration.CMakeLists.txt');cache=original(m.fetchcontent_cache_bytes(declarations));cache_ref=dict(cache,path='fetchcontent/sources.cmake')
  collection=original(dict(schemaVersion=1,kind='qlever-sdk-fetchcontent-prepared-originals',sourceRoot='/opt/qlever-sdk/source',dependenciesRoot='/opt/qlever-sdk/dependencies',declarationSource=dict(sourcePath='/opt/qlever-sdk/source/CMakeLists.txt',file=declaration_ref),cmakeCache=cache_ref,cmakeCachePath='/opt/qlever-sdk/dependencies/sources.cmake',dependencies=[dict(declaration=declarations[0],name='fsst',sourceRoot='/opt/qlever-sdk/dependencies/fsst',sourceInventory=index_ref,sourceOriginals=dict(kind='git',file=dict(path='fetchcontent/fsst/originals.json',bytes=2,sha256='0'*64)))]));prepared=original(dict(dependencyCollection=dict(collection,path='fetchcontent/materials.json')))
  mounts=original(b'1 0 0:1 / / rw - ext4 root rw\n2 1 0:2 / /opt/qlever-sdk/dependencies ro - ext4 deps rw\n');root=emit('prepared-dependency-source-root',name='fsst',sourceRoot='/opt/qlever-sdk/dependencies/fsst',declarationOriginal=declaration,declarationReference=declaration_ref,cmakeCacheOriginal=cache,cmakeCacheReference=cache_ref,provider=m.probe_mount_readonly('/opt/qlever-sdk/dependencies/fsst',values[mounts['path']]),sourcePreparedOriginal=prepared,collectionOriginal=collection,mountinfoOriginal=mounts,inventoryIndexOriginal=index,inventoryReference=index_ref,inventoryShardReferences=[shard_ref],inventoryShardOriginals=[shard])
  payload=original(b'abc');emit('owned-root-binding',pid=7,backend='ptrace-all-stop-process-v1');entry=emit('kernel-syscall',pid=7,arch=0xc00000b7,op='entry',nr=63,args=[3,100,3,0,0,0]);barrier=emit('all-stop-barrier',pids=[7],osStates=['t']);capture=emit('fd-capture',pid=7,fd=3,role='source-read',path='/opt/qlever-sdk/dependencies/fsst/input.h',identity=[1,2,0o100644,3,4,5],original=payload,entrySequence=entry['sequence'],barrierSequence=barrier['sequence'],writers=[],dependency=dict(name='fsst',relativePath='input.h',registrationSequence=root['sequence']));emit('exclusive-captured-syscall-resume',pid=7,entrySequence=entry['sequence'],captureSequence=capture['sequence']);emit('kernel-syscall',pid=7,arch=0xc00000b7,op='exit',entrySequence=entry['sequence'],result=3,isError=False);emit('exclusive-captured-syscall-exit',pid=7,entrySequence=entry['sequence'],result=3,isError=False);emit('actual-wait-exit',pid=7,returnCode=0);return rows,values
 def inspect(self,rows,values):return m.observe([('configure',[(json.dumps(r)+'\n').encode() for r in rows])],lambda name,_:values[name],{})
 def test_actual_registered_snapshot_read_bytes_only(self):
  r,v=self.fixture();report=self.inspect(r,v);self.assertEqual(report['observedPreparedDependencyReadCaptures'],1);self.assertFalse(report['preparedDependencySourceAuthorityVerified']);self.assertFalse(report['overallSdkSourceVerified'])
 def test_fixed_cache_read_uses_same_collection_original(self):
  rows,values=self.fixture();root=next(r for r in rows if r['kind']=='prepared-dependency-source-root');read=next(r for r in rows if r['kind']=='fd-capture');payload=read['original'];cache=values[root['cmakeCacheOriginal']['path']];values[payload['path']]=cache
  for row in rows:
   if row.get('original',{}).get('path')==payload['path']:row['original'].update(bytes=len(cache),sha256=hashlib.sha256(cache).hexdigest())
   if row['kind']=='kernel-syscall' and row['op']=='entry':row['args'][2]=len(cache)
   elif row['kind']=='kernel-syscall' and row['op']=='exit':row['result']=len(cache)
  read['path']='/opt/qlever-sdk/dependencies/sources.cmake';read['identity'][3]=len(cache);read['dependency']=dict(name='@cmake-cache',relativePath='sources.cmake',registrationSequence=root['sequence'])
  self.assertEqual(self.inspect(rows,values)['observedPreparedDependencyReadCaptures'],1)
  read['dependency']['registrationSequence']=999
  with self.assertRaises(ValueError):self.inspect(rows,values)
 def test_missing_registration_changed_bytes_wrong_path_or_mode(self):
  for mutation in ['binding','path','mode','sha','register']:
   r,v=self.fixture();read=next(x for x in r if x['kind']=='fd-capture')
   if mutation=='binding':del read['dependency']
   elif mutation=='path':read['path']='/opt/qlever-sdk/dependencies/fsst/not-in-inventory.h';read['dependency']['relativePath']='not-in-inventory.h'
   elif mutation=='mode':read['identity'][2]=0o100755
   elif mutation=='sha':v[read['original']['path']]=b'bad'
   else:read['dependency']['registrationSequence']=999
   with self.subTest(mutation=mutation),self.assertRaises(ValueError):self.inspect(r,v)
 def test_physical_closed_set_modes_symlink_and_provider_contract(self):
  value=dict(schemaVersion=1,files=1,bytes=1,shards=[{}]);row=dict(path='.git/HEAD',kind='file',mode=0o644,bytes=1,sha256='a'*64)
  self.assertEqual(list(m.dependency_inventory_rows(value,[dict(schemaVersion=1,files=[row])],10)),['.git/HEAD'])
  for change in [dict(path='../escape'),dict(mode='100644'),dict(mode=True),dict(kind='symlink',target='../../escape')]:
   with self.subTest(change=change),self.assertRaises(ValueError):m.dependency_inventory_rows(value,[dict(schemaVersion=1,files=[dict(row,**change)])],10)
  with self.assertRaises(ValueError):m.probe_mount_readonly('/opt/qlever-sdk/dependencies/fsst/input.h',b'1 0 0:1 / / ro - ext4 root ro\n2 1 0:2 / /opt/qlever-sdk/dependencies/fsst rw - ext4 deps rw\n')
 def test_self_consistent_collection_and_prepared_hashes_cannot_rename_declared_root(self):
  rows,values=self.fixture();root=next(r for r in rows if r['kind']=='prepared-dependency-source-root');ref=root['collectionOriginal'];body=json.loads(values[ref['path']]);body['dependencies'][0].update(name='undeclared',sourceRoot='/opt/qlever-sdk/dependencies/undeclared')
  def rebind(reference,data):
   values[reference['path']]=data;sha=hashlib.sha256(data).hexdigest()
   def visit(value):
    if isinstance(value,dict):
     if value.get('path')==reference['path']:value.update(bytes=len(data),sha256=sha)
     for child in value.values():visit(child)
    elif isinstance(value,list):
     for child in value:visit(child)
   visit(rows)
  rebind(ref,json.dumps(body,sort_keys=True).encode());prepared_ref=root['sourcePreparedOriginal'];prepared=json.loads(values[prepared_ref['path']]);prepared['dependencyCollection'].update(bytes=ref['bytes'],sha256=ref['sha256']);rebind(prepared_ref,json.dumps(prepared,sort_keys=True).encode());root.update(name='undeclared',sourceRoot='/opt/qlever-sdk/dependencies/undeclared')
  with self.assertRaisesRegex(ValueError,'declaration name'):self.inspect(rows,values)
 def test_actual_declaration_projection_rejects_fabricated_universe_and_dynamic_options(self):
  original=b'FetchContent_Declare(fsst GIT_REPOSITORY https://github.com/cwida/fsst.git GIT_TAG '+b'a'*40+b')\nFetchContent_MakeAvailable(fsst)\n';declarations=m.parse_fetchcontent_declarations(original.decode());collection=dict(declarationSource=dict(sourcePath='/opt/qlever-sdk/source/CMakeLists.txt'),dependencies=[dict(declaration=declarations[0])])
  self.assertIn(b'FETCHCONTENT_SOURCE_DIR_FSST',m.dependency_declaration_projection(collection,original))
  collection['dependencies'][0]['declaration']=dict(declarations[0],name='arbitrary-extra')
  with self.assertRaises(ValueError):m.dependency_declaration_projection(collection,original)
  with self.assertRaises(ValueError):m.parse_fetchcontent_declarations(original.decode().replace('https://github.com/cwida/fsst.git','${URL}'))
 def test_fixed_root_and_unique_source_original_registration(self):
  prepared=dict(dependencyCollection=dict(path='fetchcontent/materials.json'));collection=dict(schemaVersion=1,kind='qlever-sdk-fetchcontent-prepared-originals',sourceRoot='/opt/qlever-sdk/source',dependenciesRoot='/opt/qlever-sdk/dependencies',dependencies=[dict(name='fsst',sourceRoot='/etc',sourceInventory={},sourceOriginals=dict(kind='git',file={}))])
  with self.assertRaises(ValueError):m.dependency_collection_contract(prepared,collection)
if __name__=='__main__':unittest.main()
