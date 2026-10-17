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
spec=importlib.util.spec_from_file_location('css_zip',ROOT/'scripts/lib/css_native_zip.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

def encoded(value):return json.dumps(value).encode()
def ref(name,data):return dict(path=name,sizeBytes=len(data),sha256=hashlib.sha256(data).hexdigest())
def fixture():
    entries={};target='darwin-arm64';archive='qlever-local-runtime-'+target+'.tar.gz'
    output=io.BytesIO()
    with tarfile.open(fileobj=output,mode='w:gz') as tar:
        for name,data in [('manifest.json',b'{}'),('bin/xpod_qlever_local_runtime',b'fixture helper bytes')]:
            item=tarfile.TarInfo(name);item.size=len(data);tar.addfile(item,io.BytesIO(data))
    entries[archive]=output.getvalue();entries['qlever-local-acceptance.json']=encoded(dict(sourceSha='a'*40))
    refs=[ref('engine/input',b'source'),dict(ref('engine/link',b'input'),type='symlink',linkTarget='input',mode=0o777)]
    source_tar=io.BytesIO()
    with tarfile.open(fileobj=source_tar,mode='w') as tar:
        item=tarfile.TarInfo('engine/input');item.size=6;tar.addfile(item,io.BytesIO(b'source'))
        item=tarfile.TarInfo('engine/link');item.type=tarfile.SYMTYPE;item.linkname='input';item.mode=0o777;tar.addfile(item)
    for name,data in [('source-kit.tar',source_tar.getvalue()),('source-kit.json',encoded(dict(status='native-source-materials',files=refs))),
                      ('inputs-before.json',b'{}'),('inputs-after.json',b'{}')]: entries['native-materials/'+name]=data
    raw=b'actual fixture raw';raw_ref=ref('stages/build.raw.log',raw)
    receipt=encoded(dict(actualWait=True,exit=0,signal=None,resourceStop=None,rawClosedBeforeHash=True,ownedGroupAbsentAfterWait=True,rawSHA256=raw_ref['sha256']))
    entries['native-materials/stages/build.raw.log']=raw;entries['native-materials/stages/build.receipt.json']=receipt
    binary=ref('bin/xpod_qlever_local_runtime',b'fixture helper bytes')
    metadata=dict(target=target,record=dict(sourceSha='a'*40,binary=binary),stages=[dict(name='build',raw=raw_ref,receipt=ref('stages/build.receipt.json',receipt))])
    entries['native-materials/metadata.json']=encoded(metadata)
    final=dict(binary=binary,schemaVersion=1,status='native-build-test-materials',releaseAccepted=False,target=target,sourceSha='a'*40,nativeBuildSourceSha='a'*40,archive=ref(archive,entries[archive]))
    for key,name in [('sourceKit','source-kit.json'),('sourceArchive','source-kit.tar'),('metadata','metadata.json'),('inputsBefore','inputs-before.json'),('inputsAfter','inputs-after.json')]:
        final[key]=ref(name,entries['native-materials/'+name])
    entries['native-materials/final.json']=encoded(final)
    entries['native-materials/source-kit/engine/input']=b'source'
    entries['native-materials/source-kit/engine/link']=b'source' # Actions dereferenced upload copy, not original link authority.
    return entries

def write(root,entries):
    archive=root/'native.zip'
    with zipfile.ZipFile(archive,'w') as zip:
        for name,data in entries.items():zip.writestr(name,data)
    return archive

class CssNativeZipTest(unittest.TestCase):
    def test_complete_new_inventory_and_actual_unpack(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);archive=write(root,fixture())
            self.assertIn('native-materials/source-kit.tar',module.validate(archive,'darwin-arm64','a'*40))
            spec=importlib.util.spec_from_file_location('css_product',ROOT/'scripts/css-module-producer.py')
            producer=importlib.util.module_from_spec(spec);spec.loader.exec_module(producer)
            result=producer.unpack_native(root,root/'runtime','darwin-arm64')
            self.assertEqual(Path(result['runtimeRoot'],'bin/xpod_qlever_local_runtime').read_bytes(),b'fixture helper bytes')
    def test_unknown_member_source_target_hash_and_path_rejected(self):
        for mutation in ['extra','target','source','raw','escape','source-copy']:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                entries=fixture()
                if mutation=='extra':entries['unknown']=b'arbitrary'
                elif mutation=='target':
                    final=json.loads(entries['native-materials/final.json']);final['target']='darwin-x64';entries['native-materials/final.json']=encoded(final)
                elif mutation=='source':entries['qlever-local-acceptance.json']=encoded(dict(sourceSha='b'*40))
                elif mutation=='raw':entries['native-materials/stages/build.raw.log']=b'tampered'
                elif mutation=='escape':entries['../escape']=b'bad'
                else:entries['native-materials/source-kit/engine/link']=b'wrong dereferenced copy'
                with self.assertRaises(ValueError):module.validate(write(Path(directory),entries),'darwin-arm64','a'*40)
    def test_source_tar_link_semantics_checked_even_with_updated_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            entries=fixture();data=entries['native-materials/source-kit.tar'].replace(b'input\x00',b'other\x00')
            entries['native-materials/source-kit.tar']=data
            final=json.loads(entries['native-materials/final.json']);final['sourceArchive']=ref('source-kit.tar',data)
            entries['native-materials/final.json']=encoded(final)
            with self.assertRaises((ValueError,tarfile.TarError)):module.validate(write(Path(directory),entries),'darwin-arm64','a'*40)

if __name__=='__main__':unittest.main()
