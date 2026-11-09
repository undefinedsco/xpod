import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
observer=load('cpp_observer',ROOT/'qlever/scripts/observe-macos-native-materials.py')
parser=load('cache_reader_cpp',ROOT/'qlever/scripts/validate-prior-sdk.py')

class LocalCppToolchainTest(unittest.TestCase):
    def test_cxx_only_cache_layout_matches_real_local_project_language(self):
        for name in ['qlever_local_runtime','qlever_adapter','rdf_sqlite_backend']:
            self.assertIn('LANGUAGES CXX)',(ROOT/'qlever'/name/'CMakeLists.txt').read_text())
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);cxx=root/'clang++';cxx.write_bytes(b'compiler identity fixture')
            cc=root/'clang';cc.write_bytes(b'C compiler fixture')
            cache=root/'CMakeCache.txt'
            cache.write_text('//CXX compiler\nCMAKE_CXX_COMPILER:FILEPATH='+str(cxx)+'\nCMAKE_OSX_DEPLOYMENT_TARGET:STRING=15.0\nCMAKE_PROJECT_NAME:STATIC=xpod_qlever_local_runtime\n')
            values=parser.parse_cache(cache)
            self.assertNotIn('CMAKE_C_COMPILER',values)
            observer.verify_local_cpp_toolchain(values,cc,cxx,'15.0')
            values['CMAKE_C_COMPILER']=str(cc)
            observer.verify_local_cpp_toolchain(values,cc,cxx,'15.0')
            for updates in [{'CMAKE_CXX_COMPILER':''},{'CMAKE_CXX_COMPILER':str(cc)},
                            {'CMAKE_C_COMPILER':str(cxx)},{'CMAKE_OSX_DEPLOYMENT_TARGET':'14.0'}]:
                with self.assertRaises(RuntimeError):observer.verify_local_cpp_toolchain(dict(values,**updates),cc,cxx,'15.0')
            del values['CMAKE_CXX_COMPILER']
            with self.assertRaisesRegex(RuntimeError,'CMAKE_CXX_COMPILER'):observer.verify_local_cpp_toolchain(values,cc,cxx,'15.0')
if __name__=='__main__':unittest.main()
