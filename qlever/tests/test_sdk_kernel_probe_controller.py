"""Controller protocol unit tests with explicit fake Docker; no product evidence."""
import ast,hashlib,importlib.util,json,os,re,stat,tempfile,time,unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch
p=Path(__file__).parents[1]/'scripts/sdk-kernel-probe-controller.py';s=importlib.util.spec_from_file_location('controller',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
IMAGE='sha256:'+'a'*64;CID='b'*64;IDENTITY=dict(sourceSha='c'*40,runId=1,runAttempt=1,target='linux-arm64',sdkProfile='service-trixie')
class Commands:
 def __init__(self,mode=None):self.calls=[];self.mode=mode
 def capture(self,name,argv,out,cwd,**kwargs):
  request=json.loads(argv[-1]);role=request['role'];plan=request['plan'];self.calls.append((role,m.command(role,plan,request['cid'])));result=b''
  if role=='image':result=json.dumps([dict(Id=IMAGE,Os='linux',Architecture='arm64',Config={})]).encode()
  if role=='create':result=(CID+'\n').encode() if self.mode!='bad-create-output' else b'malformed\n'
  if role=='recover-owned':result=(CID+'\n').encode()
  if role in ['before','after','cleanup-inspect']:
   v=dict(Id=CID,Image=IMAGE,Name='/'+plan['name'],Path='/usr/bin/python3',Args=m.command('create',plan)[m.command('create',plan).index(IMAGE)+1:],Config=dict(User='0:0',Image=IMAGE,Labels={'xpod.sdk-kernel-probe-owner':plan['nonce'] if self.mode!='foreign' else 'd'*32}),HostConfig=dict(PidMode='',IpcMode='private',Devices=[],DeviceRequests=[],VolumesFrom=None,ReadonlyRootfs=True,Privileged=False,NetworkMode='none',CapDrop=['ALL'],CapAdd=None,SecurityOpt=['no-new-privileges']),Mounts=[dict(Type='bind',Source=plan['output'],Destination='/probe-output',RW=True)],State=dict(Running=False,Pid=0,Status='created' if role=='before' else 'exited',ExitCode=0,OOMKilled=False));result=json.dumps([v]).encode()
  if role=='start':
   root=Path(plan['output'])/'run';root.mkdir();(root/'ordinary-probe.json').write_text('{"normalModeEnabled":false}\n')
  if role=='wait':result=b'0\n'
  if role=='remove':result=(CID+'\n').encode()
  directory=out/'stages'/name;directory.mkdir(parents=True);refs={}
  for key,data in [('stdout',result),('stderr',b''),('receipt',b'{}\n'),('supervisionReceipt',b'{}\n'),('supervisionRaw',b'')]:
   path=directory/(key+'.original');path.write_bytes(data);refs[key]=dict(path=path.relative_to(out).as_posix(),bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
  if self.mode=='failed-start' and role=='start':raise ValueError('simulated actual nonzero')
  return dict(name=name,**refs)
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[2]);self.addCleanup(self.tmp.cleanup);self.out=Path(self.tmp.name).resolve()/'kernel-probe'
 def run_case(self,mode=None):
  fake=Commands(mode)
  with patch.object(m,'load',return_value=fake):result=m.run(IMAGE,IDENTITY,time.time()+120,self.out,80*1024**2)
  return fake,result
 def test_complete_fixed_control_flow_and_exact_index(self):
  fake,result=self.run_case();self.assertFalse(result['normalModeEnabled']);self.assertFalse(result['releaseAccepted']);self.assertEqual([r for r,_ in fake.calls],list(m.ROLES[:8]));create=fake.calls[1][1];self.assertIn('--pull=never',create);self.assertIn('none',create);self.assertIn('no-new-privileges',create);self.assertIn('/components/qlever/scripts/sdk-kernel-policy-probe.py',create)
  index=json.loads((self.out/'originals.index.json').read_text());total=0
  for ref in index['originals']:
   data=(self.out/ref['path']).read_bytes();self.assertEqual(len(data),ref['bytes']);self.assertEqual(hashlib.sha256(data).hexdigest(),ref['sha256']);total+=len(data)
  self.assertEqual(index['actualRetainedBytes'],sum(p.stat().st_size for p in self.out.rglob('*') if p.is_file()));self.assertEqual(len(index['originals'])+1,len([p for p in self.out.rglob('*') if p.is_file()]))
 def test_failure_preserves_raw_and_cleans_only_owned_cid(self):
  fake=Commands('failed-start')
  with patch.object(m,'load',return_value=fake):
   with self.assertRaisesRegex(ValueError,'simulated actual nonzero'):m.run(IMAGE,IDENTITY,time.time()+120,self.out,80*1024**2)
  self.assertIn('remove',[role for role,_ in fake.calls]);self.assertEqual(fake.calls[-1][0],'absence');self.assertTrue((self.out/'failure.original.json').is_file());self.assertTrue((self.out/'stages/kernel-probe-start/stdout.original').exists())
 def test_malformed_create_recovers_by_exact_name_and_nonce(self):
  fake=Commands('bad-create-output')
  with patch.object(m,'load',return_value=fake):
   with self.assertRaises(ValueError):m.run(IMAGE,IDENTITY,time.time()+120,self.out,80*1024**2)
  roles=[r for r,_ in fake.calls];self.assertIn('recover-owned',roles);self.assertIn('cleanup-inspect',roles);self.assertIn('remove',roles)
 def test_foreign_identity_never_removed(self):
  fake=Commands('foreign')
  with patch.object(m,'load',return_value=fake):
   with self.assertRaises(ValueError):m.run(IMAGE,IDENTITY,time.time()+120,self.out,80*1024**2)
  self.assertNotIn('remove',[r for r,_ in fake.calls])
 def test_deadline_remaining_and_unknown_identity_preflight(self):
  for deadline,remaining,identity in [(time.time()-1,80*1024**2,IDENTITY),(time.time()+120,10,IDENTITY),(time.time()+120,80*1024**2,dict(IDENTITY,callerTrue=True))]:
   with self.assertRaises(ValueError):m.run(IMAGE,identity,deadline,self.out,remaining)
  self.assertFalse(self.out.exists())
 def test_sparse_oversize_refuses_before_any_body_read(self):
  fake=Commands();original_capture=fake.capture
  def capture(name,argv,out,cwd,**kwargs):
   row=original_capture(name,argv,out,cwd,**kwargs)
   if json.loads(argv[-1])['role']=='start':
    with (out/'probe-output/run/oversized.raw').open('wb') as raw:raw.truncate(81*1024**2)
   return row
  fake.capture=capture;calls=[];original_read=m.os.read
  def read(fd,count):calls.append(count);return original_read(fd,count)
  with patch.object(m,'load',return_value=fake),patch.object(m.os,'read',side_effect=read):
   with self.assertRaisesRegex(ValueError,'before body read'):m.run(IMAGE,IDENTITY,time.time()+120,self.out,80*1024**2)
  # Reads before the oversized file was created are unrelated stage metadata.
  # The standalone helper must reject this input before its first body read.
  path=self.out/'probe-output/run/oversized.raw';calls.clear()
  with patch.object(m.os,'read',side_effect=read):
   with self.assertRaises(ValueError):m.original(path,self.out,lambda:None,80*1024**2)
  self.assertEqual(calls,[])
  self.assertIn('remove',[r for r,_ in fake.calls])
 def test_original_exact_maximum_reads_full_same_fd(self):
  self.out.mkdir();path=self.out/'exact.raw';data=b'original'*10000;path.write_bytes(data)
  row=m.original(path,self.out,lambda:None,len(data));self.assertEqual(row['sha256'],hashlib.sha256(data).hexdigest())
class DriverTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[2]);self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.path=Path(__file__).parents[1]/'scripts/sdk-kernel-policy-probe.py';self.tree=ast.parse(self.path.read_text())
 def extracted(self,name,globals):
  node=next(n for n in ast.walk(self.tree) if isinstance(n,ast.FunctionDef) and n.name==name);namespace=dict(globals);exec(compile(ast.Module(body=[node],type_ignores=[]),str(self.path),'exec'),namespace);return namespace[name]
 def test_fixed_original_fixture_bytes(self):
  values={n.targets[0].id:ast.literal_eval(n.value) for n in self.tree.body if isinstance(n,ast.Assign) and len(n.targets)==1 and isinstance(n.targets[0],ast.Name) and n.targets[0].id in ['NUMERIC','CMAKE']}
  self.assertEqual(hashlib.sha256(values['NUMERIC']).hexdigest(),'473c3c611e3238ff4110e2de50ccab498363d170bcea590a7935477eab8160b2');self.assertEqual(hashlib.sha256(values['CMAKE']).hexdigest(),'a66bcd9b4e2f5834d5fc448c3056367bd9c5ba946a4b2c52874017c68f914eac')
 def test_bounded_real_fd_capture_reader_and_escape(self):
  file=self.root/'capture-0000.original';file.write_bytes(b'actual bytes'*10000)
  reader=self.extracted('actual_capture',dict(re=re,os=os,stat=stat,time=time,end=time.monotonic()+10,originals=self.root))
  self.assertEqual(b''.join(reader(file.name,file.stat().st_size)),file.read_bytes())
  with self.assertRaises(AssertionError):list(reader(file.name,2))
  with self.assertRaises(AssertionError):list(reader('../capture-0000.original',1000000))
  gen=reader(file.name,1000000);next(gen)
  with file.open('r+b') as raw:raw.write(b'X')
  with self.assertRaises(AssertionError):list(gen)
 def test_cleanup_reaps_even_when_shared_log_budget_rejects(self):
  waits=[(7,(6<<16)|(5<<8)|127),(7,9)];calls=[]
  class Wait:
   def __init__(self,end,flags):calls.append(('deadline',end))
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def wait_one(self):
    if waits:return waits.pop(0)
    raise ChildProcessError()
  observer=SimpleNamespace(tasks={7:{}},abort=lambda:calls.append(('abort',)))
  backend=SimpleNamespace(owned_wait=SimpleNamespace(BlockingOwnedWait=Wait),WALL=0,single=SimpleNamespace(trace=lambda *args:calls.append(('trace',args))))
  close=self.extracted('close_actual',dict(json=json,os=os,backend=backend,time=time))
  def refuse(amount):raise ValueError('same retained budget')
  with self.assertRaisesRegex(ValueError,'same retained budget'):close(observer,self.root/'cleanup.raw',123.0,refuse)
  self.assertEqual(waits,[]);self.assertIn(('abort',),calls);self.assertIn(('trace',(7,7,0,9)),calls);self.assertIn(('deadline',123.0),calls)
if __name__=='__main__':unittest.main()
