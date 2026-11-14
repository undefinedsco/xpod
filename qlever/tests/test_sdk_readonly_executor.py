"""Pure outer-controller contracts, no Docker/candidate execution or private caps."""
import copy
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
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

def render_inspect(template,value):
 # Test-only Docker json action fixture. Preserve every literal template byte;
 # do not build an independent inspect JSON object that hides broken braces.
 def render(match):
  current=value
  for part in match.group(1).split('.'):
   current=current[part]
  return json.dumps(current,separators=(',',':'))
 result=re.sub(r'\{\{json \.([A-Za-z0-9_.]+)\}\}',render,template)
 if '{{' in result:raise AssertionError('unmodeled Docker template action')
 return (result+'\n').encode()

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
  output=render_inspect(b.IMAGE_TEMPLATE if name=='image' else b.CONTAINER_TEMPLATE, {**values['image' if name=='image' else 'containerBefore' if name=='container-before' else 'containerAfter'], 'Config':dict(Volumes=None,OnBuild=None,Healthcheck={'Test':['NONE']})}) if name in ['image','container-before','container-after'] else (CID+'\n').encode() if name in ['create-executor','start-executor'] else b'0\n' if name=='wait-executor' else b'false\n' if name=='confirm-stopped' else b''
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
  def seal_originals(self):return {}
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
 def test_actual_template_literals_close_both_state_and_root(self):
  _,_,values=fixture()
  for role in ['containerBefore','containerAfter']:
   value={**values[role],'Config':{'Healthcheck':values[role]['Healthcheck']}}
   self.assertEqual(json.loads(render_inspect(b.CONTAINER_TEMPLATE,value)),values[role])
   with self.assertRaises(json.JSONDecodeError):json.loads(render_inspect(b.CONTAINER_TEMPLATE[:-1],value))
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   result,_,names=run_mock_outer(directory)
   self.assertIn('container-before',names);self.assertIn('container-after',names)
   self.assertTrue(result['stages'])

 @unittest.skipUnless(shutil.which('go'),'actual Go template engine unavailable; Linux CI must execute this test')
 def test_real_go_template_engine_renders_unmodified_container_template(self):
  _,_,values=fixture()
  program='''package main
import("encoding/json";"os";"text/template")
func main(){var input struct{Template string;Value map[string]interface{}};if err:=json.NewDecoder(os.Stdin).Decode(&input);err!=nil{panic(err)};t,err:=template.New("inspect").Funcs(template.FuncMap{"json":func(v interface{})(string,error){b,e:=json.Marshal(v);return string(b),e}}).Parse(input.Template);if err!=nil{panic(err)};if err=t.Execute(os.Stdout,input.Value);err!=nil{panic(err)}}
'''
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   source=Path(directory)/'render.go';source.write_text(program)
   for role in ['containerBefore','containerAfter']:
    value={**values[role],'Config':{'Healthcheck':values[role]['Healthcheck']}}
    result=subprocess.run([shutil.which('go'),'run',str(source)],input=json.dumps(dict(Template=b.CONTAINER_TEMPLATE,Value=value)),text=True,capture_output=True,timeout=30)
    self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(json.loads(result.stdout),values[role])
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
 def test_new_held_root_object_keeps_raw_times_but_legacy_requires_full_metadata(self):
  record,raw,values=fixture()
  changed(record,raw,values,'hostBeforeRelease',lambda v:v['rootIdentity'].__setitem__(4,200))
  with self.assertRaises(ValueError):b.verify(record,raw,ID)
  # Current producer emits the object key under its held O_PATH interval. Both
  # originals keep their independent full-six metadata, including timestamps.
  for role in ['hostBefore','hostBeforeRelease']:changed(record,raw,values,role,lambda v:v.update(rootObjectIdentity=v['rootIdentity'][:4]))
  proof=b.verify(record,raw,ID);self.assertNotEqual(values['hostBefore']['rootIdentity'],values['hostBeforeRelease']['rootIdentity'])
  h=proof['hostNamespaceOriginal'];provider=dict(mountNamespaceIdentityDecimal=[str(v) for v in h['namespaces']['mnt']['identity']],mountNamespace=h['namespaces']['mnt']['link'],rootIdentityDecimal=[str(v) for v in h['rootIdentity'][:4]+[900,901]],provider=dict(mount='/',mountId=99,mountOptions=['ro']))
  self.assertTrue(b.join_provider(proof,provider)['providerBoundToOwnedImageRoot']);self.assertFalse(proof['globalHostWriterAbsenceVerified']);self.assertFalse(proof['toolchainLifetimeImmutabilityVerified'])
  for index in range(4):
   bad=copy.deepcopy(provider);bad['rootIdentityDecimal'][index]=str(int(bad['rootIdentityDecimal'][index])+1)
   with self.assertRaises(ValueError):b.join_provider(proof,bad)
  for change in [lambda v:v['rootObjectIdentity'].__setitem__(1,999),lambda v:v['rootIdentity'].__setitem__(0,999),lambda v:v['rootObjectIdentity'].pop(),lambda v:v['rootIdentity'].pop(),lambda v:v['namespaces']['mnt']['identity'].__setitem__(5,999),lambda v:v['rootMount'].update(mountId=100),lambda v:v.update(rootPidStarttime='999'),lambda v:v['ready'].update(nonce='f'*64)]:
   r,o,v=fixture()
   for role in ['hostBefore','hostBeforeRelease']:changed(r,o,v,role,lambda frame:frame.update(rootObjectIdentity=frame['rootIdentity'][:4]))
   changed(r,o,v,'hostBeforeRelease',change)
   with self.assertRaises(ValueError):b.verify(r,o,ID)
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

 def _tar_bytes(self,name,data,mode=None,extra=None):
  import io,tarfile
  buf=io.BytesIO()
  with tarfile.open(fileobj=buf,mode='w:') as archive:
   info=tarfile.TarInfo(name);info.size=len(data)
   if mode is not None:info.mode=mode
   archive.addfile(info,io.BytesIO(data))
   if extra:archive.addfile(extra,io.BytesIO(b''))
  return buf.getvalue()
 def test_retention_anchors_on_absolute_out_not_process_or_stage_cwd(self):
  """CONCERN 1: out must be the caller's ABSOLUTE dir, independent of cwd.

  The process cwd and the stage cwd are deliberately DIFFERENT directories from
  `out`; a cwd-relative Path() would land in the wrong one and never be uploaded.
  """
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   root=Path(directory);out=root/'uploaded-out';out.mkdir()
   process_cwd=root/'process-cwd';process_cwd.mkdir()
   stage_cwd=root/'stage-cwd';stage_cwd.mkdir()
   tar=self._tar_bytes('configure.trace.jsonl',b'{"kind":"trace"}\n')
   def stage(name,argv,*rest):
    # stage() executes with cwd=HERE in production; here it is an explicit dir
    self.assertEqual(Path.cwd(),stage_cwd,'stage must run from its own cwd')
    return tar if name.startswith('failed-evidence-configure-trace') else b''
   previous=Path.cwd()
   os.chdir(stage_cwd)
   try:rows=e.retain_failed_configure_evidence(stage,'c'*64,out)
   finally:os.chdir(previous)
   self.assertIsNotNone(rows)
   retained=out/'failed-configure-evidence'
   self.assertTrue((retained/'manifest.json').is_file(),'manifest must live under absolute out')
   self.assertTrue((retained/'configure.trace.jsonl').is_file())
   self.assertEqual(sorted(p.name for p in process_cwd.iterdir()),[],'process cwd must stay clean')
   self.assertEqual(sorted(p.name for p in stage_cwd.iterdir()),[],'stage cwd must stay clean')
 def test_retention_bounds_transport_and_refuses_oversize_before_materialising(self):
  """CONCERN 2: oversize is refusal-by-transport, not copy-then-delete."""
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   root=Path(directory);out=root/'out';out.mkdir()
   big=b'z'*(e.CONFIGURE_EVIDENCE_MEMBER_LIMIT+1)
   tar_big=self._tar_bytes('CMakeError.log',big)
   def stage(name,argv,*rest):
    if name.startswith('failed-evidence-cmake-error-log'):return tar_big
    return self._tar_bytes('stderr.raw',b'trace\n') if name.startswith('failed-evidence-configure-stderr') else b''
   rows=e.retain_failed_configure_evidence(stage,'c'*64,out)
   by={Path(r['member']).name:r for r in rows}
   self.assertTrue(by['CMakeError.log']['status'].startswith('refused-'),by['CMakeError.log'])
   self.assertNotIn('sha256',by['CMakeError.log'])
   self.assertFalse((out/'failed-configure-evidence'/'CMakeError.log').exists(),
                    'oversize member must never be materialised')
   self.assertEqual(by['stderr.raw']['status'],'retained')
 def test_retention_refuses_nonregular_members_and_parent_symlinks(self):
  """CONCERN 2: a directory/symlink/multi-member tar is not the requested original."""
  import io,tarfile
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   root=Path(directory);out=root/'out';out.mkdir()
   buf=io.BytesIO()
   with tarfile.open(fileobj=buf,mode='w:') as archive:
    info=tarfile.TarInfo('configure.trace.jsonl');info.type=tarfile.DIRTYPE
    archive.addfile(info)
   dir_tar=buf.getvalue()
   multi=self._tar_bytes('configure.trace.jsonl',b'a\n',extra=tarfile.TarInfo('extra'))
   def stage(name,argv,*rest):
    if name.startswith('failed-evidence-configure-trace'):return dir_tar
    if name.startswith('failed-evidence-cmake-output-log'):return multi
    return b''
   rows=e.retain_failed_configure_evidence(stage,'c'*64,out)
   by={Path(r['member']).name:r for r in rows}
   self.assertTrue(by['configure.trace.jsonl']['status'].startswith('refused-'))
   self.assertTrue(by['CMakeOutput.log']['status'].startswith('refused-'))
   self.assertFalse((out/'failed-configure-evidence'/'configure.trace.jsonl').exists())
 def test_retention_names_decisive_shards_at_the_real_producer_directory_without_exec(self):
  """REAL RED fix: shards live at materials/toolchain-execution, and the container
  is STOPPED, so `docker exec` cannot be used (it exits non-zero). Names must be
  derived deterministically from the producer's own naming and fetched by
  `docker cp`, which reads a stopped container's filesystem through the daemon.
  """
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   root=Path(directory);out=root/'out';out.mkdir()
   seen=[]
   def stage(name,argv,*rest):
    seen.append((name,list(argv)))
    self.assertNotIn('exec',argv,'stopped container must never be probed with docker exec')
    if name.startswith('failed-evidence-lease-trace-configure-trace-0000-jsonl-gz'):
     return self._tar_bytes('configure.trace-0000.jsonl.gz',b'{"kind":"toolchain-lease-acquired","leaseId":200}\n')
    raise ValueError('no such member')
   rows=e.retain_failed_configure_evidence(stage,'c'*64,out)
   names=[Path(r['member']).name for r in rows if r['status']=='retained']
   self.assertIn('configure.trace-0000.jsonl.gz',names,'decisive acquisition shard must be retained')
   paths=[argv[2] for name,argv in seen if name.startswith('failed-evidence-lease-trace')]
   self.assertTrue(paths,'shard probes must run')
   for p in paths:
    self.assertIn('/materials/toolchain-execution/',p,'producer writes under toolchain-execution, not materials root')
   manifest=json.loads((out/'failed-configure-evidence'/'manifest.json').read_text())
   self.assertEqual(manifest['model'],'bounded-tar-transport-v3')
   self.assertEqual(manifest['leaseTraceDir'],'materials/toolchain-execution')
   self.assertTrue(manifest['decisiveEvidenceRetained'])
   self.assertEqual(manifest['retainedDecisiveShards'],1)
 def test_retention_reports_absent_decisive_shards_honestly_and_claims_nothing(self):
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   root=Path(directory);out=root/'out';out.mkdir()
   def stage(name,argv,*rest):raise ValueError('not present in stopped container')
   rows=e.retain_failed_configure_evidence(stage,'c'*64,out)
   manifest=json.loads((out/'failed-configure-evidence'/'manifest.json').read_text())
   self.assertFalse(manifest['decisiveEvidenceRetained'],'absence must never be reported as decisive')
   self.assertEqual(manifest['retainedDecisiveShards'],0)
   self.assertGreater(manifest['leaseTraceProbeCount'],0,'probes were attempted and recorded')
   self.assertTrue(any(r['status']=='absent-or-unreadable' for r in rows))
 def test_decisive_member_read_uses_its_own_ceiling_not_the_generic_meta_bound(self):
  """The decisive shard ceiling must exceed the generic 4 MiB stdout/META bound,
  otherwise a legitimate compressed shard would be silently discarded."""
  self.assertGreater(e.LEASE_TRACE_MEMBER_LIMIT, b.META)
  self.assertLessEqual(e.LEASE_TRACE_MEMBER_LIMIT, 512*1024**2,'still bounded')
 def test_retention_retains_decisive_lease_acquisition_shards_only(self):
  with tempfile.TemporaryDirectory(dir=TESTDATA) as directory:
   root=Path(directory);out=root/'out';out.mkdir()
   shard=self._tar_bytes('configure.trace-0000.jsonl.gz',b'{"kind":"toolchain-lease-acquired"}\n')
   def stage(name,argv,*rest):
    if name.startswith('failed-evidence-lease-trace-configure-trace-0000-jsonl-gz'):return shard
    raise ValueError('absent')
   rows=e.retain_failed_configure_evidence(stage,'c'*64,out)
   names=[Path(r['member']).name for r in rows if r['status']=='retained']
   self.assertFalse(any(n=='run.log' for n in names),'unrelated logs must not be pulled in')
   self.assertFalse(any(n.startswith('other.') for n in names),'fixed prefix only')

if __name__=='__main__':unittest.main()
