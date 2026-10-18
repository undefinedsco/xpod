"""Actual current fixed ZIP reader keeps old domains closed; no external data."""
import hashlib,importlib.util,pathlib,tempfile,unittest,zipfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('fixed_sdk_zip',ROOT/'qlever/scripts/sdk-zip-originals.py');reader=importlib.util.module_from_spec(spec);spec.loader.exec_module(reader)
class LegacyDomains(unittest.TestCase):
 def test_legacy_domains_and_explicit_readonly_mode_do_not_mix(self):
  (ROOT/'.test-data').mkdir(exist_ok=True)
  with tempfile.TemporaryDirectory(dir=ROOT/'.test-data') as directory:
   archive=pathlib.Path(directory)/'actual.zip';prefixes=['inner/debian-source/indexes/','inner/upstream-source/','inner/toolchain-execution/','inner/debian-binary/','inner/fetchcontent/'];data=b'actual';ref=lambda name:dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
   with zipfile.ZipFile(archive,'w') as output:
    for prefix in prefixes:output.writestr(prefix+'original',data)
    output.writestr('materials.json',data)
   for prefix in prefixes:
    with reader.registered_zip_originals(archive,prefix,lambda:None) as member:
     with member(ref(prefix+'original')) as stream:self.assertEqual(stream.read(),data)
     with self.assertRaises(ValueError):member(ref('materials.json'))
    with self.assertRaises(ValueError):
     with reader.registered_zip_originals(archive,prefix,lambda:None,master_reference=ref('materials.json')):pass
   with self.assertRaises(ValueError):
    with reader.registered_zip_originals(archive,'readonly-executor/',lambda:None):pass
if __name__=='__main__':unittest.main()
