import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('generation_tests',ROOT/'qlever/scripts/sdk-generation-materials.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
# ACTUAL `link.txt` shape for a Unix-Makefiles C++ link step: ONE shell command on
# ONE line (CMake writes the link line as a single line), objects then `-o <target>`.
# Previously this fixture used a three-line string with two `-o` flags, which is not
# a valid link command at all; only the existence/regularity of the original is
# parsed here, but the fixture bytes must still be truthful.
LINK_TXT = ('/usr/bin/c++ -O2 CMakeFiles/qlever-server.dir/main.cpp.o '
            'CMakeFiles/qlever-server.dir/server.cpp.o -o qlever-server\n')


class GenerationMaterialsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):(ROOT/'.test-data/sdk-cmake-generation').mkdir(parents=True,exist_ok=True)
    def test_no_trace_or_source_override(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data/sdk-cmake-generation') as directory:
            root=Path(directory)
            for argv in [['cmake','--trace','-S',str(root),'-B',str(root/'build')],['cmake','-S',str(root/'other'),'-B',str(root/'build')]]:
                with self.assertRaises(ValueError):module.configure(root/'generation',root,root/'build',argv,lambda:None)
            self.assertFalse((root/'generation').exists())
    def test_streaming_metadata_bound_and_deadline_callback(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data/sdk-cmake-generation') as directory:
            path=Path(directory)/'limited.json';calls=[]
            with patch.object(module,'METADATA',32):
                with self.assertRaisesRegex(ValueError,'metadata byte bound'):
                    module.write(path,{'rows':list(range(100))},lambda:calls.append(1))
            self.assertLessEqual(path.stat().st_size,32);self.assertGreater(len(calls),1)
    def test_oversized_metadata_is_rejected_before_hash_or_archive(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data/sdk-cmake-generation') as directory:
            root=Path(directory);build=root/'build';(build/'CMakeFiles/demo.dir').mkdir(parents=True)
            for name in ['CMakeCache.txt','compile_commands.json','CMakeFiles/Makefile.cmake']:(build/name).write_text('original')
            (build/'CMakeFiles/qlever-server.dir').mkdir(parents=True)
            (build/'CMakeFiles/qlever-server.dir/link.txt').write_text(LINK_TXT)
            large=build/'CMakeFiles/demo.dir/build.make'
            with large.open('wb') as stream:stream.truncate(module.MEMBER+1)
            def identity(path):
                self.assertNotEqual(path,large)
                return dict(bytes=8,sha256='a'*64,mode=0o644)
            with self.assertRaisesRegex(ValueError,'metadata member bound'):
                module.snapshot(root/'materials',build,'before',lambda *args:self.fail('archive called'),identity,lambda:None)
    def test_shared_regular_input_identity_stops_at_first_growth_chunk(self):
        spec=importlib.util.spec_from_file_location('generation_inner_bound',ROOT/'qlever/scripts/sdk-inner-materials.py')
        inner=importlib.util.module_from_spec(spec);spec.loader.exec_module(inner)
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data/sdk-cmake-generation') as directory:
            target=Path(directory)/'metadata';target.write_bytes(b'x'*(65536+8));opened=Path.open;reads=[]
            class Reader:
                def __init__(self,stream):self.stream=stream
                def __enter__(self):return self
                def __exit__(self,*args):self.stream.close()
                def fileno(self):return self.stream.fileno()
                def read(self,size):
                    reads.append(size);value=self.stream.read(size)
                    if len(reads)==1:
                        with opened(target,'ab') as writer:writer.write(b'growth'*40000)
                    return value
            def instrument(path,mode='r',*args,**kwargs):
                stream=opened(path,mode,*args,**kwargs)
                return Reader(stream) if path==target and mode=='rb' else stream
            with patch.object(Path,'open',instrument):
                with self.assertRaisesRegex(ValueError,'grew beyond observed bound'):inner.file_identity(target)
            self.assertEqual(reads,[65536,65536])
    def test_required_and_top_makefile_symlinks_cannot_escape_build_root(self):
        for name in ['CMakeCache.txt','compile_commands.json','Makefile']:
            with self.subTest(name=name), tempfile.TemporaryDirectory(dir=ROOT/'.test-data/sdk-cmake-generation') as directory:
                root=Path(directory);build=root/'build';(build/'CMakeFiles').mkdir(parents=True)
                for required in ['CMakeCache.txt','compile_commands.json','CMakeFiles/Makefile.cmake','Makefile']:
                    (build/required).write_text('original')
                # Unix Makefiles: link.txt is CMake-owned and MUST exist, otherwise
                # metadata_paths refuses with "link command original missing" and the
                # escaped-build-root assertion would pass for the wrong reason.
                (build/'CMakeFiles/qlever-server.dir').mkdir(parents=True,exist_ok=True)
                (build/'CMakeFiles/qlever-server.dir/link.txt').write_text(LINK_TXT)
                outside=root/'external-original';outside.write_text('outside original')
                (build/name).unlink();(build/name).symlink_to(outside)
                with self.assertRaisesRegex(ValueError,'escaped build root'):
                    module.metadata_paths(build,lambda:None)
    def test_actual_existing_metadata_only_and_escape_rejected(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.test-data/sdk-cmake-generation') as directory:
            build=Path(directory)/'build';(build/'CMakeFiles/demo.dir').mkdir(parents=True)
            for name in ['CMakeCache.txt','compile_commands.json','CMakeFiles/Makefile.cmake','CMakeFiles/demo.dir/build.make','CMakeFiles/demo.dir/DependInfo.cmake']:
                (build/name).write_text('original')
            (build/'CMakeFiles/qlever-server.dir').mkdir(parents=True)
            (build/'CMakeFiles/qlever-server.dir/link.txt').write_text(LINK_TXT)
            # 5 pre-existing originals + the required CMake-owned link.txt.
            self.assertEqual(len(module.metadata_paths(build,lambda:None)),6)
            outside=Path(directory)/'outside';outside.write_text('outside')
            (build/'CMakeFiles/demo.dir/flags.make').symlink_to(outside)
            with self.assertRaisesRegex(ValueError,'escaped build root'):module.metadata_paths(build,lambda:None)

if __name__=='__main__':unittest.main()
