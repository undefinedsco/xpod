import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('afs_source_originals',ROOT/'scripts/lib/independent-admission/afs-source-originals.py')
observer=importlib.util.module_from_spec(spec);spec.loader.exec_module(observer)

def archive(rows):
    output=io.BytesIO()
    with tarfile.open(fileobj=output,mode='w',format=tarfile.USTAR_FORMAT) as tar:
        for name,body,kind in rows:
            item=tarfile.TarInfo(name);item.mode=0o644
            if kind=='link':item.type=tarfile.SYMTYPE;item.linkname=body.decode();tar.addfile(item)
            else:item.size=len(body);tar.addfile(item,io.BytesIO(body))
    return output.getvalue()

class TestAfsSourceOriginals(unittest.TestCase):
    def run_case(self,mutation=None,remaining=10000):
        files={'helper/src/main.rs':b'fn main() {}\n','packages/xpod-cli/scripts/rebuild-native.ts':b'// fixed recipe\n'}
        kit={'schemaVersion':1,'status':'native-source-materials','toolchain':'nightly-2026-09-30','engine':{'commit':'a'*40},'files':[{'path':p,'sha256':hashlib.sha256(b).hexdigest(),'sizeBytes':len(b)} for p,b in files.items()]}
        raw=json.dumps(kit).encode();rows=[('native-source/source-kit.json',raw,'file')]+[('native-source/'+p,b,'file') for p,b in files.items()]
        if mutation:rows=mutation(rows)
        source_tar=archive(rows)
        if mutation is trailing:source_tar+=b'not a tar member'
        source=gzip.compress(source_tar)
        package=gzip.compress(archive([('install/sources/native-source.tar.gz',source,'file'),('install/helper/agentfs-pod',b'actual helper','file')]))
        with tempfile.TemporaryDirectory(prefix='afs-source-',dir=ROOT/'.test-data') as directory:
            path=Path(directory)/'original.zip'
            with zipfile.ZipFile(path,'w',compression=zipfile.ZIP_DEFLATED) as outer:outer.writestr('source-kit.json',raw);outer.writestr('xpod-cli-linux-x64.tar.gz',package)
            result=observer.observe(path,'xpod-cli-linux-x64.tar.gz',remaining)
        self.assertEqual(result['source']['sha256'],hashlib.sha256(source).hexdigest())
        self.assertEqual(result['source']['bytes'],len(source));self.assertEqual(result['source']['files'],2)
        return result
    def test_complete_nested_source_bytes_positive(self):self.run_case()
    def test_changed_missing_extra_and_duplicate_source_files_refused(self):
        for change in [lambda rows:rows[:-1],lambda rows:rows+[('native-source/extra',b'extra','file')],lambda rows:[*rows[:-1],(rows[-1][0],b'different','file')],lambda rows:rows+[rows[-1]]]:
            with self.subTest(change=change):
                with self.assertRaises(ValueError):self.run_case(change)
    def test_source_link_refused(self):
        with self.assertRaises(ValueError):self.run_case(lambda rows:[*rows[:-1],(rows[-1][0],b'../../outside','link')])
    def test_nonzero_tail_after_tar_eof_refused(self):
        with self.assertRaises(ValueError):self.run_case(trailing)
    def test_expired_shared_deadline_refused(self):
        with self.assertRaises(ValueError):self.run_case(remaining=0)

def trailing(rows):return rows
if __name__=='__main__':
    (ROOT/'.test-data').mkdir(exist_ok=True)
    unittest.main()
