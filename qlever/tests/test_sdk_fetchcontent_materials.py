"""Tiny local Git/archive mechanics. No network, SDK qualification or Docker."""
import hashlib
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('prepared_fetchcontent',ROOT/'qlever/scripts/sdk-fetchcontent-materials.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class FetchContentTests(unittest.TestCase):
    def setUp(self):self.parent=ROOT/'.test-data/sdk-fetchcontent-tests';self.parent.mkdir(parents=True,exist_ok=True)
    def test_literal_closed_declarations_preserve_options_and_reject_unknown_or_moving(self):
        text='''FetchContent_Declare(one GIT_REPOSITORY https://github.com/example/one.git GIT_TAG %s SOURCE_SUBDIR runtime/Cpp SYSTEM)
FetchContent_Declare(two URL https://github.com/example/two/releases/download/v1/source.tar.xz URL_HASH SHA3_224=%s EXCLUDE_FROM_ALL)
FetchContent_MakeAvailable(one two)
'''%('a'*40,'b'*56)
        rows=module.parse_declarations(text)
        self.assertEqual(rows[0]['sourceSubdir'],'runtime/Cpp');self.assertIn('SYSTEM',rows[0]['options'])
        for changed in [text.replace('a'*40,'main'),text.replace('SYSTEM','PATCH_COMMAND do-something'),text.replace('one two)','one)'),text.replace('runtime/Cpp','${source}')]:
            with self.assertRaises(ValueError):module.parse_declarations(changed)
    def test_complete_local_git_exact_commit_object_pack_and_physical_git_inventory(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            root=Path(directory).resolve();repo=root/'repo';repo.mkdir();materials=root/'materials';materials.mkdir();out=materials/'fetchcontent/one';out.mkdir(parents=True);source=root/'one'
            def git(*argv):return subprocess.check_output(['git','-c','core.hooksPath=/dev/null',*argv],cwd=repo,stderr=subprocess.DEVNULL,text=True).strip()
            git('init');(repo/'CMakeLists.txt').write_text('add_library(one INTERFACE)\n');git('add','.');git('-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-m','first');parent=git('rev-parse','HEAD')
            (repo/'file.h').write_text('actual pinned source');git('add','.');git('-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-m','second');commit=git('rev-parse','HEAD')
            budget=module.git.budgets.ExecutionBudget(time.time()+10000)
            reference=module.prepare_git(dict(repository=str(repo),commit=commit),source,out/'git',materials,budget)
            data=json.loads((materials/reference['path']).read_text());self.assertEqual(data['commit'],commit)
            subprocess.run(['git','cat-file','-e',parent+'^{commit}'],cwd=source,check=True)
            self.assertEqual(subprocess.check_output(['git','rev-parse','--is-shallow-repository'],cwd=source,text=True).strip(),'false')
            pack=data['objectPack'];self.assertEqual(module.git.ref(materials/pack['path'],materials),pack)
            inventory=module.physical_inventory(source,out,materials,budget);index=json.loads((materials/inventory['path']).read_text());rows=[]
            for shard in index['shards']:rows.extend(json.loads((materials/shard['path']).read_text())['files'])
            self.assertTrue(any(row['path']=='.git/config' for row in rows));self.assertTrue(any(row['path']=='file.h' for row in rows))
            self.assertEqual(index['files'],len(rows))
    def test_url_hash_safe_extraction_and_changed_archive_rejected(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            root=Path(directory);archive=root/'source.tar.xz';payload=b'actual source'
            with tarfile.open(archive,'w:xz') as bundle:
                info=tarfile.TarInfo('project/include/file.h');info.size=len(payload);info.mode=0o644;bundle.addfile(info,io.BytesIO(payload))
            digest=hashlib.sha3_224(archive.read_bytes()).hexdigest();module.unpack(archive,root/'source','sha3_224',digest,lambda:None)
            self.assertEqual((root/'source/include/file.h').read_bytes(),payload)
            archive.write_bytes(archive.read_bytes()+b'changed')
            with self.assertRaisesRegex(ValueError,'digest differs'):module.unpack(archive,root/'changed','sha3_224',digest,lambda:None)
    def test_growing_hash_original_rejects_before_digest_and_decode(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            root=Path(directory);archive=root/'archive.tar';initial=b'a'*32;archive.write_bytes(initial)
            opened=Path.open;read_sizes=[];digest_updates=[];original_hash=hashlib.new
            class Wrapped:
                def __init__(self,stream):self.stream=stream;self.once=False
                def __enter__(self):self.stream.__enter__();return self
                def __exit__(self,*args):return self.stream.__exit__(*args)
                def fileno(self):return self.stream.fileno()
                def read(self,size):
                    if not self.once:
                        self.once=True
                        with opened(archive,'ab') as writer:writer.write(b'x'*100)
                    block=self.stream.read(size);read_sizes.append(len(block));return block
                def seek(self,*args):raise AssertionError('Changed archive must not enter decode')
            class Digest:
                def __init__(self,algorithm):self.hash=original_hash(algorithm)
                def update(self,block):digest_updates.append(len(block));self.hash.update(block)
                def hexdigest(self):return self.hash.hexdigest()
            def source_open(path,*args,**kwargs):
                stream=opened(path,*args,**kwargs);return Wrapped(stream) if path==archive and args==('rb',) else stream
            with patch.object(Path,'open',source_open),patch.object(module,'MEMBER',64),patch.object(module.hashlib,'new',Digest):
                with self.assertRaisesRegex(ValueError,'grew beyond initial size'):module.unpack(archive,root/'source','sha256',hashlib.sha256(initial).hexdigest(),lambda:None)
            self.assertEqual(read_sizes,[33]);self.assertEqual(digest_updates,[]);self.assertFalse((root/'source').exists())

    def test_short_or_replaced_hash_original_rejects_before_seek(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            root=Path(directory);opened=Path.open
            for action,message in [('truncate','truncated while hashing'),('replace','changed during hash')]:
                archive=root/(action+'.tar');initial=b'a'*32;archive.write_bytes(initial)
                class Wrapped:
                    def __init__(self,stream):self.stream=stream;self.once=False
                    def __enter__(self):self.stream.__enter__();return self
                    def __exit__(self,*args):return self.stream.__exit__(*args)
                    def fileno(self):return self.stream.fileno()
                    def read(self,size):
                        if action=='truncate' and not self.once:
                            self.once=True
                            with opened(archive,'wb') as writer:writer.write(initial[:16])
                        block=self.stream.read(size)
                        if action=='replace' and not block and not self.once:
                            self.once=True;archive.unlink();archive.write_bytes(initial)
                        return block
                    def seek(self,*args):raise AssertionError('Changed original must not be decoded')
                def source_open(path,*args,**kwargs):
                    stream=opened(path,*args,**kwargs);return Wrapped(stream) if path==archive and args==('rb',) else stream
                with patch.object(Path,'open',source_open),self.assertRaisesRegex(ValueError,message):module.unpack(archive,root/('source-'+action),'sha256',hashlib.sha256(initial).hexdigest(),lambda:None)

    def test_hidden_extended_metadata_is_rejected_before_large_tarfile_read(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            root=Path(directory)
            for number,kind in enumerate([tarfile.GNUTYPE_LONGNAME,tarfile.GNUTYPE_LONGLINK,tarfile.XHDTYPE,tarfile.XGLTYPE]):
                metadata=tarfile.TarInfo('././@LongLink');metadata.type=kind;metadata.size=module.META+32
                raw=metadata.tobuf(format=tarfile.USTAR_FORMAT)+b'x'*metadata.size+b'\0'*((-metadata.size)%512)+b'\0'*10240
                archive=root/(str(number)+'.tar.gz');archive.write_bytes(gzip.compress(raw));reads=[];original=tarfile._Stream.read
                def instrument(stream,size):reads.append(size);return original(stream,size)
                with patch.object(tarfile._Stream,'read',instrument),self.assertRaisesRegex(ValueError,'GNU/PAX metadata'):
                    module.unpack(archive,root/('bad-'+str(number)),'sha256',hashlib.sha256(archive.read_bytes()).hexdigest(),lambda:None)
                self.assertLessEqual(max(reads),65536)
                self.assertFalse((root/('bad-'+str(number))/'input.h').exists())
    def test_metadata_aggregate_and_all_decoded_bytes_share_preallocation_bounds(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            root=Path(directory);size=module.META//2+1;item=tarfile.TarInfo('././@LongLink');item.type=tarfile.GNUTYPE_LONGNAME;item.size=size
            block=item.tobuf(format=tarfile.USTAR_FORMAT)+b'x'*(size-1)+b'\0'+b'\0'*((-size)%512)
            archive=root/'aggregate.tar.gz';archive.write_bytes(gzip.compress(block+block+b'\0'*10240))
            with self.assertRaisesRegex(ValueError,'GNU/PAX metadata'):
                module.unpack(archive,root/'bad','sha256',hashlib.sha256(archive.read_bytes()).hexdigest(),lambda:None)
            archive=root/'decoded.tar.gz';archive.write_bytes(gzip.compress(b'\0'*2048))
            with patch.dict(module.LIMITS,sourceMaterialBytes=1024),self.assertRaisesRegex(ValueError,'stream byte bound'):
                module.unpack(archive,root/'decoded','sha256',hashlib.sha256(archive.read_bytes()).hexdigest(),lambda:None)

    def test_standard_bindings_have_no_population_stamp_or_download_override(self):
        value=module.cmake_bindings([dict(name='demo-lib',sourceRoot='/opt/qlever-sdk/dependencies/demo-lib')])
        self.assertIn('FETCHCONTENT_SOURCE_DIR_DEMO-LIB',value)
        self.assertIn('FETCHCONTENT_FULLY_DISCONNECTED ON',value)
        self.assertNotIn('POPULATED',value);self.assertNotIn('DOWNLOAD_COMMAND',value)
    @unittest.skipUnless(shutil.which('cmake'),'CMake runtime unavailable; Root owns real Linux configure verification')
    def test_actual_cmake_uses_standard_override_and_source_subdir(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            root=Path(directory).resolve();dep=root/'provided/runtime/Cpp';dep.mkdir(parents=True)
            (dep/'CMakeLists.txt').write_text('add_library(demo INTERFACE)\nfile(WRITE "${CMAKE_BINARY_DIR}/used.txt" "provided")\n')
            project=root/'project';project.mkdir();(project/'CMakeLists.txt').write_text('cmake_minimum_required(VERSION 3.14)\nproject(override NONE)\ninclude(FetchContent)\nFetchContent_Declare(demo-lib GIT_REPOSITORY https://invalid.example/never.git GIT_TAG '+('a'*40)+' SOURCE_SUBDIR runtime/Cpp)\nFetchContent_MakeAvailable(demo-lib)\n')
            cache=root/'sources.cmake'
            fixed='/opt/qlever-sdk/dependencies/demo-lib'
            # Relocate only this isolated fixture's standard binding; production
            # generator and observer still require the one fixed source root.
            cache.write_text(module.cmake_bindings([dict(name='demo-lib',sourceRoot=fixed)]).replace(fixed,str(root/'provided')))
            subprocess.run(['cmake','-S',str(project),'-B',str(root/'build'),'-C',str(cache)],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
            self.assertEqual((root/'build/used.txt').read_text(),'provided')

    def test_nested_unknown_and_unsafe_archive_are_not_silently_fetched(self):
        with tempfile.TemporaryDirectory(dir=self.parent) as directory:
            root=Path(directory);(root/'CMakeLists.txt').write_text('FetchContent_Declare(unknown GIT_TAG main)\n')
            with self.assertRaisesRegex(ValueError,'Unprepared nested'):module.validate_nested(root,{'one'})
            archive=root/'unsafe.tar'
            with tarfile.open(archive,'w') as bundle:
                info=tarfile.TarInfo('project/../escape');info.size=1;bundle.addfile(info,io.BytesIO(b'x'))
            with self.assertRaisesRegex(ValueError,'Unsafe'):module.unpack(archive,root/'bad','sha3_224',hashlib.sha3_224(archive.read_bytes()).hexdigest(),lambda:None)

if __name__=='__main__':unittest.main()
