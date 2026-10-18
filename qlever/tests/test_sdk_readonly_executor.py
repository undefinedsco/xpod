"""Pure outer-controller contracts, no Docker/candidate execution or private caps."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
TESTDATA=ROOT/'.test-data/sdk-readonly-executor';TESTDATA.mkdir(parents=True,exist_ok=True)
def load(name):
 spec=importlib.util.spec_from_file_location(name,ROOT/'qlever/scripts'/name);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
b=load('sdk-readonly-executor-bindings.py');e=load('sdk-readonly-executor.py')
ID=dict(sourceSha='a'*40,runId=1,runAttempt=1,target='linux-arm64',sdkProfile='module-bookworm-gcc12')
IMAGE='sha256:'+'b'*64;CID='c'*64

def fixture():
 argv,volumes=e.create_argv(IMAGE,ID,2000000000.0,'none','e'*64);root=[1,20,0o40755,4096,0,0]
 host=dict(containerPid=10,namespacePids=[10,1],ready=dict(pid=1,nonce='e'*64,identity=ID,deadlineUnix=2000000000.0),command=['/usr/bin/python3','-I','-S','-B','/components/qlever/scripts/sdk-readonly-executor-entry.py'],rootPidStarttime='123',children=[],namespaces={role:dict(link=role+':['+str(i)+']',identity=[1,i,0o100444,0,0,0]) for i,role in enumerate(['mnt','pid','user'],10)},rootIdentity=root,rootMount=dict(mountId=99,mount='/',options=['ro'],propagation=[]))
 hc=dict(ReadonlyRootfs=True,Privileged=False,CapAdd=None,CapDrop=['ALL'],PidMode='',IpcMode='private',CgroupnsMode='private',VolumesFrom=None,Binds=None,Devices=None,DeviceRequests=None,SecurityOpt=['no-new-privileges'],RestartPolicy={'Name':'no'},Tmpfs={'/tmp':'rw,nosuid,nodev,size=1073741824'},NetworkMode='none')
 before=dict(Id=CID,Image=IMAGE,HostConfig=hc,Mounts=[dict(Type='volume',Name=v,Destination=p,RW=True,Propagation='') for p,v in volumes.items()],Healthcheck={'Test':['NONE']},Path='/usr/bin/python3',Args=['-I','-S','-B','/components/qlever/scripts/sdk-readonly-executor-entry.py'],State=dict(Running=True,Pid=10,ExitCode=0,OOMKilled=False))
 after=copy.deepcopy(before);after['State']['Running']=False;after['State']['Pid']=0
 daemon=dict(socket='unix:///var/run/docker.sock',pid=2,uid=0,executablePath='/usr/bin/dockerd',executableSha256='f'*64,controllerPidNamespace='pid:[10]',daemonPidNamespace='pid:[10]',hostPidNamespace='pid:[10]',controllerRootIdentity=[1,1,0o40755,4096,0,0],daemonRootIdentity=[1,1,0o40755,4096,0,0])
 values=dict(sourcePreparedCopied=dict(identity=ID,deadlineUnix=2000000000.0),daemonBefore=daemon,daemonAfter=copy.deepcopy(daemon),image=dict(Id=IMAGE,Os='linux',Architecture='arm64',RootFS=dict(Type='layers',Layers=['sha256:'+'d'*64]),Volumes=None,OnBuild=None),containerBefore=before,containerAfter=after,wait=dict(containerId=CID,exitCode=0,actualDockerWait=True),sourcePrepared=dict(identity=ID,deadlineUnix=2000000000.0),hostBefore=host,hostBeforeRelease=copy.deepcopy(host),rootDiffBefore=[],rootDiffAfter=[])
 originals={};refs={}
 for role,value in values.items():
  raw=json.dumps(value).encode();name=role+'.json';originals[name]=raw;refs[role]=dict(path=name,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
 record=dict(schemaVersion=1,model=b.MODEL,identity=ID,preparedImageConfig=IMAGE,deadlineUnix=2000000000.0,network='none',nonce='e'*64,outputRoot='/controlled/output',volumes=volumes,originals=refs,stages=[])
 release=('e'*64+'\n').encode();originals['release.original']=release;refs['release']=dict(path='release.original',bytes=len(release),sha256=hashlib.sha256(release).hexdigest())
 expected=[('image',['docker','image','inspect','--format',b.IMAGE_TEMPLATE,IMAGE]),('existing-volumes',['docker','volume','ls','--format','{{.Name}}']),*[('create-volume-'+role,['docker','volume','create',volume]) for role,volume in zip(['build','materials'],volumes.values())],('create-executor',argv),('start-executor',['docker','start',CID]),('container-before',['docker','container','inspect','--format',b.CONTAINER_TEMPLATE,CID]),('root-diff-before',['docker','diff',CID]),('copy-prepared',['docker','cp',CID+':/opt/qlever-sdk/materials/source-prepared.json','/controlled/output/source-prepared.copied.json']),('release-executor',['docker','cp','/controlled/output/release.original',CID+':/opt/qlever-sdk/materials/readonly-executor.release']),('wait-executor',['docker','wait',CID]),('executor-logs',['docker','logs',CID]),('container-after',['docker','container','inspect','--format',b.CONTAINER_TEMPLATE,CID]),('root-diff-after',['docker','diff',CID]),('stop-executor',['docker','stop','--time','10',CID]),('confirm-stopped',['docker','container','inspect','--format','{{json .State.Running}}',CID])]
 def ref(name,data):
  originals[name]=data;return dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
 for index,(name,command) in enumerate(expected):
  output=json.dumps(values['image' if name=='image' else 'containerBefore' if name=='container-before' else 'containerAfter']).encode() if name in ['image','container-before','container-after'] else (CID+'\n').encode() if name in ['create-executor','start-executor'] else b'0\n' if name=='wait-executor' else b'false\n' if name=='confirm-stopped' else b''
  prefix='stages/'+name+'/';stdout=ref(prefix+'stdout.raw',output);stderr=ref(prefix+'stderr.raw',b'')
  actual=dict(command=b.local_docker(command),exit=0,signal=None,actualWait=True,rawClosedBeforeHash=True,pgid=index+100,startedUnixNs=index*10+1,completedUnixNs=index*10+2,stdout=dict(stdout,path='stdout.raw'),stderr=dict(stderr,path='stderr.raw'))
  supervisor=dict(exit=0,signal=None,actualWait=True,rawClosedBeforeHash=True,pgid=index+100,ownedGroupAbsentAfterWait=True,resourceStop=None,supervisorError=None,cleanupErrors=[])
  record['stages'].append(dict(name=name,receipt=ref(prefix+'receipt.json',json.dumps(actual).encode()),stdout=stdout,stderr=stderr,supervisionReceipt=ref(prefix+'supervisor.json',json.dumps(supervisor).encode()),supervisionRaw=ref(prefix+'supervision.raw',b'actual raw fixture')))
 return record,originals,values

def changed(record,raw,values,role,mutate):
 mutate(values[role]);data=json.dumps(values[role]).encode();name=record['originals'][role]['path'];raw[name]=data;record['originals'][role].update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
def run_mock_outer(directory,oversized=False):
 record,raw,values=fixture();deadline=record['deadlineUnix'];host=values['hostBefore'];daemon=values['daemonBefore'];count=[]
 class Budget:
  def __init__(self,*args):pass
  def check(self,*args):pass
  def timeout(self,*args):return 1
 class Daemon:
  def __init__(self,*args):self.first=daemon
  def sample(self,*args):return daemon
  def close(self):pass
 class Held:
  def __init__(self,*args):pass
  def sample(self,*args):return host
  def close(self):pass
 output=Path(directory)/'fresh';byname={row['name']:row for row in record['stages']}
 def capture(name,command,materials,cwd,**options):
  count.append(name);prefix='stages/'+name+'/';target=output/prefix;target.mkdir(parents=True)
  stage=copy.deepcopy(byname[name]);actual=json.loads(raw[stage['receipt']['path']]);actual['command']=command
  for field in ['stdout','stderr','supervisionReceipt','supervisionRaw']:
   reference=stage[field];path=output/reference['path'];path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw[reference['path']])
  receipt=output/stage['receipt']['path'];data=json.dumps(actual).encode();receipt.write_bytes(data);stage['receipt'].update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
  if name=='copy-prepared':
   target=output/'source-prepared.copied.json'
   if oversized:
    with target.open('wb') as stream:stream.truncate(b.META+1)
   else:target.write_text(json.dumps(values['sourcePrepared']))
  return stage
 with patch.object(e.platform,'system',return_value='Linux'),patch.object(e.os,'geteuid',return_value=0),patch.object(e,'LocalDaemon',Daemon),patch.object(e,'HeldContainer',Held),patch.object(e.secrets,'token_hex',return_value='e'*64),patch.object(e.budgets,'ExecutionBudget',Budget),patch.object(e.commands,'capture',side_effect=capture):result=e.execute(IMAGE,ID,deadline,output,'none')
 return result,output,count

class Tests(unittest.TestCase):
 def test_fixed_create_does_not_expose_hostsocket_or_candidate_entry(self):
  args,volumes=e.create_argv(IMAGE,ID,2000000000.0,'none','e'*64)
  self.assertEqual(args[:3],['docker','create','--name']);self.assertEqual(len(volumes),2)
  self.assertNotIn('--privileged',args);self.assertNotIn('--volumes-from',args);self.assertNotIn('--pid',args);self.assertNotIn('docker.sock',' '.join(args));self.assertIn('--read-only',args)
  self.assertEqual(args[-5:],[IMAGE,'-I','-S','-B','/components/qlever/scripts/sdk-readonly-executor-entry.py'])
  with self.assertRaises(ValueError):e.create_argv('latest',ID,2000000000.0,'none','e'*64)
  with self.assertRaises(ValueError):e.create_argv(IMAGE,ID,2000000000.0,'host','e'*64)
 def test_only_daemon_bound_narrow_result_not_whole_or_host_writer_authority(self):
  record,raw,values=fixture();facts=b.verify(record,raw,ID);self.assertTrue(facts['daemonManagedReadOnlyExecutorVerified']);self.assertFalse(facts['globalHostWriterAbsenceVerified']);self.assertFalse(facts['wholeSdkSourceVerified']);self.assertFalse(facts['toolchainLifetimeImmutabilityVerified'])
 def test_rehashed_wrong_image_mount_privilege_identity_and_terminal_records_fail(self):
  cases=[('daemonAfter',lambda v:v.update(pid=3)),('daemonBefore',lambda v:v.update(socket='tcp://remote')),('image',lambda v:v.update(Id='sha256:'+'e'*64)),('image',lambda v:v.update(Architecture='amd64')),('image',lambda v:v.update(Volumes={'/usr':{}})),('containerBefore',lambda v:v['HostConfig'].update(ReadonlyRootfs=False)),('containerBefore',lambda v:v['HostConfig'].update(Binds=['/host:/usr'])),('containerBefore',lambda v:v['HostConfig'].update(CapAdd=['SYS_ADMIN'])),('containerBefore',lambda v:v['Mounts'][0].update(Destination='/usr')),('containerAfter',lambda v:v['State'].update(ExitCode=1)),('wait',lambda v:v.update(exitCode=1)),('sourcePrepared',lambda v:v.update(identity={**ID,'runAttempt':2})),('hostBeforeRelease',lambda v:v.update(rootPidStarttime='124')),('hostBefore',lambda v:v.update(children=['20'])),('rootDiffAfter',lambda v:v.append('C /usr/bin/cc'))]
  for role,mutate in cases:
   record,raw,values=fixture();changed(record,raw,values,role,mutate)
   with self.subTest(role=role):
    with self.assertRaises(ValueError):b.verify(record,raw,ID)
 def test_provider_must_match_outside_held_namespace_root_and_actual_mount_id(self):
  record,raw,values=fixture();proof=b.verify(record,raw,ID);h=values['hostBefore'];provider=dict(mountNamespaceIdentityDecimal=[str(v) for v in h['namespaces']['mnt']['identity']],mountNamespace=h['namespaces']['mnt']['link'],rootIdentityDecimal=[str(v) for v in h['rootIdentity']],provider=dict(mount='/',mountId=99,mountOptions=['ro']))
  self.assertTrue(b.join_provider(proof,provider)['providerBoundToOwnedImageRoot'])
  for change in [lambda v:v['provider'].update(mount='/usr'),lambda v:v['provider'].update(mountId=100),lambda v:v['provider'].update(mountOptions=['rw']),lambda v:v.update(mountNamespace='mnt:[1]'),lambda v:v['rootIdentityDecimal'].__setitem__(1,'99')]:
   value=copy.deepcopy(provider);change(value)
   with self.assertRaises(ValueError):b.join_provider(proof,value)
 def test_rehashed_stage_receipt_cannot_run_unknown_command_or_fake_closure(self):
  for mutate in [lambda v:v['command'].append('--privileged'),lambda v:v.update(actualWait=False),lambda v:v.update(exit=1),lambda v:v.update(completedUnixNs=2100000000000000000)]:
   record,raw,values=fixture();ref=record['stages'][4]['receipt'];value=json.loads(raw[ref['path']]);mutate(value);data=json.dumps(value).encode();raw[ref['path']]=data;ref.update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
   with self.assertRaises(ValueError):b.verify(record,raw,ID)
  record,raw,values=fixture();record['stages'].pop(4)
  with self.assertRaises(ValueError):b.verify(record,raw,ID)
 def test_same_fd_metadata_reader_refuses_symlink_hardlink_and_growth(self):
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   root=Path(directory);path=root/'original';path.write_bytes(b'1234')
   self.assertEqual(e.bounded_original(path,4,lambda:None),b'1234')
   link=root/'link';link.symlink_to(path)
   with self.assertRaises(OSError):e.bounded_original(link,4,lambda:None)
   hard=root/'hard';e.os.link(path,hard)
   with self.assertRaises(ValueError):e.bounded_original(path,4,lambda:None)
   hard.unlink()
   with self.assertRaises(ValueError):e.bounded_original(path,3,lambda:None)
   real_read=e.os.read;calls=[]
   def growing(fd,count):
    data=real_read(fd,count)
    if not calls:
     calls.append(1)
     with path.open('ab') as raw:raw.write(b'X')
    return data
   with patch.object(e.os,'read',side_effect=growing):
    with self.assertRaises(ValueError):e.bounded_original(path,8,lambda:None)
 def test_remote_context_or_nonhost_privilege_never_reaches_docker(self):
  with patch.dict(e.os.environ,{'DOCKER_HOST':'tcp://remote'}):
   with self.assertRaisesRegex(RuntimeError,'Remote/context'):e.LocalDaemon(lambda:None)
  with patch.object(e.platform,'system',return_value='Linux'),patch.object(e.os,'geteuid',return_value=1000),patch.object(e.commands,'capture',side_effect=AssertionError('Docker must not run')):
   with self.assertRaisesRegex(RuntimeError,'actual Linux Docker host'):e.execute(IMAGE,ID,2000000000.0,'/not-created')
 def test_outer_return_is_sealed_after_cleanup_without_shared_list_or_self_reference(self):
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   result,output,count=run_mock_outer(directory)
   saved=json.loads((output/'executorCollection.original.json').read_text())
   self.assertEqual(result,saved);self.assertEqual(len(result['stages']),16);self.assertEqual(count[-2:],['stop-executor','confirm-stopped']);self.assertNotIn('executorCollection',result['originals'])
 def test_oversize_copied_manifest_is_rejected_before_any_unbounded_ref_hash(self):
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   real=e.commands.ref
   def guarded(path,root):
    if Path(path).name=='source-prepared.copied.json':raise AssertionError('unbounded commands.ref must never touch copied manifest')
    return real(path,root)
   with patch.object(e.commands,'ref',side_effect=guarded):
    with self.assertRaisesRegex(ValueError,'bounded single regular outer original'):run_mock_outer(directory,True)
 def test_no_inner_json_can_omit_or_change_outer_original_bytes(self):
  record,raw,values=fixture();raw['wait.json']+=b' '
  with self.assertRaises(ValueError):b.verify(record,raw,ID)
if __name__=='__main__':unittest.main()
