import copy,ctypes,errno,hashlib,importlib.util,json,types,socket,stat,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parents[1]/'scripts'
spec=importlib.util.spec_from_file_location('daemon_originals',HERE/'sdk-local-daemon-originals.py');daemon=importlib.util.module_from_spec(spec);spec.loader.exec_module(daemon)
UNIX=b'Num RefCount Protocol Flags Type St Inode Path\n0000000000000000: 00000002 00000000 00010000 0001 01 123 /run/docker.sock\n'
SERVICE=b'MainPID=42\nActiveState=active\nSubState=running\nInvocationID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nNRestarts=0\n'
STATUS=b'Uid:\t0\t0\t0\t0\nNSpid:\t42\n'
def frame():
 ns={role:{'link':role+':[88]','identity':[1,88,stat.S_IFREG|0o444,0,3,4]} for role in ['pid','mnt','user']}
 return dict(mainPid=42,daemonFd=3,creatorFd=9,service=daemon.service_fields(SERVICE),creatorPid=1,creatorUid=0,creatorExecutable='/usr/lib/systemd/systemd',daemonExecutable='/usr/bin/dockerd',daemonExecutableIdentity=[1,23,stat.S_IFREG|0o755,33,3,4],daemonExecutableSha256='a'*64,heldListenerIdentity=[9,123,stat.S_IFSOCK|0o777,0,3,4],namedListenerIdentity=[9,123,stat.S_IFSOCK|0o777,0,3,4],creatorListenerIdentity=[9,123,stat.S_IFSOCK|0o777,0,3,4],listenerName='/run/docker.sock',socketType=socket.SOCK_STREAM,acceptConn=1,controllerPidNamespace='pid:[88]',daemonPidNamespace='pid:[88]',hostPidNamespace='pid:[88]',controllerRootIdentity=[1,2,stat.S_IFDIR|0o755,4096,3,4],daemonRootIdentity=[1,2,stat.S_IFDIR|0o755,4096,3,4],namespaces=ns)
def closed_collection():
 files={};refs=[]
 def original(name,value):
  data=value if isinstance(value,bytes) else (json.dumps(value,sort_keys=True)+'\n').encode();files[name]=data;ref=dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest());refs.append(ref);return ref
 request=original('listener-request.original.json',dict(mainPid=42,daemonFd=3,creatorFd=9,inode=123,endpoint='/run/docker.sock',flags=0));frames=[]
 for index in range(2):
  name='service-'+str(index);parent='stages/'+name+'/';stdout=original(parent+'stdout.raw',SERVICE);stderr=original(parent+'stderr.raw',b'');raw=original('stages/'+name+'.raw.log',b'')
  command=['/usr/bin/python3','-I','-S','-B','/tmp/controller/qlever/scripts/sdk-local-daemon-originals.py','--systemctl-child']
  strip=lambda ref:dict(ref,path=ref['path'].rsplit('/',1)[-1])
  receipt=original(parent+'command.receipt.json',dict(command=command,exit=0,signal=None,actualWait=True,rawClosedBeforeHash=True,pgid=10,pid=11,startedUnixNs=100+index*100,completedUnixNs=110+index*100,stdout=strip(stdout),stderr=strip(stderr)))
  supervisor=original('stages/'+name+'.receipt.json',dict(exit=0,signal=None,actualWait=True,ownedGroupAbsentAfterWait=True,rawClosedBeforeHash=True,pgid=10,rawSHA256=raw['sha256'],resourceStop=None,supervisorError=None,cleanupErrors=[]))
  value=frame();value.update(serviceStage=dict(name=name,receipt=receipt,stdout=stdout,stderr=stderr,supervisionReceipt=supervisor,supervisionRaw=raw),procUnixOriginal=original('proc-unix-'+str(index)+'.original',UNIX),statusOriginal=original('status-'+str(index)+'.original',STATUS));frames.append(value)
 return dict(schemaVersion=1,kind='actual-systemd-dockerd-listener-association',listenerRequest=request,frames=frames,originals=refs),files
class Activation(unittest.TestCase):
 def test_actual_raw_tuple_selects_exact_service_and_listener(self):
  result=daemon.verify_frame(frame(),dict(serviceStdout=SERVICE,procUnix=UNIX,status=STATUS));self.assertEqual(result['mainPid'],42);self.assertEqual(result['listener'],{'inode':123,'path':'/run/docker.sock'})
  # Our held duplicate may change a kernel refcount; no identity is relaxed.
  other=daemon.verify_frame(frame(),dict(serviceStdout=SERVICE,procUnix=UNIX.replace(b'00000002',b'00000004'),status=STATUS));self.assertEqual(result,other)
 def test_wrong_daemon_creator_root_and_socket_identity_reject(self):
  changes=[lambda v:v.update(creatorPid=2),lambda v:v.update(creatorExecutable='/usr/bin/proxy'),lambda v:v.update(daemonExecutable='/usr/local/bin/dockerd'),lambda v:v.update(mainPid=43),lambda v:v.update(acceptConn=0),lambda v:v.update(listenerName='/tmp/proxy.sock'),lambda v:v['namedListenerIdentity'].__setitem__(1,124),lambda v:v['daemonRootIdentity'].__setitem__(1,3),lambda v:v['namespaces']['mnt']['identity'].__setitem__(1,99)]
  for mutate in changes:
   value=frame();mutate(value)
   with self.assertRaises(ValueError):daemon.verify_frame(value,dict(serviceStdout=SERVICE,procUnix=UNIX,status=STATUS))
 def test_unknown_duplicate_and_nonlistening_endpoints_reject(self):
  for raw in [UNIX+UNIX.splitlines(keepends=True)[1],UNIX.replace(b'/run/docker.sock',b'/run/proxy.sock'),UNIX.replace(b'00010000',b'00000000'),UNIX.replace(b'0001 01',b'0002 01')]:
   with self.assertRaises(ValueError):daemon.listener_row(raw)
 def test_service_restart_unknown_and_nonroot_status_reject(self):
  for raw in [SERVICE+b'MainPID=42\n',SERVICE.replace(b'active',b'inactive'),SERVICE.replace(b'MainPID=42',b'MainPID=1'),SERVICE+b'Environment=secret\n']:
   with self.assertRaises(ValueError):daemon.service_fields(raw)
  with self.assertRaises(ValueError):daemon.verify_frame(frame(),dict(serviceStdout=SERVICE,procUnix=UNIX,status=STATUS.replace(b'0\t0\t0\t0',b'1000\t1000\t1000\t1000')))
 def test_pidfd_getfd_enosys_eperm_have_no_fallback(self):
  class Function:
   def __call__(self,*args):ctypes.set_errno(errno.EPERM);return -1
  class Library:pidfd_getfd=Function()
  for libc,expected in [(object(),errno.ENOSYS),(Library(),errno.EPERM)]:
   with patch.object(daemon.ctypes,'CDLL',return_value=libc):
    with self.assertRaises(OSError) as caught:daemon.duplicate_pidfd_listener(10,3)
    self.assertEqual(caught.exception.errno,expected)
 def test_permission_and_missing_kernel_support_retain_bounded_refusal_originals(self):
  root=HERE.parents[1]/'.test-data/daemon-refusals';root.mkdir(parents=True,exist_ok=True)
  def service_only(value):return SERVICE,{}
  for error in [errno.EPERM,errno.ENOSYS]:
   with tempfile.TemporaryDirectory(dir=root) as directory:
    out=Path(directory)/'daemon-activation'
    with patch.object(daemon.HeldActivatedDaemon,'_service',service_only),patch.object(daemon.HeldActivatedDaemon,'_proc',return_value=UNIX),patch.object(daemon.HeldActivatedDaemon,'_listener_fd',side_effect=lambda pid,inode:3 if pid==42 else 9),patch.object(daemon.os,'pidfd_open',return_value=10,create=True),patch.object(daemon.os,'open',return_value=11),patch.object(daemon.os,'close'),patch.object(daemon.os,'O_PATH',0,create=True),patch.object(daemon,'duplicate_pidfd_listener',side_effect=OSError(error,'refused')):
     with self.assertRaises(OSError) as caught:daemon.HeldActivatedDaemon({'pid':1,'uid':0},out,lambda:None,lambda:5,lambda path,maximum,check:Path(path).read_bytes())
    self.assertEqual(caught.exception.errno,error);failure=json.loads((out/'failure.original.json').read_text());self.assertEqual(failure['errno'],error);self.assertEqual(failure['operation'],'actual-pidfd-getfd');self.assertFalse(failure['authorityVerified']);self.assertLess((out/'failure.original.json').stat().st_size,1024);self.assertTrue((out/'proc-unix-0.original').is_file());self.assertTrue((out/'listener-request.original.json').is_file())
 def test_collection_closed_original_graph_and_actual_wait_binding(self):
  value,files=closed_collection();proof=daemon.verify_collection(value,lambda ref:files[ref['path']]);self.assertEqual(proof['mainPid'],42);self.assertEqual(len(proof['serviceWindows']),2)
  for mutate in [lambda v:v['originals'].pop(),lambda v:v['originals'].append({'path':'unused','bytes':0,'sha256':hashlib.sha256(b'').hexdigest()}),lambda v:v['frames'][1]['service'].__setitem__('NRestarts','1'),lambda v:v['frames'][1]['serviceStage']['stdout'].__setitem__('sha256','f'*64),lambda v:v['frames'][1]['serviceStage'].__setitem__('supervisionRaw',v['frames'][0]['serviceStage']['supervisionRaw'])]:
   changed=copy.deepcopy(value);mutate(changed)
   with self.assertRaises((ValueError,KeyError)):daemon.verify_collection(changed,lambda ref:files[ref['path']])
  bad=dict(files);ref=value['frames'][0]['serviceStage']['supervisionReceipt'];body=json.loads(bad[ref['path']]);body['actualWait']=False;data=(json.dumps(body,sort_keys=True)+'\n').encode();bad[ref['path']]=data;changed=copy.deepcopy(value)
  replacement=dict(ref,bytes=len(data),sha256=hashlib.sha256(data).hexdigest());changed['frames'][0]['serviceStage']['supervisionReceipt']=replacement;changed['originals']=[replacement if row['path']==replacement['path'] else row for row in changed['originals']]
  with self.assertRaisesRegex(ValueError,'supervisor closure'):daemon.verify_collection(changed,lambda reference:bad[reference['path']])
 def test_actual_sample_success_control_flow_with_mocked_kernel_observations(self):
  root=HERE.parents[1]/'.test-data/daemon-success';root.mkdir(parents=True,exist_ok=True)
  def status(dev,ino,mode,size=0):return types.SimpleNamespace(st_dev=dev,st_ino=ino,st_mode=mode,st_size=size,st_mtime_ns=3,st_ctime_ns=4)
  identities={11:status(1,23,stat.S_IFREG|0o755,3),12:status(1,88,stat.S_IFREG|0o444),13:status(1,89,stat.S_IFREG|0o444),14:status(1,90,stat.S_IFREG|0o444),15:status(1,2,stat.S_IFDIR|0o755,4096),16:status(9,123,stat.S_IFSOCK|0o777)}
  realstat=daemon.os.stat;reallink=daemon.os.readlink;position=[0]
  def named(path,*args,**kwargs):
   path=str(path)
   if path.startswith('/proc/'):
    if path.endswith('/exe'):return identities[11]
    if path.endswith('/root'):return identities[15]
    if '/fd/' in path:return identities[16]
    return identities[{'pid':12,'mnt':13,'user':14}[path.rsplit('/',1)[-1]]]
   return realstat(path,*args,**kwargs)
  def link(path):
   path=str(path)
   if not path.startswith('/proc/'):return reallink(path)
   if path.endswith('/exe'):return '/usr/bin/dockerd'
   return {'pid':'pid:[88]','mnt':'mnt:[89]','user':'user:[90]'}[path.rsplit('/',1)[-1]]
  class Socket:
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def getsockname(self):return '/run/docker.sock'
   def getsockopt(self,level,option):return socket.SOCK_STREAM if option==socket.SO_TYPE else 1
  poll=types.SimpleNamespace(register=lambda *args:None,poll=lambda *args:[])
  with tempfile.TemporaryDirectory(dir=root) as directory:
   value=object.__new__(daemon.HeldActivatedDaemon);value.root=Path(directory);value.check=lambda:None;value.refs={};value.retained=0;value.frames=[];value.first=None;value.main_pid=42;value.daemon_fd=3;value.creator_fd=9;value.creator={'pid':1,'uid':0,'executablePath':'/usr/lib/systemd/systemd'};value.fds={'pidfd':10,'exe':11,'pid':12,'mnt':13,'user':14,'root':15,'listener':16}
   def seek(*args):position[0]=0
   def read(*args):position[0]+=1;return b'abc' if position[0]==1 else b''
   with patch.object(daemon.os,'stat',side_effect=named),patch.object(daemon.os,'fstat',side_effect=lambda fd:identities[fd]),patch.object(daemon.os,'readlink',side_effect=link),patch.object(daemon.os,'lseek',side_effect=seek),patch.object(daemon.os,'read',side_effect=read),patch.object(daemon.os,'dup',return_value=100),patch.object(daemon.select,'poll',return_value=poll),patch.object(daemon.socket,'socket',return_value=Socket()),patch.object(value,'_listener_fd',side_effect=lambda pid,inode:3 if pid==42 else 9),patch.object(value,'_proc',return_value=STATUS):
    first=value._sample(SERVICE,{},UNIX);value.first=first;second=value._sample(SERVICE,{},UNIX)
    collection,actual_files=closed_collection()
    def observe_service(instance):
     stage=collection['frames'][len(instance.frames)]['serviceStage']
     for role in ['receipt','stdout','stderr','supervisionReceipt','supervisionRaw']:
      reference=stage[role];path=instance.root/reference['path'];path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(actual_files[reference['path']]);instance.refs[reference['path']]=reference;instance.retained+=reference['bytes']
     return SERVICE,stage
    def opened(path,flags):
     path=str(path)
     if path.endswith('/exe'):return 11
     if path.endswith('/root'):return 15
     return {'pid':12,'mnt':13,'user':14}[path.rsplit('/',1)[-1]]
    with patch.object(daemon.HeldActivatedDaemon,'_service',observe_service),patch.object(daemon.HeldActivatedDaemon,'_proc',side_effect=lambda path,maximum:UNIX if path=='/proc/net/unix' else STATUS),patch.object(daemon.HeldActivatedDaemon,'_listener_fd',side_effect=lambda pid,inode:3 if pid==42 else 9),patch.object(daemon.os,'pidfd_open',return_value=10,create=True),patch.object(daemon.os,'open',side_effect=opened),patch.object(daemon.os,'close'),patch.object(daemon.os,'O_PATH',0,create=True),patch.object(daemon,'duplicate_pidfd_listener',return_value=16):
     actual=daemon.HeldActivatedDaemon(value.creator,value.root/'constructed',lambda:None,lambda:5,lambda path,maximum,check:Path(path).read_bytes());self.assertEqual(actual.sample(),actual.first);sealed=actual.seal();self.assertIn('daemonActivation',sealed);self.assertTrue((actual.root/'collection.json').is_file());actual.close()
   self.assertEqual(first,second);self.assertEqual(len(value.frames),2);self.assertEqual(first['daemonExecutableSha256'],hashlib.sha256(b'abc').hexdigest());self.assertTrue((value.root/'status-1.original').is_file())
if __name__=='__main__':unittest.main()
