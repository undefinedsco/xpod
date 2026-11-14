import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('acquisition',ROOT/'qlever/scripts/sdk-debian-source-acquisition.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class SourceAcquisitionTest(unittest.TestCase):
    def fixture(self,root):
        lists=root/'lists';lists.mkdir();(lists/'repo_dists_bookworm_InRelease').write_text('signature original')
        (lists/'repo_dists_bookworm_main_source_Sources.lz4').write_bytes(b'index original')
        keyring=root/'debian.gpg';keyring.write_bytes(b'keyring original')
        out=root/'materials';out.mkdir();(out/'ledger').write_text('libfoo:amd64\t1.0-1+b2\tfoo\t1.0-1\n')
        return lists,keyring,out
    def ref(self,path,out):
        data=path.read_bytes();return dict(path=path.relative_to(out).as_posix(),bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
    def test_exact_version_download_and_complete_originals(self):
        with tempfile.TemporaryDirectory() as directory:
            lists,keyring,out=self.fixture(Path(directory));calls=[]
            def stage(name,argv,cwd):
                calls.append(argv)
                if argv[0]=='apt-get':
                    files={'foo_1.0.orig.tar.gz':b'upstream','foo_1.0-1.debian.tar.xz':b'debian'}
                    for name,data in files.items():(cwd/name).write_bytes(data)
                    rows='\n'.join(' '+hashlib.sha256(data).hexdigest()+' '+str(len(data))+' '+name for name,data in files.items())
                    (cwd/'foo_1.0-1.dsc').write_text('Format: 3.0 (quilt)\nSource: foo\nVersion: 1.0-1\nChecksums-Sha256:\n'+rows+'\n')
                return {key:dict(path=name+'/'+key,bytes=1,sha256='a'*64) for key in ['receipt','stdout','stderr']}
            ref,used=module.acquire(out,['/usr/include/foo.h','/generated.h'],{'libfoo:amd64':b'/usr/include/foo.h\n'},
                self.ref(out/'ledger',out),100000,stage,self.ref,lambda:None,lists,keyring)
            value=json.loads((out/ref['path']).read_text())
            self.assertEqual(calls[1][-1],'foo=1.0-1');self.assertIn('--only-source',calls[1])
            self.assertEqual(len(value['packages'][0]['files']),2)
            self.assertEqual(value['unresolvedInputs'],['/generated.h'])
            self.assertEqual(len(value['indexOriginals']),1);self.assertGreater(used,0)
            self.assertTrue(value['pending'])
    def test_failure_propagates_without_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            lists,keyring,out=self.fixture(Path(directory));calls=[]
            def fail(name,argv,cwd):
                calls.append(argv)
                if argv[0]=='apt-get':raise RuntimeError('actual stage failed')
                return {key:dict(path=name+'/'+key,bytes=1,sha256='a'*64) for key in ['receipt','stdout','stderr']}
            with self.assertRaisesRegex(RuntimeError,'actual stage failed'):
                module.acquire(out,['/usr/include/foo.h'],{'libfoo:amd64':b'/usr/include/foo.h\n'},self.ref(out/'ledger',out),100000,fail,self.ref,lambda:None,lists,keyring)
            self.assertEqual(len(calls),2)
    def test_index_requires_original_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            lists,keyring,out=self.fixture(Path(directory))
            with self.assertRaisesRegex(ValueError,'budget/type'):
                module.acquire(out,['/usr/include/foo.h'],{'libfoo:amd64':b'/usr/include/foo.h\n'},self.ref(out/'ledger',out),1,None,self.ref,lambda:None,lists,keyring)

if __name__=='__main__':unittest.main()
