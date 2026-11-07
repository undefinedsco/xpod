import copy,hashlib,importlib.util,json,types
from pathlib import Path
import tempfile,unittest
HERE=Path(__file__).resolve().parents[1]/'scripts'
spec=importlib.util.spec_from_file_location('service_image',HERE/'sdk-service-image-originals.py');service=importlib.util.module_from_spec(spec);spec.loader.exec_module(service)
CID='c'*64
NAME='xpod-service-output-'+'d'*32
NONCE='d'*32
CONFIG='sha256:'+'b'*64
class AbiCustodyWiring(unittest.TestCase):
 """RC386: the capture handed 15 ABI helper roles to Custody() while HELPERS held 10.
 The producer now reads the helper inventory as DATA from the custody source (ast
 literal_eval, never exec/import), so a second role->path table cannot drift. These
 tests construct the REAL Custody with real helper bytes and prove both negatives. """
 def _custody(self):
  spec=importlib.util.spec_from_file_location('abi_custody',HERE/'sdk-service-abi-source-custody.py')
  module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  return module

 def _fixture(self):
  """Real source tree, retained bodies and computed Git blob OIDs for every helper."""
  import tempfile
  custody=self._custody();root=HERE.parents[1]
  base=root/'.test-data/service-abi-custody-ctor';base.mkdir(parents=True,exist_ok=True)
  tmp=tempfile.TemporaryDirectory(dir=base);src=Path(tmp.name).resolve()
  out=src/'out';out.mkdir();refs={};rows={}
  shared=root/'scripts/lib/module-artifact-limits.json'
  target=src/'scripts/lib/module-artifact-limits.json';target.parent.mkdir(parents=True,exist_ok=True)
  target.write_bytes(shared.read_bytes())
  for role,relative in custody.HELPERS.items():
   raw=(root/relative).read_bytes()
   path=src/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
   oid=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
   ref=dict(path='body-'+role+'.original.json',bytes=len(raw),
            sha256=hashlib.sha256(raw).hexdigest())
   (out/ref['path']).write_bytes(raw);refs[ref['path']]=ref
   rows[role]=dict(path=relative,gitBlobOid=oid,body=ref)
  class Budget:
   def check(self,_seconds):return None
  retained=types.SimpleNamespace(refs=refs,out=out,budget=Budget())
  return custody,tmp,src,rows,retained

 def test_real_custody_constructor_accepts_the_complete_inventory(self):
  custody,tmp,src,rows,retained=self._fixture()
  try:
   value=custody.Custody(src,rows,retained)
   self.assertEqual(set(value.modules),set(custody.HELPERS))
   self.assertEqual(len(value.modules),15)
   value.close()
  finally:tmp.cleanup()

 def test_missing_row_raises_in_the_real_constructor(self):
  custody,tmp,src,rows,retained=self._fixture()
  try:
   for drop in ('declarations','source_custody','seed','role_collector','elf_module'):
    bad=dict(rows);bad.pop(drop)
    with self.assertRaises(ValueError):
     custody.Custody(src,bad,retained)
  finally:tmp.cleanup()

 def test_extra_row_raises_in_the_real_constructor(self):
  custody,tmp,src,rows,retained=self._fixture()
  try:
   bad=dict(rows);bad['not_a_real_helper']=dict(rows['seed'])
   with self.assertRaises(ValueError):
    custody.Custody(src,bad,retained)
  finally:tmp.cleanup()

 def test_tampered_helper_body_raises_in_the_real_constructor(self):
  custody,tmp,src,rows,retained=self._fixture()
  try:
   bad=dict(rows);tampered=dict(bad['seed']);tampered['gitBlobOid']='0'*40
   bad['seed']=tampered
   with self.assertRaises(ValueError):
    custody.Custody(src,bad,retained)
  finally:tmp.cleanup()

 def test_producer_inventory_comes_from_the_custody_source_by_data_only_read(self):
  custody=self._custody()
  self.assertEqual(service.SERVICE_ABI_HELPER_PATHS,dict(custody.HELPERS))
  self.assertEqual(len(custody.HELPERS),15)
  for required in ('role_commands','role_session','role_collector',
                   'read_budget_module','elf_module'):
   self.assertIn(required,custody.HELPERS)

 def test_data_reader_rejects_nonliteral_or_duplicate_helpers_without_executing(self):
  payload='\n'.join([
   'import sys',
   'sys.modules["xpod_should_not_run"]="executed"',
   'executed_flag=True',
   'HELPERS={"a":"qlever/scripts/x.py"}',
   'HELPERS={"b":"qlever/scripts/y.py"}',
  ])
  with self.assertRaises(ValueError):
   service.declared_abi_helpers(payload)
  self.assertNotIn('xpod_should_not_run',__import__('sys').modules)
  # A pure side effect with a valid single dict must also not run.
  import tempfile
  base=HERE.parents[1]/'.test-data/service-abi-data-reader';base.mkdir(parents=True,exist_ok=True)
  with tempfile.TemporaryDirectory(dir=base) as directory:
   marker=Path(directory)/'xpod_abi_should_not_exist'
   tricky='open(%r,"w").write("x")\nHELPERS={"a":"qlever/scripts/x.py"}' % str(marker)
   helpers=service.declared_abi_helpers(tricky)
   self.assertEqual(helpers,{'a':'qlever/scripts/x.py'})
   self.assertFalse(marker.exists(),'the data reader must never execute the source')
  # Non-literal values and bad role/path shapes are refused.
  for bad in ['HELPERS=dict(a="qlever/scripts/x.py")',
              'HELPERS={"A":"qlever/scripts/x.py"}',
              'HELPERS={"a":"/etc/passwd"}',
              'HELPERS={"a":"qlever/scripts/x.py","a":"qlever/scripts/y.py"}']:
   with self.assertRaises(ValueError,msg=bad):
    service.declared_abi_helpers(bad)

class ServiceOriginals(unittest.TestCase):
 def setUp(self):
  # Deterministic source identity for the registry fixtures that do not create a git repo.
  self._sha='f'*40
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

 def test_collector_full_capture_succeeds_on_the_real_120_second_caller_budget(self):
  # RC376: candidate.yml passes `--deadline now+120`, and the collector asks the
  # registry helper for reserve_seconds=0. Earlier the helper hard-coded a
  # 600-second reserve, so a 120-second caller always died. This drives the REAL
  # capture() with the REAL 120-second budget: only transport and Docker outputs
  # are faked.
  master=self._run_real_capture(deadline=__import__('time').time()+120)
  observed=master['images']
  self.assertEqual(master['serviceImageReferenceByDigest'],self._service_reference)
  self.assertEqual(observed['service']['configDigest'],self._service_config_digest)
  self.assertTrue(master['facts']['serviceRootfsFromLocalRuntimeVerified'])

 def test_registry_helper_keeps_the_legacy_600_second_default_reserve(self):
  # Old callers (readonly collection, normal build proof) never passed a
  # reserve and must keep the historical 600-second requirement.
  import inspect as inspect_module
  parameters=inspect_module.signature(service.images.registry_originals).parameters
  self.assertEqual(parameters['reserve_seconds'].default,600)
  for bad in (-1,'600',None,600.0,True):
   with self.assertRaises(ValueError):
    service.images.registry_originals('ghcr.io/undefinedsco/xpod@sha256:'+'a'*64,'linux-x64',
                                      Path(tempfile.mkdtemp(dir=self._root()))/'x',
                                      transport=_NeverCalled(),budget=_RecordingBudget(),reserve_seconds=bad)
  # A 120-second budget is refused under the default (legacy) reserve...
  with self.assertRaises(TimeoutError):
   service.images.registry_originals('ghcr.io/undefinedsco/xpod@sha256:'+'a'*64,'linux-x64',
                                     Path(tempfile.mkdtemp(dir=self._root()))/'legacy',
                                     transport=_NeverCalled(),budget=_RecordingBudget(seconds=120))
  # ...and accepted with the explicit zero reserve the collector asks for.
  observed=service.images.registry_originals(self._service_chain_reference(),'linux-x64',
                                             Path(tempfile.mkdtemp(dir=self._root()))/'zero',
                                             transport=self._transport(),budget=_RecordingBudget(seconds=120),reserve_seconds=0)
  self.assertEqual(observed['configDigest'],'sha256:'+hashlib.sha256(self._chain()[2]).hexdigest())

 def test_genuinely_exhausted_shared_budget_still_refuses(self):
  # reserve_seconds=0 must not disable the deadline: an already-expired budget
  # has to refuse the very first registry read.
  with self.assertRaises(TimeoutError):
   service.images.registry_originals(self._service_chain_reference(),'linux-x64',
                                     Path(tempfile.mkdtemp(dir=self._root()))/'spent',
                                     transport=_NeverCalled(),budget=_RecordingBudget(seconds=0),reserve_seconds=0)

 def _root(self):
  if not hasattr(self,'_registry_root'):
   parent=HERE.parents[1]/'.test-data/service-image-registry-budget'
   parent.mkdir(parents=True,exist_ok=True)
   temporary=tempfile.TemporaryDirectory(dir=parent)
   self.addCleanup(temporary.cleanup)
   self._registry_root=Path(temporary.name)
  return self._registry_root

 def _service_chain_reference(self):
  return 'ghcr.io/undefinedsco/xpod@sha256:'+hashlib.sha256(self._index()).hexdigest()

 def _index(self):
  return self._chain()[0]

 def _chain(self):
  rootfs=['sha256:'+'1'*64]
  local=json.dumps(dict(os='linux',architecture='amd64',rootfs=dict(diff_ids=rootfs),config=dict(Labels={})),sort_keys=True).encode()
  service=json.dumps(dict(os='linux',architecture='amd64',rootfs=dict(diff_ids=[*rootfs,'sha256:'+'2'*64]),
   config=dict(Labels={'org.opencontainers.image.revision':self._sha,'org.opencontainers.image.source':'https://github.com/undefinedsco/xpod'})),sort_keys=True).encode()
  child=json.dumps(dict(schemaVersion=2,mediaType='application/vnd.oci.image.manifest.v1+json',
   config=dict(mediaType='application/vnd.oci.image.config.v1+json',digest='sha256:'+hashlib.sha256(service).hexdigest(),size=len(service)),layers=[]),sort_keys=True).encode()
  index=json.dumps(dict(schemaVersion=2,mediaType='application/vnd.oci.image.index.v1+json',manifests=[
   dict(mediaType='application/vnd.oci.image.manifest.v1+json',digest='sha256:'+hashlib.sha256(child).hexdigest(),size=len(child),platform=dict(os='linux',architecture='amd64')),
   dict(mediaType='application/vnd.oci.image.manifest.v1+json',digest='sha256:'+'9'*64,size=1,platform=dict(os='unknown',architecture='unknown'))]),sort_keys=True).encode()
  return index,child,service,local

 def _transport(self):
  import io
  class Response(io.BytesIO):
   def __enter__(self):return self
   def __exit__(self,*_):self.close()
  index,child,config,local=self._chain()
  local_manifest=json.dumps(dict(schemaVersion=2,mediaType='application/vnd.oci.image.manifest.v1+json',
   config=dict(mediaType='application/vnd.oci.image.config.v1+json',digest='sha256:'+hashlib.sha256(local).hexdigest(),size=len(local)),layers=[]),sort_keys=True).encode()
  sdk_config=json.dumps(dict(os='linux',architecture='amd64',rootfs=dict(diff_ids=['sha256:'+'3'*64]),config=dict(Labels={})),sort_keys=True).encode()
  sdk_manifest=json.dumps(dict(schemaVersion=2,mediaType='application/vnd.oci.image.manifest.v1+json',
   config=dict(mediaType='application/vnd.oci.image.config.v1+json',digest='sha256:'+hashlib.sha256(sdk_config).hexdigest(),size=len(sdk_config)),layers=[]),sort_keys=True).encode()
  blobs={'undefinedsco/xpod':(index,child,config),
         'undefinedsco/xpod-qlever-local-runtime':(local_manifest,None,local),
         'undefinedsco/xpod-qlever-sdk':(sdk_manifest,None,sdk_config)}
  class Opener:
   def open(self,request,**_):
    url=request.full_url
    if '/token?' in url:return Response(b'{"token":"scope-limited-test-token"}')
    repository=url.split('/v2/',1)[1].split('/manifests/',1)[0].split('/blobs/',1)[0]
    manifest,platform,config=blobs[repository]
    if '/manifests/' in url:
     digest=url.rsplit('/',1)[-1]
     return Response(manifest if digest=='sha256:'+hashlib.sha256(manifest).hexdigest() else platform)
    return Response(config)
  # registry_originals accepts the transport callable directly, so hand it
  # Opener.open rather than the opener object.
  return Opener().open

 def _run_real_capture(self,deadline,image_identity='config'):
  import json,subprocess,types
  from unittest.mock import patch
  harness_spec=importlib.util.spec_from_file_location('collector_harness',HERE.parent/'tests/test_service_pack_collector_full.py')
  harness=importlib.util.module_from_spec(harness_spec);harness_spec.loader.exec_module(harness)
  case=harness.Tests();case.setUp();self.addCleanup(case.doCleanups)
  checkpoint=case.out
  source=checkpoint/'checkout';source.mkdir();raw=b'{"name":"@undefineds.co/xpod","version":"1.0.0"}'
  (source/'package.json').write_bytes(raw)
  for git_args in (['init','-q'],['add','package.json'],['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']):
   subprocess.run(['git',*git_args],cwd=source,check=True,capture_output=True)
  self._sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
  index,child,config,local=self._chain()
  service_ref='ghcr.io/undefinedsco/xpod@sha256:'+hashlib.sha256(index).hexdigest()
  self._service_reference=service_ref;self._service_config_digest='sha256:'+hashlib.sha256(config).hexdigest()
  local_manifest=json.dumps(dict(schemaVersion=2,mediaType='application/vnd.oci.image.manifest.v1+json',
   config=dict(mediaType='application/vnd.oci.image.config.v1+json',digest='sha256:'+hashlib.sha256(local).hexdigest(),size=len(local)),layers=[]),sort_keys=True).encode()
  sdk_config=json.dumps(dict(os='linux',architecture='amd64',rootfs=dict(diff_ids=['sha256:'+'3'*64]),config=dict(Labels={})),sort_keys=True).encode()
  sdk_manifest=json.dumps(dict(schemaVersion=2,mediaType='application/vnd.oci.image.manifest.v1+json',
   config=dict(mediaType='application/vnd.oci.image.config.v1+json',digest='sha256:'+hashlib.sha256(sdk_config).hexdigest(),size=len(sdk_config)),layers=[]),sort_keys=True).encode()
  local_ref='ghcr.io/undefinedsco/xpod-qlever-local-runtime@sha256:'+hashlib.sha256(local_manifest).hexdigest()
  sdk_ref='ghcr.io/undefinedsco/xpod-qlever-sdk@sha256:'+hashlib.sha256(sdk_manifest).hexdigest()
  before=checkpoint/'before.json';after=checkpoint/'after.json';before.write_bytes(raw);after.write_bytes(raw)
  metadata=checkpoint/'build.json'
  metadata.write_text(json.dumps({'containerimage.digest':service_ref.split('@')[1],
   'containerimage.descriptor':{'mediaType':'application/vnd.oci.image.index.v1+json','digest':service_ref.split('@')[1],'size':len(index)}}))
  out=checkpoint/'service-image-originals'
  # The reviewed harness reports its inspected container `.Image` from
  # case.config; drive both real identity shapes through the same fixture.
  case.out=out;case.image=service_ref
  case.config=self._service_config_digest if image_identity=='config' else service_ref.split('@')[1]
  args=types.SimpleNamespace(source_sha=self._sha,sdk_artifact_id=1,sdk_master_bytes=1,sdk_artifact_digest='a'*64,
   sdk_master_sha256='b'*64,service_image=service_ref,local_runtime_image=local_ref,sdk_image=sdk_ref,
   source=str(source),out=str(out),deadline=deadline,root_manifest_before=str(before),
   root_manifest_after=str(after),build_metadata=str(metadata),capture_service_pack_originals=False,
   capture_service_runtime_members=False,capture_service_abi_originals=False)
  def capture(label,argv,*a,**kw):
   if label.startswith('service-source-'):
    mode=label.rsplit('-',1)[-1];directory=out/'stages'/label;directory.mkdir(parents=True)
    body=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source) if mode=='head' else (raw if mode=='manifest' else b'')
    row=dict(name=label,inputs=[],outputs=[])
    for role in ['receipt','stdout','stderr','supervisionReceipt','supervisionRaw']:
     path=directory/(role+'.raw');data=body if role=='stdout' else b'{}';path.write_bytes(data)
     row[role]=service.outer.commands.ref(str(path),str(out))
    return row
   return case.capture(label,argv,*a,**kw)
  with patch.dict(service.os.environ,{'GITHUB_SHA':self._sha,'GITHUB_RUN_ID':'1','GITHUB_RUN_ATTEMPT':'1','RUNNER_TEMP':str(checkpoint),'GITHUB_OUTPUT':str(checkpoint/'github-output')}),patch.object(service.secrets,'token_hex',return_value=case.nonce),patch.object(service.outer.commands,'capture',side_effect=capture),patch.object(service.images.urllib.request,'build_opener',side_effect=lambda *a,**k:_OpenerAdapter(self._transport())):
   return service.capture(args)

 def test_inspect_binds_index_digest_identity_without_accepting_arbitrary_image_ids(self):
  # RC377: the pushed service image is an OCI index, so `docker container
  # inspect .Image` may report the reference digest rather than the config
  # digest. Both are real, distinct identities for the same reference.
  config=CONFIG
  index_digest='sha256:'+'1'*64
  image='ghcr.io/undefinedsco/xpod@'+index_digest
  def payload(**over):
   row=dict(Id=CID,Name='/'+NAME,Image=index_digest,
            Config=dict(Image=image,Labels={service.OUTPUT_LABEL:NONCE}),
            State=dict(Running=False,Status='created',Pid=0,StartedAt='0001-01-01T00:00:00Z'))
   row.update(over);return json.dumps(row).encode()
  # Both supported identities for the same immutable reference.
  service.inspect_output_container(payload(),image,config,CID,NAME,NONCE)
  service.inspect_output_container(payload(Image=config),image,config,CID,NAME,NONCE)
  # Never-started enforcement applies to both.
  running=payload(Image=index_digest,State=dict(Running=True,Status='running',Pid=9,StartedAt='2026-11-07T00:00:00Z'))
  with self.assertRaises(ValueError):service.inspect_output_container(running,image,config,CID,NAME,NONCE)
  service.inspect_output_container(running,image,config,CID,NAME,NONCE,require_never_started=False)
  # Identity is not widened to "any sha": foreign/arbitrary/malformed IDs fail.
  for bad in ['sha256:'+'3'*64,'sha256:'+'f'*64,index_digest[7:],None,image,'latest']:
   with self.assertRaises(ValueError):
    service.inspect_output_container(payload(Image=bad),image,config,CID,NAME,NONCE)
  # Wrong CID, name, reference and owner nonce all still fail.
  for field,value in [('Id','e'*64),('Name','/foreign')]:
   mutated=json.loads(payload());mutated[field]=value
   with self.assertRaises(ValueError):
    service.inspect_output_container(json.dumps(mutated).encode(),image,config,CID,NAME,NONCE)
  with self.assertRaises(ValueError):
   service.inspect_output_container(payload(),'ghcr.io/undefinedsco/xpod@sha256:'+'4'*64,config,CID,NAME,NONCE)
  with self.assertRaises(ValueError):
   service.inspect_output_container(payload(),image,config,CID,NAME,'b'*32)
  # The config digest argument is shape-checked here; its provenance is bound by
  # the registry manifest chain and the capture-time metadata cross-seal.
  for malformed in ['sha256:short','5'*64,'sha256:'+'Z'*64,None]:
   with self.assertRaises(ValueError):
    service.inspect_output_container(payload(),image,malformed,CID,NAME,NONCE)

 def test_full_capture_accepts_reference_digest_identity_and_legacy_config_id(self):
  # End-to-end through the real capture(), real registry helper and shared
  # 120-second budget, so the container identity check is exercised in context.
  for identity in ('reference','config'):
   with self.subTest(imageIdentity=identity):
    master=self._run_real_capture(deadline=__import__('time').time()+120,image_identity=identity)
    observed=master['images']
    self.assertEqual(master['serviceImageReferenceByDigest'],self._service_reference)
    self.assertEqual(observed['service']['configDigest'],self._service_config_digest)
    self.assertTrue(master['facts']['serviceRootfsFromLocalRuntimeVerified'])
    # The config digest and the reference digest are genuinely distinct here.
    self.assertNotEqual(self._service_config_digest,self._service_reference.split('@')[1])

class _OpenerAdapter:
 '''urllib.callers expect an opener object with .open; registry callers take the
 transport callable directly. This adapter serves both shapes.'''
 def __init__(self,transport):self.open=transport

class _RecordingBudget:
 '''Minimal stand-in that enforces the seconds-reserve contract the real
 ExecutionBudget enforces, so the helper's reserve usage is observable.'''
 def __init__(self,seconds=120):self.remaining_seconds=seconds
 def check(self,reserve=0):
  if self.remaining_seconds<=reserve:raise TimeoutError('SDK producer deadline reserve exhausted')

class _NeverCalled:
 def __call__(self,*_a,**_k):raise AssertionError('transport must not be reached')

if __name__=='__main__':unittest.main()
