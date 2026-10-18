import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import lzma
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
import zipfile

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('fetch_source',ROOT/'qlever/scripts/sdk-fetchcontent-source-bindings.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class SourceTests(unittest.TestCase):
    def setUp(self):
        self.raw={}
    def ref(self,name,raw):
        name=name.removeprefix('inner/') if name.startswith('inner/fetchcontent/') else name
        self.raw[name]=raw;return dict(path=name,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
    @contextlib.contextmanager
    def member(self,ref):
        self.assertEqual(len(self.raw[ref['path']]),ref['bytes']);self.assertEqual(hashlib.sha256(self.raw[ref['path']]).hexdigest(),ref['sha256']);yield io.BytesIO(self.raw[ref['path']])
    def git(self):
        (ROOT/'.test-data').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as directory:
            root=Path(directory)
            def run(*args,input=None):return subprocess.check_output(['git','-c','core.hooksPath=/dev/null',*args],cwd=root,input=input,stderr=subprocess.PIPE)
            run('init');run('config','user.name','Fixture');run('config','user.email','fixture@example.invalid');(root/'x.txt').write_bytes(b'actual Git file\n');run('add','x.txt');run('commit','-m','fixture')
            commit=run('rev-parse','HEAD').decode().strip();tree=run('rev-parse','HEAD^{tree}').decode().strip();listing=run('ls-tree','-r','-t','-z','--full-tree',commit);blob=run('rev-parse','HEAD:x.txt').decode().strip();ids='\n'.join(sorted([commit,tree,blob]))+'\n';pack=run('pack-objects','--stdout','--window=0','--depth=0','--no-reuse-delta','--no-reuse-object',input=ids.encode());data=(root/'x.txt').read_bytes()
            original=dict(schemaVersion=1,kind='qlever-sdk-dependency-git-originals',repository='https://example.invalid/repo.git',commit=commit,rootTree=tree,objectFormat='sha1',objectIdsFormat='ascii-sorted-unique-sha1-lf',commitOriginal=self.ref('commit',run('cat-file','commit',commit)),treeListing=self.ref('tree',listing),objectIds=self.ref('ids',ids.encode()),objectPack=self.ref('pack',pack),prepatchInventory=self.ref('pre',json.dumps(dict(schemaVersion=1,files=[dict(path='x.txt',mode='100644',blobOid=blob,bytes=len(data),sha256=hashlib.sha256(data).hexdigest())])).encode()))
            rows={'x.txt':dict(kind='file',mode=0o644,bytes=len(data),sha256=hashlib.sha256(data).hexdigest()),'.git/HEAD':dict(kind='file',mode=0o644,bytes=4,sha256=hashlib.sha256(b'HEAD').hexdigest())};return original,dict(method='git',repository=original['repository'],commit=commit),rows
    def verify_git(self,original,declaration,rows):return module.verify_git(original,declaration,rows,lambda ref:self.raw[ref['path']],self.member,lambda:None)
    def test_actual_local_git_pack_closes_tree_and_physical_files(self):
        original,declaration,rows=self.git();result=self.verify_git(original,declaration,rows);self.assertEqual(result['files'],1);self.assertEqual(result['gitMetadataFiles'],1)
    def test_changed_physical_blob_and_extra_file_rejected(self):
        original,declaration,rows=self.git()
        for changed in [dict(rows,**{'x.txt':dict(rows['x.txt'],sha256='0'*64)}),dict(rows,extra=rows['x.txt'])]:
            with self.assertRaises(ValueError):self.verify_git(original,declaration,changed)
    def test_wrong_pin_and_missing_root_tree_rejected(self):
        original,declaration,rows=self.git()
        with self.assertRaises(ValueError):self.verify_git(original,dict(declaration,commit='0'*40),rows)
        ids=self.raw[original['objectIds']['path']].decode().replace(original['rootTree']+'\n','');original['objectIds']=self.ref('ids',ids.encode())
        with self.assertRaises(ValueError):self.verify_git(original,declaration,rows)
    def url(self):
        raw=io.BytesIO()
        with tarfile.open(fileobj=raw,mode='w') as tar:
            root=tarfile.TarInfo('root');root.type=tarfile.DIRTYPE;tar.addfile(root);item=tarfile.TarInfo('root/x.txt');item.mode=0o644;item.size=3;tar.addfile(item,io.BytesIO(b'abc'))
        packed=lzma.compress(raw.getvalue());declaration=dict(method='url',url='https://example.invalid/source.tar.xz',algorithm='sha3_224',digest=hashlib.sha3_224(packed).hexdigest());original=dict(schemaVersion=1,kind='qlever-sdk-dependency-archive-originals',**{k:v for k,v in declaration.items() if k!='method'},archive=self.ref('archive.tar.xz',packed));rows={'x.txt':dict(kind='file',mode=0o644,bytes=3,sha256=hashlib.sha256(b'abc').hexdigest())};return original,declaration,rows
    def test_url_original_digest_and_all_unpacked_bytes(self):
        original,declaration,rows=self.url();self.assertEqual(module.verify_url(original,declaration,rows,self.member,lambda:None)['files'],1)
    def test_changed_url_physical_mode_and_hash_reject(self):
        original,declaration,rows=self.url()
        for key,value in [('mode',0o755),('sha256','0'*64)]:
            changed=copy.deepcopy(rows);changed['x.txt'][key]=value
            with self.assertRaises(ValueError):module.verify_url(original,declaration,changed,self.member,lambda:None)
    def test_actual_archive_digest_not_self_report(self):
        original,declaration,rows=self.url();declaration['digest']='0'*56;original['digest']=declaration['digest']
        with self.assertRaises(ValueError):module.verify_url(original,declaration,rows,self.member,lambda:None)
    def test_metadata_refs_are_relative_and_physical_rows_remain_lexical(self):
        spec=importlib.util.spec_from_file_location('source_observer',ROOT/'qlever/scripts/sdk-fetchcontent-source-observer.py');observer=importlib.util.module_from_spec(spec);spec.loader.exec_module(observer)
        seal=dict(path='fetchcontent/a.json',bytes=3,sha256='a'*64)
        self.assertEqual(observer.rooted_metadata_references(dict(file=seal))['file']['path'],'inner/fetchcontent/a.json')
        self.assertEqual(seal['path'],'fetchcontent/a.json')
        for path in ['inner/fetchcontent/a.json','fetchcontent/../a','fetchcontent//a','/fetchcontent/a','fetchcontent/a\\b']:
            with self.assertRaises(ValueError):observer.rooted_metadata_references(dict(seal,path=path))
        # Inventory shard rows are consumed directly, never passed through the metadata projector.
        self.assertEqual(module.physical_rows(dict(schemaVersion=1,files=1,bytes=3),[dict(schemaVersion=1,files=[dict(path='x.txt',kind='file',mode=0o644,bytes=3,sha256='a'*64)])])['x.txt']['bytes'],3)
    def test_same_zip_full_url_scan_and_tampered_original_reject(self):
        spec=importlib.util.spec_from_file_location('source_observer',ROOT/'qlever/scripts/sdk-fetchcontent-source-observer.py');observer=importlib.util.module_from_spec(spec);spec.loader.exec_module(observer)
        original,declaration,rows=self.url();text=('FetchContent_Declare(demo URL https://github.com/example/source/archive.tar.xz URL_HASH SHA3_224='+declaration['digest']+')\nFetchContent_MakeAvailable(demo)\n').encode();declared=observer.shared.parse_fetchcontent_declarations(text.decode())[0]
        # All refs point to retained same-ZIP originals. The declaration is not an official origin capability.
        archive=original['archive'];original['archive']=self.ref('inner/fetchcontent/archive.tar.xz',self.raw.pop(archive['path']));original['url']=declared['url']
        physical=[dict(path=path,**row) for path,row in rows.items()]
        shard=self.ref('inner/fetchcontent/inventory-0000.json',json.dumps(dict(schemaVersion=1,files=physical)).encode());index=self.ref('inner/fetchcontent/inventory.json',json.dumps(dict(schemaVersion=1,files=1,bytes=3,shards=[shard])).encode())
        row=dict(name='demo',sourceRoot='/opt/qlever-sdk/dependencies/demo',declaration=declared,sourceInventory=index,sourceOriginals=dict(kind='url',file=self.ref('inner/fetchcontent/url.json',json.dumps(original).encode())))
        collection=dict(schemaVersion=1,kind='qlever-sdk-fetchcontent-prepared-originals',sourceRoot='/opt/qlever-sdk/source',dependenciesRoot='/opt/qlever-sdk/dependencies',declarationSource=dict(file=self.ref('inner/fetchcontent/CMakeLists.txt',text)),dependencies=[row],cmakeCache=self.ref('inner/fetchcontent/cache.cmake',observer.shared.fetchcontent_source_bindings([row]).encode()),cmakeCachePath='/opt/qlever-sdk/dependencies/sources.cmake')
        ref=self.ref('inner/fetchcontent/materials.json',json.dumps(collection).encode());plan=dict(collection=dict(ref,path='inner/'+ref['path']),declarationSha256=hashlib.sha256(text).hexdigest(),remainingMilliseconds=30000,inputRecords=[dict(selected=True,captures=0,path='/opt/qlever-sdk/dependencies/demo/x.txt',bytes=3,mode=0o644,sha256=rows['x.txt']['sha256'])])
        cache_bytes=self.raw[collection['cmakeCache']['path']];plan['inputRecords'].append(dict(selected=True,captures=0,path=collection['cmakeCachePath'],bytes=len(cache_bytes),mode=0o644,sha256=hashlib.sha256(cache_bytes).hexdigest()))
        (ROOT/'.test-data').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as directory:
            path=Path(directory)/'source.zip'
            def write():
                with zipfile.ZipFile(path,'w') as archive:
                    for name,data in self.raw.items():
                        if name.startswith('fetchcontent/'):archive.writestr('inner/'+name,data)
            write();result=observer.observe(path,plan);self.assertEqual(result['selectedInputs'],2);self.assertEqual(result['selectedGeneratedCacheInputs'],1);self.assertTrue(result['declaredSourceByteClosureVerified']);self.assertFalse(result['overallSourceAuthorityVerified'])
            captured=copy.deepcopy(plan);captured['inputRecords'][0]['captures']=2
            captured['sourceReferenceSeal']=dict(prepared=dict(path='inner/source-prepared.json',bytes=7,sha256='a'*64),collection=plan['collection'],declaration=dict(collection['declarationSource']['file'],path='inner/'+collection['declarationSource']['file']['path']),cache=dict(collection['cmakeCache'],path='inner/'+collection['cmakeCache']['path']))
            captured['dependencySourceReadOriginals']={key:{field:row[field] for field in ['bytes','sha256']} for key,row in captured['sourceReferenceSeal'].items()}
            observed=observer.observe(path,captured);self.assertEqual(observed['observedDependencyReadCaptures'],2);self.assertTrue(observed['dependencySourceReadOriginsVerified'])
            for role in ['prepared','collection','declaration','cache']:
                changed=copy.deepcopy(captured);changed['dependencySourceReadOriginals'][role]['sha256']='0'*64
                with self.assertRaises(ValueError):observer.observe(path,changed)
            changed=copy.deepcopy(captured);changed['sourceReferenceSeal']['declaration']['path']='inner/fetchcontent/other'
            with self.assertRaises(ValueError):observer.observe(path,changed)

            for key,value in [('sha256','0'*64),('mode',0o755),('bytes',len(cache_bytes)+1)]:
                changed=copy.deepcopy(plan);changed['inputRecords'][1][key]=value
                with self.assertRaises(ValueError):observer.observe(path,changed)
            changed=copy.deepcopy(plan);changed['inputRecords'][0]['sha256']='0'*64
            with self.assertRaises(ValueError):observer.observe(path,changed)
            changed=copy.deepcopy(plan);changed['inputRecords'][0]['path']='/opt/qlever-sdk/dependencies/unregistered/x.txt'
            with self.assertRaises(ValueError):observer.observe(path,changed)
            saved_collection=self.raw[ref['path']];changed_collection=copy.deepcopy(collection);changed_collection['cmakeCachePath']='/opt/qlever-sdk/dependencies/demo/arbitrary.cmake';changed_ref=self.ref(ref['path'],json.dumps(changed_collection).encode());write();changed=copy.deepcopy(plan);changed['collection']=dict(changed_ref,path='inner/'+changed_ref['path'])
            with self.assertRaises(ValueError):observer.observe(path,changed)
            self.raw[ref['path']]=saved_collection
            self.raw['fetchcontent/archive.tar.xz']=self.raw['fetchcontent/archive.tar.xz'][:-1]+b'x';write()
            with self.assertRaises((ValueError,EOFError,lzma.LZMAError)):observer.observe(path,plan)
if __name__=='__main__':unittest.main()
