"""Same-FD ZIP mechanics; no source authority is claimed by these fixtures."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

HERE = Path(__file__).resolve().parents[1] / 'scripts'
def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / name)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value
module = load('sdk-service-native-runtime-receiver.py')
zip_module = load('sdk-zip-originals.py')
def ref(path, data): return dict(path=path, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())

class ReceiverMechanics(unittest.TestCase):
    def test_bounded_originals_and_closed_set(self):
        base = HERE.parents[1] / '.test-data/native-receiver-tests'; base.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            path = Path(directory) / 'actual.zip'; data=b'actual original'
            original=ref('capture.raw', data)
            master=dict(schemaVersion=1, kind='candidate-service-native-runtime-originals',
                        identity=dict(sourceSha='1'*40,runId=1,runAttempt=1,sdkProfile='service-trixie',target='linux-x64'),
                        sourceFactsVerified=False,sourceAuthorityVerified=False,
                        originals=[original],retainedOriginalBytes=len(data))
            raw=json.dumps(master).encode(); master_ref=ref('materials.json',raw)
            with zipfile.ZipFile(path,'w') as archive:
                archive.writestr('materials.json',raw);archive.writestr('capture.raw',data)
            with zip_module.registered_zip_originals(path,'native-runtime/',lambda:None,master_reference=master_ref) as member:
                reader=module.MemberReader(member,lambda:None)
                registered,total=module.validate_closed_set(master,member.names,reader,1024,master_ref)
                self.assertEqual(total,len(raw)+len(data));self.assertEqual(registered,{'capture.raw':original})
                with self.assertRaises(ValueError):list(reader.blocks(dict(original,sha256='0'*64),1024))
                with self.assertRaises(ValueError):module.validate_closed_set(master,list(member.names)+['extra'],reader,1024,master_ref)
                with self.assertRaises(ValueError):module.validate_closed_set(master,member.names,reader,total-1,master_ref)
                with self.assertRaises(ValueError):module.validate_closed_set(dict(master,sourceAuthorityVerified=True),member.names,reader,1024,master_ref)
                with self.assertRaises(ValueError):member(dict(master_ref,sha256='0'*64))

    def test_path_and_identity_rejections(self):
        for path in ('/abs','a/../b','a//b','a\\b','a\x00b'):
            with self.assertRaises(ValueError):module.ref(dict(path=path,bytes=1,sha256='a'*64))
        with self.assertRaises(ValueError):module.ref(dict(path='ok',bytes=True,sha256='a'*64))

if __name__ == '__main__': unittest.main()
