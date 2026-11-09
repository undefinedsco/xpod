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

def linux_fixture(target='linux-x64'):
    mac=fixture();entries={}
    archive='qlever-local-runtime-'+target+'.tar.gz'
    entries[archive]=mac['qlever-local-runtime-darwin-arm64.tar.gz']
    entries['original/manifest.json']=b'original runtime manifest fixture'
    entries['physical/runtime/manifest.json']=b'{}'
    entries['physical/runtime/bin/xpod_qlever_local_runtime']=b'fixture helper bytes'
    physical_files=[dict(path=name.removeprefix('physical/runtime/'),bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
                    for name,data in entries.items() if name.startswith('physical/runtime/')]
    physical=dict(target=target,ok=True,failure=None,releaseAccepted=False,
                  originalManifestSHA256=hashlib.sha256(entries['original/manifest.json']).hexdigest(),files=physical_files)
    entries['physical/abi/physical-runtime.receipt.safe.json']=encoded(physical)
    profile=dict(profile='module-bookworm-gcc12',glibc='2.36',machine='aarch64' if target=='linux-arm64' else 'x86_64')
    entries['sdk-profile/inputs.json']=encoded(profile)
    raw=b'actual Linux stage fixture raw';entries['stages/build.raw.log']=raw
    entries['stages/build.receipt.json']=encoded(dict(actualWait=True,exit=0,signal=None,resourceStop=None,
        rawClosedBeforeHash=True,ownedGroupAbsentAfterWait=True,rawSHA256=hashlib.sha256(raw).hexdigest()))
    result=dict(schemaVersion=1,status='native-build-test-materials',releaseAccepted=False,target=target,sourceSha='a'*40,
        archive=dict(path=archive,bytes=len(entries[archive]),sha256=hashlib.sha256(entries[archive]).hexdigest()),
        files=[dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest()) for name,data in entries.items()],
        compilerProfile=profile,sdkImage='ghcr.io/example/sdk@sha256:'+'c'*64,runtimeImage='ghcr.io/example/runtime@sha256:'+'d'*64,
        stages=dict(build=dict(receiptSha256=hashlib.sha256(entries['stages/build.receipt.json']).hexdigest(),rawSha256=hashlib.sha256(raw).hexdigest())))
    for name,field in [('physical/runtime/bin/xpod_qlever_local_runtime','runtimeBinarySha256'),('original/manifest.json','originalManifestSha256'),
                       ('physical/runtime/manifest.json','physicalManifestSha256'),('physical/abi/physical-runtime.receipt.safe.json','abiReceiptSha256')]:
        result[field]=hashlib.sha256(entries[name]).hexdigest()
    entries['native-build-materials.json']=encoded(result)
    return entries

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
    def test_linux_complete_native_inventory_and_unpack_both_targets(self):
        for target in ['linux-arm64','linux-x64']:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                root=Path(directory);archive=write(root,linux_fixture(target))
                self.assertIn('native-build-materials.json',module.validate(archive,target,'a'*40))
                spec=importlib.util.spec_from_file_location('css_product',ROOT/'scripts/css-module-producer.py')
                producer=importlib.util.module_from_spec(spec);spec.loader.exec_module(producer)
                result=producer.unpack_native(root,root/'runtime',target)
                self.assertEqual(result['format'],'linux-native-materials')
                self.assertNotIn('acceptance',result)
                self.assertEqual(result['producerReceipt']['path'],'native-build-materials.json')
    def test_linux_extra_target_source_and_missing_loader_rejected(self):
        for mutation in ['extra','target','source','loader','stage']:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                entries=linux_fixture();result=json.loads(entries['native-build-materials.json'])
                if mutation=='extra':entries['unregistered']=b'extra'
                elif mutation=='target':result['target']='linux-arm64'
                elif mutation=='source':result['sourceSha']='b'*40
                elif mutation=='loader':del entries['physical/runtime/bin/xpod_qlever_local_runtime']
                else:result['stages']['build']['rawSha256']='0'*64
                entries['native-build-materials.json']=encoded(result)
                with self.assertRaises(ValueError):module.validate(write(Path(directory),entries),'linux-x64','a'*40)
    def test_companion_originals_bound_to_actual_bundle_and_copy_stage(self):
        for mutation in [None,'copy-stage','original','bundle']:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                entries=fixture();final=json.loads(entries['native-materials/final.json'])
                metadata=json.loads(entries['native-materials/metadata.json'])
                metadata['stages'][0]['name']='native-build'
                member=ref('lib/companion.dylib',b'relocated library')
                metadata['loaderMembers']=[dict(member=member)]
                original=ref('kegs/example/1/lib/companion.dylib',b'original library')
                entries['native-materials/companions/originals/'+original['path']]=b'original library'
                companion=dict(schemaVersion=1,status='companion-installed-originals',releaseAccepted=False,files=[original],
                               buildRaw=metadata['stages'][0]['raw'],bindings=[dict(member=member,installedOriginal=original,pending=['source-build-unavailable'])])
                if mutation=='copy-stage':companion['buildRaw']=dict(companion['buildRaw'],sha256='0'*64)
                elif mutation=='original':entries['native-materials/companions/originals/'+original['path']]=b'tampered'
                elif mutation=='bundle':companion['bindings'][0]['member']=dict(member,sha256='0'*64)
                entries['native-materials/companions/materials.json']=encoded(companion)
                final['companionMaterials']=ref('companions/materials.json',entries['native-materials/companions/materials.json'])
                entries['native-materials/metadata.json']=encoded(metadata)
                final['metadata']=ref('metadata.json',entries['native-materials/metadata.json'])
                entries['native-materials/final.json']=encoded(final)
                if mutation is None:module.validate(write(Path(directory),entries),'darwin-arm64','a'*40)
                else:
                    with self.assertRaises(ValueError):module.validate(write(Path(directory),entries),'darwin-arm64','a'*40)
    def test_hidden_formula_recipe_is_required_as_original_not_size_fallback(self):
        entries=fixture();final=json.loads(entries['native-materials/final.json']);metadata=json.loads(entries['native-materials/metadata.json'])
        metadata['stages'][0]['name']='native-build';member=ref('lib/companion.dylib',b'output')
        metadata['loaderMembers']=[dict(member=member)]
        binary=ref('kegs/example/1/lib/libexample.dylib',b'installed original')
        recipe=ref('kegs/example/1/.brew/example.rb',b'actual formula recipe')
        companion=dict(schemaVersion=1,status='companion-installed-originals',releaseAccepted=False,files=[binary,recipe],
                       buildRaw=metadata['stages'][0]['raw'],bindings=[dict(member=member,installedOriginal=binary,pending=['source-build-unavailable'])])
        for original,data in [(binary,b'installed original'),(recipe,b'actual formula recipe')]:entries['native-materials/companions/originals/'+original['path']]=data
        entries['native-materials/companions/materials.json']=encoded(companion)
        final['companionMaterials']=ref('companions/materials.json',entries['native-materials/companions/materials.json'])
        entries['native-materials/metadata.json']=encoded(metadata);final['metadata']=ref('metadata.json',entries['native-materials/metadata.json'])
        entries['native-materials/final.json']=encoded(final)
        with tempfile.TemporaryDirectory() as directory:module.validate(write(Path(directory),entries),'darwin-arm64','a'*40)
        del entries['native-materials/companions/originals/'+recipe['path']]
        with tempfile.TemporaryDirectory() as directory,self.assertRaisesRegex(ValueError,r'\.brew/example\.rb'):
            module.validate(write(Path(directory),entries),'darwin-arm64','a'*40)
    def test_source_tar_link_semantics_checked_even_with_updated_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            entries=fixture();data=entries['native-materials/source-kit.tar'].replace(b'input\x00',b'other\x00')
            entries['native-materials/source-kit.tar']=data
            final=json.loads(entries['native-materials/final.json']);final['sourceArchive']=ref('source-kit.tar',data)
            entries['native-materials/final.json']=encoded(final)
            with self.assertRaises((ValueError,tarfile.TarError)):module.validate(write(Path(directory),entries),'darwin-arm64','a'*40)

if __name__=='__main__':unittest.main()
