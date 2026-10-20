import copy,hashlib,importlib.util
from pathlib import Path
import tempfile,unittest
HERE=Path(__file__).resolve().parents[1]/'scripts'
spec=importlib.util.spec_from_file_location('service_image',HERE/'sdk-service-image-originals.py');service=importlib.util.module_from_spec(spec);spec.loader.exec_module(service)
class ServiceOriginals(unittest.TestCase):
 def test_actual_rootfs_relationship_is_narrow_and_exact(self):
  local=dict(os='linux',architecture='amd64',rootfs={'diff_ids':['sha256:'+'a'*64]})
  image=dict(os='linux',architecture='amd64',rootfs={'diff_ids':['sha256:'+'a'*64,'sha256:'+'b'*64]},config={'Labels':{'org.opencontainers.image.source':'https://github.com/undefinedsco/xpod','org.opencontainers.image.revision':'c'*40}})
  facts=service.inspect_relationship(image,local,'c'*40);self.assertTrue(facts['serviceRootfsFromLocalRuntimeVerified']);self.assertFalse(facts['wholeSdkSourceVerified']);self.assertFalse(facts['wholeApplicationSourceVerified'])
  for mutate in [lambda row:row.update(architecture='arm64'),lambda row:row['rootfs']['diff_ids'].reverse(),lambda row:row['config']['Labels'].update({'org.opencontainers.image.revision':'d'*40})]:
   bad=copy.deepcopy(image);mutate(bad)
   with self.assertRaises(ValueError):service.inspect_relationship(bad,local,'c'*40)
 def test_fixed_registry_names_reject_mutable_or_foreign(self):
  good='ghcr.io/undefinedsco/xpod@sha256:'+'a'*64;self.assertEqual(service.exact_image(good,'xpod'),good)
  for bad in ['ghcr.io/undefinedsco/xpod:latest',good.replace('/xpod@','/foreign@'),good.replace('ghcr.io','evil.test')]:
   with self.assertRaises(ValueError):service.exact_image(bad,'xpod')
 def test_retained_bytes_are_charged_before_open_and_same_bytes_checked(self):
  class Budget:
   def check(self,*args):pass
  root=HERE.parents[1]/'.test-data/service-image-helper';root.mkdir(parents=True,exist_ok=True)
  with tempfile.TemporaryDirectory(dir=root) as directory:
   out=Path(directory);retained=service.Retained(out,Budget());ref=retained.save('root.original.json',b'abc');self.assertEqual(retained.total,3)
   with self.assertRaises(ValueError):retained.save('too-large',b'a'*(service.META+1))
   self.assertFalse((out/'too-large').exists());held=retained.reserve(3);(out/'changed').write_bytes(b'xyz')
   with self.assertRaises(ValueError):retained.settle(held,[dict(path='changed',bytes=3,sha256=ref['sha256'])])
if __name__=='__main__':unittest.main()
