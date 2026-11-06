import hashlib,importlib.util,io,json,tempfile,tarfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2];spec=importlib.util.spec_from_file_location('full_collector',ROOT/'qlever/scripts/sdk-service-image-originals.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def ref(path,body):return dict(path=path,bytes=len(body),sha256=hashlib.sha256(body).hexdigest())
def tar(root,rows):
 raw=io.BytesIO()
 with tarfile.open(fileobj=raw,mode='w',format=tarfile.USTAR_FORMAT) as t:
  for name,body in rows.items():
   i=tarfile.TarInfo((root+'/' if root else '')+name);i.size=len(body);t.addfile(i,io.BytesIO(body))
 return raw.getvalue()
class Budget:
 def check(self,*a):pass
 def timeout(self,cap,*a):return cap
class Tests(unittest.TestCase):
 def setUp(self):
  (ROOT/'.test-data').mkdir(exist_ok=True);self.tmp=tempfile.TemporaryDirectory(dir=ROOT/'.test-data');self.addCleanup(self.tmp.cleanup);self.out=Path(self.tmp.name).resolve();self.sha='f'*40;self.cid='c'*64;self.nonce='d'*32;self.image='ghcr.io/undefinedsco/xpod@sha256:'+'a'*64;self.config='sha256:'+'b'*64;self.calls=[];self.ret=m.Retained(self.out,Budget())
 def fixture(self,change=None):
  b=b'actual same bytes two physically retained pack roles';h=hashlib.sha256(b).hexdigest();refs=[ref('service-pack-bodies/objects/'+str(i).zfill(4)+'-'+h+'.original',b) for i in [1,2]];records=[]
  for role,r in zip(['seed-npm-pack','final-service-pack'],refs):
   row=dict(role=role,name=None,path='/service/pack.tgz',canonicalPath='/service/pack.tgz',identity=['1','2','33188',str(len(b)),'4','5']);records+=[dict(kind='actual-pack-body-stat',bytes=len(b),**row),dict(kind='actual-pack-body',reference=r,**row)]
  end=1793000000000;collection=dict(schemaVersion=1,kind='actual-service-pack-manifest-inputs',sourceSha=self.sha,authorityVerified=False,originals=[],bodyOriginals=refs,records=records,details=dict(completion='actual-pack-returned',budget=dict(deadlineUnixMs=end,retainedCeilingBytes=30*m.META)))
  receipt=dict(command=['node','/app/scripts/run-npm-pack.cjs','.test-data/service-pack','.test-data/service-pack-cache','service','--retain-service-originals',self.sha,str(end),str(30*m.META)],exit=0,signal=None,resourceStop=None,supervisorError=None,cleanupErrors=[],actualWait=True,ownedGroupAbsentAfterWait=True,rawClosedBeforeHash=True,rawOverflow=False,actualRawPipeEof=True,retainedRawBytes=0,rawSHA256=hashlib.sha256(b'').hexdigest(),rawByteLimit=m.META)
  if change:change(collection,receipt)
  metadata=json.dumps(collection).encode();receipt_raw=json.dumps(receipt).encode();rows=[ref('service-pack-originals/materials.json',metadata),*refs,ref('service-pack-phase/pack.receipt.json',receipt_raw),ref('service-pack-phase/pack.raw.log',b'')];parent=dict(schemaVersion=1,kind='actual-service-pack-parent-originals',sourceSha=self.sha,authorityVerified=False,retainedCeilingBytes=32*m.META,chargedOriginalBytes=sum(x['bytes'] for x in rows),deadlineUnixMs=end,originals=rows)
  self.metadata=tar('service-pack-originals',{'materials.json':metadata});self.phase=tar('service-pack-phase',{'materials.json':json.dumps(parent).encode(),'pack.receipt.json':receipt_raw,'pack.raw.log':b''});self.bodies={r['path']:tar('',{Path(r['path']).name:b}) for r in refs};return collection
 def capture(self,label,argv,*args,**kwargs):
  role=argv[argv.index('--image-worker')+1];self.calls.append(role)
  if role=='pull':body=b'pulled'
  elif role in ['create','remove']:body=(self.cid+'\n').encode()
  elif role in ['confirm-absent','cleanup-confirm-absent']:body=b''
  elif role=='inspect':body=json.dumps(dict(Id=self.cid,Image=self.config,Name='/xpod-service-output-'+self.nonce,Config=dict(Image=self.image,Labels={m.OUTPUT_LABEL:self.nonce}),State=dict(Running=False,Status='created',Pid=0,StartedAt='0001-01-01T00:00:00Z'))).encode()
  elif role=='copy':body=tar('',{'package.json':b'{"name":"image"}'})
  elif role==m.OUTPUT_PACK_ROLE:body=self.metadata
  elif role==m.OUTPUT_PACK_PHASE_ROLE:body=self.phase
  elif role==m.OUTPUT_PACK_BODY_ROLE:body=self.bodies[argv[argv.index('--body-path')+1]]
  else:raise ValueError(role)
  row=dict(name=label,inputs=[],outputs=[]);directory=self.out/'stages'/label;directory.mkdir(parents=True)
  for key in ['receipt','stdout','stderr','supervisionReceipt','supervisionRaw']:
   filename=('stdout.raw' if key=='stdout' else key+'.json');data=body if key=='stdout' else b'{}';p=directory/filename;p.write_bytes(data);row[key]=ref(p.relative_to(self.out).as_posix(),data)
  return row
 def run_observe(self):
  with patch.object(m.secrets,'token_hex',return_value=self.nonce),patch.object(m.outer.commands,'capture',side_effect=self.capture):return m.observe_output_image(self.image,self.config,self.ret,self.out,self.sha,capture_pack_inputs=True)
 def test_full_closed_metadata_phase_bodies_keep_image_six_stages(self):
  self.fixture();root,result=self.run_observe();pack=result['packInputObservation'];self.assertTrue(pack['mechanicsVerified']);self.assertFalse(pack['packManifestTransformationVerified']);self.assertEqual(len(result['stages']),6);self.assertEqual(len(pack['bodies']),2);self.assertNotEqual(pack['bodies'][0]['original']['path'],pack['bodies'][1]['original']['path']);self.assertEqual(self.calls,['pull','create','inspect','copy','copy-pack-inputs','copy-pack-phase','copy-pack-body','copy-pack-body','remove','confirm-absent'])
 def test_shared_worker_plans_equal_actual_collector_commands(self):
  self.fixture();commands={};actual_capture=self.capture
  def capture(label,argv,*args,**kwargs):
   commands[label]=argv;return actual_capture(label,argv,*args,**kwargs)
  with patch.object(m.secrets,'token_hex',return_value=self.nonce),patch.object(m.outer.commands,'capture',side_effect=capture):
   _,observed=m.observe_output_image(self.image,self.config,self.ret,self.out,self.sha,capture_pack_inputs=True)
  record=observed['packInputObservation'];context=dict(source=str(self.out),sourceSha=self.sha,image=self.image,name='xpod-service-output-'+self.nonce,nonce=self.nonce,cid=self.cid)
  plans=m.pack_bindings.service_pack_worker_plans(context,record,[body['reference'] for body in record['bodies']])
  for plan in plans:self.assertEqual(plan['command'],commands[plan['name']])
  self.assertNotIn('--copy-byte-bound',plans[0]['command'])
  self.assertIn('--copy-byte-bound',plans[1]['command'])
 def test_bad_parent_receipt_still_cleans_owned_container(self):
  self.fixture(lambda c,r:r.update(snapshotOriginalRetained=False))
  with self.assertRaisesRegex(ValueError,'supervision'):self.run_observe()
  self.assertEqual(self.calls[-2:],['cleanup-remove','cleanup-confirm-absent'])
 def test_actual_parent_command_is_accepted_and_former_service_root_rejected(self):
  spec=importlib.util.spec_from_file_location('actual_pack_parent',ROOT/'scripts/service-pack-parent.py');parent=importlib.util.module_from_spec(spec);spec.loader.exec_module(parent)
  captured={}
  class Captured(Exception):pass
  def stage(name,command,*args,**kwargs):captured['command']=command;raise Captured()
  class Loader:
   def exec_module(self,module):module.run_stage=stage
   def create_module(self,spec):return None
  actual_spec=importlib.util.spec_from_file_location
  def loader(name,path):
   if name=='service_pack_supervisor':return importlib.util.spec_from_loader(name,Loader())
   return actual_spec(name,path)
  with patch.object(parent,'HERE',Path('/app/scripts')),patch.object(parent.Path,'cwd',return_value=Path('/app')),patch.object(parent.time,'time',return_value=1792999100),patch.object(parent.importlib.util,'spec_from_file_location',side_effect=loader):
   with self.assertRaises(Captured):parent.run(self.sha)
  self.assertEqual(captured['command'][1],'/app/scripts/run-npm-pack.cjs')
  self.fixture(lambda c,r:r.update(command=captured['command']));_,observed=self.run_observe();self.assertTrue(observed['packInputObservation']['parentRawClosureVerified'])
  # The former wrong /service path remains rejected, not a compatibility alias.
  for node in sorted(self.out.rglob('*'),key=lambda p:len(p.parts),reverse=True):
   if node.is_file():node.unlink()
   elif node.is_dir():node.rmdir()
  self.ret=m.Retained(self.out,Budget());self.calls=[]
  wrong=list(captured['command']);wrong[1]='/service/scripts/run-npm-pack.cjs';self.fixture(lambda c,r:r.update(command=wrong))
  with self.assertRaises(ValueError):self.run_observe()
 def test_versioned_build_parent_all_five_actual_raws_transit_with_closed_refs(self):
  collection=self.fixture();end=collection['details']['budget']['deadlineUnixMs'];phase={}
  import datetime
  stamp=datetime.datetime.fromtimestamp((end-1000)/1000,datetime.timezone.utc).isoformat()
  with tarfile.open(fileobj=io.BytesIO(self.phase)) as archive:base=json.loads(archive.extractfile('service-pack-phase/pack.receipt.json').read())
  for name,command in m.pack_bindings.BUILD_COMMANDS:
   receipt=dict(base,command=list(command),startedUTC=stamp,closedUTC=stamp);phase[name+'.receipt.json']=json.dumps(receipt).encode();phase[name+'.raw.log']=b''
  for name in ['build-inputs.before.json','build-inputs.after.json','build-outputs.after.json']:phase[name]=b'{}'
  charged=sum(map(len,phase.values()));allocation=32*m.META-charged-3*m.META;collection['details']['budget']['retainedCeilingBytes']=allocation
  receipt=dict(base,command=[*base['command'][:-1],str(allocation)],startedUTC=stamp,closedUTC=stamp);phase['pack.receipt.json']=json.dumps(receipt).encode();phase['pack.raw.log']=b''
  metadata=json.dumps(collection).encode();rows=[ref('service-pack-originals/materials.json',metadata),*collection['bodyOriginals'],*[ref('service-pack-phase/'+name,body) for name,body in phase.items()]]
  parent=dict(schemaVersion=1,kind='actual-service-pack-parent-originals',sourceSha=self.sha,authorityVerified=False,retainedCeilingBytes=32*m.META,chargedOriginalBytes=sum(r['bytes'] for r in rows),deadlineUnixMs=end,originals=rows,workingDirectory=dict(path='/app',canonicalPath='/app',identity=['1','2','16877','4096','3','4','2'],completedIdentity=['1','2','16877','8192','5','6','3']),parentModel=m.pack_bindings.BUILD_PARENT_MODEL,buildChargedOriginalBytes=charged,workerRetainedCeilingBytes=allocation)
  self.metadata=tar('service-pack-originals',{'materials.json':metadata});self.phase=tar('service-pack-phase',dict(phase,**{'materials.json':json.dumps(parent).encode()}))
  _,observed=self.run_observe();self.assertTrue(observed['packInputObservation']['parentRawClosureVerified']);self.assertEqual(len(observed['packInputObservation']['phase']['originals']),15)

 def test_duplicate_body_reference_and_missing_stat_reject(self):
  for mutate in [lambda c,r:c['bodyOriginals'].append(c['bodyOriginals'][0]),lambda c,r:c['records'].pop(0)]:
   collection=self.fixture(mutate)
   with self.assertRaises(ValueError):m.pack_body_references(collection)
 def test_wrong_command_exit_raw_or_source_never_grants_mechanics(self):
  for mutate in [lambda c,r:r.update(command=['node','other']),lambda c,r:r.update(exit=1),lambda c,r:r.update(rawSHA256='0'*64),lambda c,r:r.update(actualWait=False),lambda c,r:r.pop('cleanupErrors'),lambda c,r:r.update(cleanupErrors=None),lambda c,r:r.update(cleanupErrors=False),lambda c,r:r.update(cleanupErrors=''),lambda c,r:r.pop('signal'),lambda c,r:r.pop('supervisorError'),lambda c,r:r.pop('resourceStop')]:
   # Distinct owned fixture/ledger per failure, matching the producer contract.
   self.fixture(mutate)
   with patch.object(m.secrets,'token_hex',return_value=self.nonce),patch.object(m.outer.commands,'capture',side_effect=self.capture):
    with self.assertRaises(ValueError):m.observe_output_image(self.image,self.config,self.ret,self.out,self.sha,capture_pack_inputs=True)
   self.assertIn('cleanup-remove',self.calls)
   # All synthetic observations are preserved by this fixture until teardown.
   for node in sorted(self.out.rglob('*'),key=lambda p:len(p.parts),reverse=True):
    if node.is_file():node.unlink()
    elif node.is_dir():node.rmdir()
   self.ret=m.Retained(self.out,Budget());self.calls=[]
 def test_remaining_budget_refuses_before_body_copy(self):
  self.fixture();self.ret.total=80*1024**2
  with self.assertRaisesRegex(ValueError,'pending service-pack-body'):self.run_observe()
  self.assertNotIn('copy-pack-body',self.calls)
 def test_pack_archive_bound_comes_from_the_producer_observation_contract(self):
  # RC378: the real pack index was 1,192,704 bytes with 111 object originals
  # totalling 3,732,882 bytes, so the archive exceeded 4MiB (one META) and the
  # producer-side RLIMIT truncated it at exactly 4194304 bytes. The producer's
  # own closed bound for one observation set is OBSERVATION_BOUNDS.metadataBytes.
  self.assertEqual(m.pack_bindings.PACK_OBSERVATION_RECORDS,2048)
  self.assertEqual(m.pack_bindings.PACK_OBSERVATION_METADATA_BYTES,8*1024**2)
  self.assertGreater(m.pack_bindings.PACK_OBSERVATION_METADATA_BYTES,m.META)
  # Plan and worker agree on that same bound, and no new caller argument exists.
  context=dict(image='ghcr.io/undefinedsco/xpod@'+'a'*64,cid='c'*64,name='xpod-service-output-'+'d'*32,nonce='d'*32,source='/s',sourceSha='a'*40)
  record=dict(schemaVersion=1,kind='actual-stopped-service-image-pack-inputs',imageReferenceByDigest=context['image'],containerId=context['cid'],stage=dict(name='service-output-copy-pack-inputs'),phase=dict(stage=dict(name='service-output-copy-pack-phase')),bodies=[])
  plans=m.pack_bindings.service_pack_worker_plans(context,record,[])
  self.assertEqual(plans[0]['stdoutMaximum'],m.pack_bindings.PACK_OBSERVATION_METADATA_BYTES)
  self.assertNotIn('--copy-byte-bound',plans[0]['command'])
  # A single metadata member is still bounded by one META.
  self.assertLessEqual(m.META,plans[0]['stdoutMaximum'])

 def test_oversized_pack_archive_round_trips_where_one_meta_would_truncate(self):
  # SYNTHETIC payload (not real evidence). Each metadata object stays inside one
  # META, exactly as the member contract requires; the AGGREGATE exceeds one META
  # and stays inside the producer's declared observation bound.
  import json as _json
  first=b'x'*(2*m.META//3);second=b'w'*(2*m.META//3)
  entries={hashlib.sha256(payload).hexdigest():payload for payload in (first,second)}
  collection=self.fixture()
  collection['originals']=[ref('objects/'+digest+'.original',payload) for digest,payload in entries.items()]
  metadata=_json.dumps(collection,sort_keys=True).encode()
  self.assertLessEqual(len(metadata),m.META)
  members={'materials.json':metadata,**{'objects/'+digest+'.original':payload for digest,payload in entries.items()}}
  archive=tar('service-pack-originals',members)
  self.assertGreater(len(archive),m.META)
  self.assertLessEqual(len(archive),m.pack_bindings.PACK_OBSERVATION_METADATA_BYTES)
  root=ROOT/'.test-data/service-pack-bound-tests';root.mkdir(parents=True,exist_ok=True)
  with tempfile.TemporaryDirectory(dir=root) as directory:
   path=Path(directory)/'pack.tar';path.write_bytes(archive)
   parsed=m.service_pack_sidecar_tar(path,lambda:None)
   self.assertEqual(len(parsed['originals']),2)
   for digest,payload in entries.items():self.assertEqual(parsed['originals']['objects/'+digest+'.original'],payload)
   self.assertEqual(parsed['collectionOriginal'],metadata)
   # The historical single-META bound rejects exactly this valid archive.
   with self.assertRaises(ValueError):m.outer.bounded_original(path,m.META,lambda:None)

 def test_pack_archive_rejects_over_content_and_duplicate_members(self):
  import json as _json
  root=ROOT/'.test-data/service-pack-bound-tests';root.mkdir(parents=True,exist_ok=True)
  # Aggregating valid per-member payloads past the observation bound must fail.
  payloads=[bytes([index+1])*(3*m.META//4) for index in range(4)]
  entries={hashlib.sha256(payload).hexdigest():payload for payload in payloads}
  collection=self.fixture()
  collection['originals']=[ref('objects/'+digest+'.original',payload) for digest,payload in entries.items()]
  metadata=_json.dumps(collection,sort_keys=True).encode()
  over={'materials.json':metadata,**{'objects/'+digest+'.original':payload for digest,payload in entries.items()}}
  self.assertGreater(len(tar('service-pack-originals',over)),m.pack_bindings.PACK_OBSERVATION_METADATA_BYTES)
  with tempfile.TemporaryDirectory(dir=root) as directory:
   path=Path(directory)/'over.tar'
   path.write_bytes(tar('service-pack-originals',over))
   with self.assertRaises(ValueError):m.service_pack_sidecar_tar(path,lambda:None)
   # A single member beyond one META is still refused on its own.
   big=b'z'*(m.META+1);big_digest=hashlib.sha256(big).hexdigest()
   single=self.fixture();single['originals']=[ref('objects/'+big_digest+'.original',big)]
   single_meta=_json.dumps(single,sort_keys=True).encode()
   path.write_bytes(tar('service-pack-originals',{'materials.json':single_meta,'objects/'+big_digest+'.original':big}))
   with self.assertRaises(ValueError):m.service_pack_sidecar_tar(path,lambda:None)
   # Duplicate members remain refused.
   dup=b'q'*32;dup_digest=hashlib.sha256(dup).hexdigest()
   dup_collection=self.fixture();dup_collection['originals']=[ref('objects/'+dup_digest+'.original',dup)]
   dup_meta=_json.dumps(dup_collection,sort_keys=True).encode()
   raw=io.BytesIO()
   with tarfile.open(fileobj=raw,mode='w',format=tarfile.USTAR_FORMAT) as stream:
    for name,body in [('service-pack-originals/materials.json',dup_meta),('service-pack-originals/objects/'+dup_digest+'.original',dup),('service-pack-originals/objects/'+dup_digest+'.original',dup)]:
     info=tarfile.TarInfo(name);info.size=len(body);stream.addfile(info,io.BytesIO(body))
   path.write_bytes(raw.getvalue())
   with self.assertRaises(ValueError):m.service_pack_sidecar_tar(path,lambda:None)
   # An unregistered/extra object is still refused.
   extra=b'e'*16;extra_digest=hashlib.sha256(extra).hexdigest()
   path.write_bytes(tar('service-pack-originals',{'materials.json':dup_meta,'objects/'+dup_digest+'.original':dup,'objects/'+extra_digest+'.original':extra}))
   with self.assertRaises(ValueError):m.service_pack_sidecar_tar(path,lambda:None)

if __name__=='__main__':unittest.main()
