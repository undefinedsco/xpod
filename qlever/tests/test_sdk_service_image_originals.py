import copy,hashlib,importlib.util,types
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
 def test_sdk_build_locator_keeps_build_origin_separate_from_the_current_app(self):
  image='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+'a'*64
  args=types.SimpleNamespace(sdk_build_model='normal-build-v1',sdk_source_sha='b'*40,sdk_run_head_sha='c'*40,
   sdk_run_id=17,sdk_run_attempt=3,sdk_artifact_id=9,sdk_artifact_digest='d'*64,sdk_master_bytes=123,sdk_master_sha256='e'*64,
   source_sha='f'*40)
  value=service.sdk_build_locator(args,99,2,image)
  self.assertEqual(value['sourceSha'],'b'*40);self.assertEqual(value['runHeadSha'],'c'*40)
  self.assertEqual((value['runId'],value['runAttempt']),(17,3));self.assertEqual(value['sdkBuildExecutionModel'],'normal-build-v1')
  self.assertEqual(value['master'],dict(path='materials.json',bytes=123,sha256='e'*64))
  for bad in [types.SimpleNamespace(**{**vars(args),'sdk_build_model':'unknown'}),
              types.SimpleNamespace(**{**vars(args),'sdk_source_sha':'bad'}),
              types.SimpleNamespace(**{**vars(args),'sdk_run_id':0})]:
   with self.assertRaises(ValueError):service.sdk_build_locator(bad,99,2,image)
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
