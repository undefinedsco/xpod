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

 def test_build_metadata_binds_index_result_without_inventing_a_config_digest(self):
  # Actual RC375 shape: docker/build-push-action with platforms reported an OCI
  # index and NO containerimage.config.digest. That field must not be required
  # or synthesized; the index digest still has to match the pushed image.
  index_digest='sha256:'+'6'*64
  index={'containerimage.descriptor':{'mediaType':'application/vnd.oci.image.index.v1+json','digest':index_digest,'size':856},
         'containerimage.digest':index_digest,'image.name':'ghcr.io/undefinedsco/xpod:sha-x'}
  self.assertIsNone(service.inspect_build_metadata(index,'ghcr.io/undefinedsco/xpod@'+index_digest))
  # Single-manifest shape keeps the strict config join.
  manifest_digest='sha256:'+'7'*64;config='sha256:'+'8'*64
  manifest={'containerimage.descriptor':{'mediaType':'application/vnd.oci.image.manifest.v1+json','digest':manifest_digest,'size':1615},
            'containerimage.digest':manifest_digest,'containerimage.config.digest':config}
  self.assertEqual(service.inspect_build_metadata(manifest,'ghcr.io/undefinedsco/xpod@'+manifest_digest),config)
  # mismatched pushed image digest in both shapes
  with self.assertRaises(ValueError):service.inspect_build_metadata(index,'ghcr.io/undefinedsco/xpod@sha256:'+'9'*64)
  with self.assertRaises(ValueError):service.inspect_build_metadata(manifest,'ghcr.io/undefinedsco/xpod@sha256:'+'9'*64)
  # index mediaType but a descriptor digest that is not the reported image digest
  bad=dict(index, **{'containerimage.descriptor':{'mediaType':'application/vnd.oci.image.index.v1+json','digest':'sha256:'+'5'*64,'size':856}})
  with self.assertRaises(ValueError):service.inspect_build_metadata(bad,'ghcr.io/undefinedsco/xpod@'+index_digest)
  # manifest mediaType with no config digest: must not be silently accepted
  bad={'containerimage.descriptor':{'mediaType':'application/vnd.oci.image.manifest.v1+json','digest':manifest_digest,'size':1615},'containerimage.digest':manifest_digest}
  with self.assertRaises(ValueError):service.inspect_build_metadata(bad,'ghcr.io/undefinedsco/xpod@'+manifest_digest)
  # config digest present but malformed / missing descriptor / wrong mediaType
  for mutate in [lambda row:row.update({'containerimage.config.digest':'sha256:short'}),
                 lambda row:row.pop('containerimage.descriptor'),
                 lambda row:row.update({'containerimage.descriptor':{'mediaType':'application/vnd.oci.image.index.v1+json','digest':manifest_digest,'size':1}})]:
   bad=copy.deepcopy(manifest);mutate(bad)
   with self.assertRaises(ValueError):service.inspect_build_metadata(bad,'ghcr.io/undefinedsco/xpod@'+manifest_digest)

if __name__=='__main__':unittest.main()
