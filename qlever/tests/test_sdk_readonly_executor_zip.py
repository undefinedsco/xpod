"""Real tiny ZIP transport only, no genuine SDK cap or candidate execution."""
import copy,hashlib,importlib.util,json,tempfile,unittest,zipfile
from pathlib import Path
from qlever.tests.test_sdk_readonly_executor import fixture,ID,b,e
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('zip_original_probe',ROOT/'qlever/scripts/sdk-zip-originals.py');z=importlib.util.module_from_spec(spec);spec.loader.exec_module(z)
TESTDATA=ROOT/'.test-data/sdk-readonly-executor';TESTDATA.mkdir(parents=True,exist_ok=True)
def ref(name,data):return dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
def archive(path):
 record,raw,values=fixture();record=e.rooted_collection(record);raw={'readonly-executor/'+name:data for name,data in raw.items()};body=json.dumps(record).encode();collection=ref('readonly-executor/executor.collection.json',body);raw[collection['path']]=body
 master=dict(identity=ID,readonlyExecutor=collection,originals=[ref(name,data) for name,data in raw.items()]);body=json.dumps(master).encode();raw['materials.json']=body;masterref=ref('materials.json',body)
 with zipfile.ZipFile(path,'w') as target:
  for name,data in raw.items():target.writestr(name,data)
 h=values['hostBefore'];provider=dict(mountNamespaceIdentityDecimal=[str(v) for v in h['namespaces']['mnt']['identity']],rootIdentityDecimal=[str(v) for v in h['rootIdentity']],mountNamespace=h['namespaces']['mnt']['link'],provider=dict(mount='/',mountId=99,mountOptions=['ro']))
 return dict(identity=ID,masterReference=masterref,providers=[provider],remainingMilliseconds=1000)
def activated_archive(path,mutate=None):
 from qlever.tests.test_sdk_local_daemon_originals import closed_collection,daemon
 record,raw,values=fixture()
 def put(name,value):
  data=value if isinstance(value,bytes) else json.dumps(value).encode();raw[name]=data;return ref(name,data)
 def activation(prefix):
  collection,files=closed_collection()
  for index,frame in enumerate(collection['frames']):
   old=frame['serviceStage']['receipt'];actual=json.loads(files[old['path']]);actual.update(startedUnixNs=1 if index==0 else 500,completedUnixNs=2 if index==0 else 501);data=json.dumps(actual).encode();files[old['path']]=data;replacement=ref(old['path'],data);frame['serviceStage']['receipt']=replacement;collection['originals']=[replacement if r['path']==old['path'] else r for r in collection['originals']]
  proof=daemon.verify_collection(collection,lambda r:files[r['path']]);refs={'daemonActivation':put(prefix+'collection.json',collection)}
  for index,(name,data) in enumerate(files.items()):refs['daemonActivationOriginal'+str(index)]=put(prefix+name,data)
  return refs,proof
 refs,proof=activation('daemon-activation/');record['originals'].update(refs)
 actual=dict(values['daemonBefore'],pid=proof['mainPid'],executableIdentity=proof['daemonExecutableIdentity'],executableSha256=proof['daemonExecutableSha256'],associationModel='systemd-listener-v1',activationService=proof['service'],listenerIdentity=proof['listenerIdentity'])
 for field in ['controllerPidNamespace','daemonPidNamespace','hostPidNamespace','controllerRootIdentity','daemonRootIdentity']:actual[field]=proof[field]
 for role in ['daemonBefore','daemonAfter']:record['originals'][role]=put(role+'.json',actual)
 record=e.rooted_collection(record);raw={'readonly-executor/'+name:data for name,data in raw.items()}
 refs,_=activation('daemon-activation/')
 normal=dict(identity=ID,readonlyExecutor=record,sourcePreparedConfig=record['preparedImageConfig'],deadlineUnix=record['deadlineUnix'],daemonActivationOriginals=refs,stages=[])
 for index,name in enumerate(['prepare-source-image','compose-linked-image']):
  command=b.prepared_argv(b.ownership(ID)+'-builder','linux/arm64',ID,normal['deadlineUnix'],'/controlled/prepared-buildkit.original.json') if index==0 else ['/usr/bin/python3','-I','-S','-B','/tmp/controller/qlever/scripts/sdk-readonly-result-context.py','build','--plan','/controlled/linked.plan.json']
  parent='stages/'+name+'/';stdout=put(parent+'stdout.raw',b'actual build raw');stderr=put(parent+'stderr.raw',b'');superraw=put('stages/'+name+'.raw.log',b'wrapper raw')
  receipt=put(parent+'command.receipt.json',dict(command=command,exit=0,signal=None,actualWait=True,rawClosedBeforeHash=True,pgid=10,startedUnixNs=3+index*300,completedUnixNs=4+index*300,stdout=dict(stdout,path='stdout.raw'),stderr=dict(stderr,path='stderr.raw')))
  supervisor=put('stages/'+name+'.receipt.json',dict(exit=0,signal=None,actualWait=True,rawClosedBeforeHash=True,ownedGroupAbsentAfterWait=True,pgid=10,rawSHA256=superraw['sha256']))
  normal['stages'].append(dict(name=name,receipt=receipt,stdout=stdout,stderr=stderr,supervisionReceipt=supervisor,supervisionRaw=superraw))
 if mutate:mutate(normal,raw)
 collection=put('readonly-executor/executor.collection.json',record);normalref=put('normal-route.original.json',normal)
 master=dict(identity=ID,readonlyExecutor=collection,buildkit={'record':normalref},originals=[ref(name,data) for name,data in raw.items()]);masterref=put('materials.json',master)
 with zipfile.ZipFile(path,'w') as target:
  for name,data in raw.items():target.writestr(name,data)
 h=values['hostBefore'];provider=dict(mountNamespaceIdentityDecimal=[str(v) for v in h['namespaces']['mnt']['identity']],rootIdentityDecimal=[str(v) for v in h['rootIdentity']],mountNamespace=h['namespaces']['mnt']['link'],provider=dict(mount='/',mountId=99,mountOptions=['ro']))
 return dict(identity=ID,masterReference=masterref,providers=[provider],remainingMilliseconds=1000)

class Zip(unittest.TestCase):
 def test_activated_normal_and_executor_share_actual_closed_daemon_interval(self):
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   path=Path(directory)/'activated.zip';plan=activated_archive(path);result=b.scan_archive(path,plan);self.assertTrue(result['sdkReadOnlyExecutorProtocolOriginalsVerified']);self.assertFalse(result['toolchainLifetimeImmutabilityVerified'])
   def mutate(normal,raw):
    stage=normal['stages'][0];reference=stage['receipt'];body=json.loads(raw[reference['path']]);body['actualWait']=False;data=json.dumps(body).encode();raw[reference['path']]=data;stage['receipt']=ref(reference['path'],data)
   plan=activated_archive(path,mutate)
   with self.assertRaisesRegex(ValueError,'normal phase actual wait'):b.scan_archive(path,plan)

 def test_real_archive_exact_master_refs_outer_originals_and_provider_protocol(self):
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   path=Path(directory)/'originals.zip';plan=archive(path);result=b.scan_archive(path,plan);self.assertTrue(result['sdkReadOnlyExecutorProtocolOriginalsVerified']);self.assertFalse(result['wholeSdkSourceVerified']);self.assertEqual(result['selectedProvidersBoundToImageRoot'],1)
 def test_old_modes_never_gain_new_domain_or_rootmetadata(self):
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   path=Path(directory)/'originals.zip';plan=archive(path)
   with self.assertRaises(ValueError):
    with z.registered_zip_originals(path,'readonly-executor/',lambda:None):pass
   with self.assertRaises(ValueError):
    with z.registered_zip_originals(path,'inner/toolchain-execution/',lambda:None,master_reference=plan['masterReference']):pass
   with z.registered_zip_originals(path,'inner/toolchain-execution/',lambda:None) as read:
    with self.assertRaises(ValueError):read(plan['masterReference'])
 def test_mixed_master_metadata_and_parent_budget_are_rejected(self):
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   path=Path(directory)/'originals.zip';plan=archive(path)
   for change in [lambda p:p.update(remainingMilliseconds=0),lambda p:p['masterReference'].update(sha256='f'*64),lambda p:p['masterReference'].update(path='different.json'),lambda p:p['identity'].update(runAttempt=2),lambda p:p['providers'][0]['provider'].update(mountId=100)]:
    bad=copy.deepcopy(plan);change(bad)
    with self.assertRaises((ValueError,TimeoutError)):b.scan_archive(path,bad)
   with z.registered_zip_originals(path,'readonly-executor/',lambda:None,master_reference=plan['masterReference']) as read:
    with self.assertRaises(ValueError):read(dict(plan['masterReference'],sha256='f'*64))
 def test_expired_shared_zip_check_opens_no_payload(self):
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   path=Path(directory)/'originals.zip';plan=archive(path)
   def expired():raise TimeoutError('same deadline')
   with self.assertRaises(TimeoutError):
    with z.registered_zip_originals(path,'readonly-executor/',expired,master_reference=plan['masterReference']):pass
if __name__=='__main__':unittest.main()
