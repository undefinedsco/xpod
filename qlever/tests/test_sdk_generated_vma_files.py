"""Actual temporary regular FDs; simulated stop/backend, never ptrace or child."""
import hashlib,importlib.util,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('vma_files',Path(__file__).resolve().parents[1]/'scripts/sdk-generated-vma-originals.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Backend:
 def __init__(self,root):self.build=str(root);self.retained=set();self.tasks={10:{'entry':None,'exited':False}};self.seq=0;self.exclusive=None;self.originals={}
 def emit(self,row):self.seq+=1;return dict(row,sequence=self.seq)
 def barrier(self):return self.emit(dict(kind='all-stop-barrier',pids=[10],taskOwnership=[dict(tid=10,fdTable=10)]))
 def snapshot_write_original(self,fd,size):
  data=os.pread(fd,size,0);ref=dict(path=str(len(self.originals)),bytes=len(data),sha256=hashlib.sha256(data).hexdigest());self.originals[ref['path']]=data;return ref
 def generated_fd_flags(self,pid,fd):return 2
class Tests(unittest.TestCase):
 def setUp(self):
  root=Path.cwd()/'.test-data'/'generated-vma-files';root.mkdir(parents=True,exist_ok=True);self.temp=tempfile.TemporaryDirectory(dir=root);self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name);self.b=Backend(self.root);self.r=m.Runtime(self.b);self.addCleanup(self.r.close)
 def create(self,flags=194):
  path=self.root/'out';entry=dict(kind='kernel-syscall',op='entry',sequence=1,arch=0xc00000b7,nr=56,args=[-100,0,flags,0o600,0,0]);self.b.seq=1;self.b.tasks[10]['entry']=entry
  self.assertTrue(self.r.classify(10,entry,lambda *args:str(path)));self.r.capture(10);fd=os.open(path,os.O_RDWR|os.O_CREAT|os.O_EXCL,0o600);self.addCleanup(os.close,fd);self.b.exclusive=(10,1);original_open=m.os.open
  def opened(name,*args,**kwargs):return original_open(path if str(name)=='/proc/10/fd/'+str(fd) else name,*args,**kwargs)
  with patch.object(m.os,'open',side_effect=opened):row=self.r.finish(10,entry,dict(sequence=4,result=fd,isError=False))
  return path,fd,row
 def test_actual_create_and_zero_extension_same_held_fd(self):
  path,fd,row=self.create();origin=next(iter(self.r.origins.values()));self.assertEqual(origin['identity'],m.identity(os.fstat(fd)));self.assertEqual(self.b.originals[row['original']['path']],b'');self.assertIsNone(self.r.pending.get(10))
  entry=dict(sequence=8,arch=0xc00000b7,nr=46,args=[fd,1,0,0,0,0]);self.b.tasks[10]['entry']=entry;self.r.pending[10]=dict(op='resize',origin=origin,fd=fd,window=dict(sequence=10));self.b.exclusive=(10,8);os.ftruncate(fd,1);result=self.r.finish(10,entry,dict(sequence=11,result=0,isError=False));self.assertEqual(self.b.originals[result['original']['path']],b'\0');self.assertEqual(origin['identity'],m.identity(os.fstat(fd)));self.assertEqual(len(self.b.retained),1)
 def test_create_postimage_failure_closes_only_its_owned_leases(self):
  with patch.object(self.b,'generated_fd_flags',return_value=0):
   with self.assertRaises(ValueError):self.create()
  self.assertEqual(self.b.retained,set());self.assertEqual(self.r.origins,{});self.assertIsNone(self.r.pending[10]['parentFd'])
 def test_create_body_error_survives_parent_close_failure_and_closes_other_fd(self):
  original=RuntimeError('actual postimage failed');closed=[];real_close=m.os.close
  def close(fd):
   if m.stat.S_ISDIR(os.fstat(fd).st_mode):raise OSError('parent close failed')
   closed.append(fd);return real_close(fd)
  with patch.object(self.b,'generated_fd_flags',side_effect=original),patch.object(m.os,'close',side_effect=close):
   with self.assertRaises(RuntimeError) as caught:self.create()
  self.assertIs(caught.exception,original);self.assertTrue(closed);self.assertEqual(len(self.b.retained),1);self.assertEqual(len(self.r.cleanup_errors),1);parent=self.r.pending[10]['parentFd'];self.assertIn(parent,self.b.retained);os.fstat(parent)
  self.r.close();self.assertEqual(self.b.retained,set())
 def test_cleanup_attempts_every_real_fd_and_keeps_failed_one_for_outer_retry(self):
  first=os.open(self.root,os.O_RDONLY);file=self.root/'cleanup';file.write_bytes(b'');second=os.open(file,os.O_RDONLY);self.b.retained.update([first,second]);real_close=m.os.close;failure=OSError('first')
  def close(fd):
   if fd==first:raise failure
   real_close(fd)
  with patch.object(m.os,'close',side_effect=close):errors=self.r.cleanup_fds([first,second])
  self.assertEqual(errors,[failure]);self.assertEqual(self.b.retained,{first})
  with self.assertRaises(OSError):os.fstat(second)
  self.r.cleanup_fds([first]);self.assertEqual(self.b.retained,set())
 def test_nonzero_extension_rejects_without_replacing_origin(self):
  path,fd,row=self.create();origin=next(iter(self.r.origins.values()));before=list(origin['identity']);entry=dict(sequence=8);self.r.pending[10]=dict(op='resize',origin=origin,window=dict(sequence=10));self.b.exclusive=(10,8);os.write(fd,b'X')
  with self.assertRaises(ValueError):self.r.finish(10,entry,dict(sequence=11,result=0,isError=False))
  self.assertEqual(origin['identity'],before)
 def test_snapshot_rejects_large_or_changed_original(self):
  path=self.root/'large';path.write_bytes(b'XX');fd=os.open(path,os.O_RDONLY);self.addCleanup(os.close,fd)
  with self.assertRaises(ValueError):self.r.snapshot(fd)
 def test_shared_mm_not_tgid_guess(self):
  mm=m.MemoryDomains();mm.record(dict(kind='owned-root-binding',pid=10,sequence=1));mm.record(dict(kind='actual-child-binding',parentPid=10,childPid=11,cloneFlags=0x100,sequence=2))
  with self.assertRaises(ValueError):mm.unique(10)
  mm.record(dict(kind='actual-wait-exit',pid=11,sequence=3));self.assertEqual(mm.unique(10),1)
 def mapping_control(self,arch,epochs,rebind=False,mutation=None):
  # Real retained regular FD/bytes; maps/ptrace stops are explicitly simulated.
  path,fd,created=self.create();origin=next(iter(self.r.origins.values()));os.ftruncate(fd,1);origin.update(identity=m.identity(os.fstat(fd)),data=(1,hashlib.sha256(b'\0').hexdigest()))
  self.r.mm.domains={10:1};self.b.tool_metadata_bytes=4*1024**2;self.b.deadline=m.time.monotonic()+100;self.b.check=lambda:None;self.b.writable_aliases=lambda *args:[dict(pid=10,fd=fd,accessMode=2,flags=2)];reserved=[];self.b.reserve_generated_bytes=lambda count:reserved.append(count)
  class Wait:
   parent_deadline=self.b.deadline
   def clamp(inner,end):inner.end=end;inner.token=object();return inner.token
   def restore(inner,token):self.assertIs(token,inner.token);inner.restored=True
  self.b.waiter=Wait();state={'mapped':False}
  proc=self.root/'proc-task';proc.mkdir();(proc/'stat').write_bytes(b'10 (fixture) t '+b' '.join([b'0']*18+[b'123'])+b'\n')
  def maps(pid):
   current=m.identity(os.fstat(fd));rows=[dict(startHex='1000',endHex='2000',permissions='rw-s',fileOffset=0,deviceMajor=os.major(current[0]),deviceMinor=os.minor(current[0]),inode=current[1])] if state['mapped'] else []
   return dict(original=dict(path='maps',bytes=1,sha256='0'*64)),rows
  self.b.generated_fd_path=lambda *args:str(path);self.b.tool_maps=maps;original_stat=m.os.stat;original_open=m.os.open
  readlinks=[]
  def link(value):
   readlinks.append(str(value))
   if mutation=='link' and len(readlinks)==2:return str(path)+' (deleted)'
   if mutation=='proc' and len(readlinks)==1:(proc/'stat').write_bytes(b'10 (fixture) t '+b' '.join([b'0']*18+[b'999'])+b'\n')
   return str(path)
  def redirect(value):
   if str(value)=='/proc/10':return proc
   if str(value).startswith('/proc/10/fd/'):return path
   if str(value).startswith('/proc/10/map_files/'):raise AssertionError('map_files must never be opened or stat-followed')
   return value
  def stat(value,*args,**kwargs):return original_stat(redirect(value),*args,**kwargs)
  def opened(value,*args,**kwargs):return original_open(redirect(value),*args,**kwargs)
  with patch.object(m.os,'stat',side_effect=stat),patch.object(m.os,'open',side_effect=opened),patch.object(m.os,'sysconf',return_value=4096),patch.object(m.os,'readlink',side_effect=link):
   for index in range(epochs):
    selected=fd
    if rebind and index:
     self.r.record(dict(kind='kernel-syscall',op='entry',pid=10,arch=arch,nr=m.ABI[arch]['close'],args=[fd,0,0,0,0,0]))
     selected=os.dup(fd);self.addCleanup(os.close,selected)
    self.b.writable_aliases=lambda *args:[dict(pid=10,fd=selected,accessMode=2,flags=2)]
    start=20+index*100;data=[b'X',b'Y'][index];entry=dict(sequence=start,arch=arch,nr=m.ABI[arch]['map'],args=[0,1,3,0x4001,selected,0]);self.b.tasks[10]['entry']=entry;self.b.seq=start;self.assertTrue(self.r.classify(10,entry,None));self.r.capture(10);self.b.exclusive=(10,start);state['mapped']=True
    if mutation=='body':os.pwrite(fd,b'Z',0)
    if mutation=='flags':self.b.generated_fd_flags=lambda *args:0
    self.b.seq+=1;self.r.finish(10,entry,dict(sequence=self.b.seq,result=4096,isError=False));self.assertEqual(self.r.owner,10);self.assertEqual(reserved,[m.reservation_bytes(0,4*1024**2)]*(index+1))
    os.pwrite(fd,data,0);entry=dict(sequence=start+10,arch=arch,nr=m.ABI[arch]['unmap'],args=[4096,1,0,0,0,0]);self.b.tasks[10]['entry']=entry;self.b.seq=start+10;self.assertTrue(self.r.classify(10,entry,None));self.r.capture(10);self.b.exclusive=(10,start+10);state['mapped']=False;checkpoint=self.r.finish(10,entry,dict(sequence=start+15,result=0,isError=False));self.assertIsNone(self.r.owner);self.assertTrue(self.b.waiter.restored);self.assertEqual(self.b.originals[checkpoint['original']['path']],data);self.r.complete_phase()
    self.assertTrue(self.r.consumer(dict(sequence=start+20,path=str(path)),(1,hashlib.sha256(data).hexdigest()),m.identity(os.fstat(fd))))
   os.pwrite(fd,b'Z',0)
   with self.assertRaises(ValueError):self.r.consumer(dict(sequence=start+21,path=str(path)),(1,hashlib.sha256(data).hexdigest()),m.identity(os.fstat(fd)))
 def test_actual_fd_simulated_poststop_changes_reject_and_owned_cleanup(self):
  original_root=self.root
  for mutation in ['link','proc','body','flags']:
   self.root=original_root/mutation;self.root.mkdir();self.b=Backend(self.root);self.r=m.Runtime(self.b);self.addCleanup(self.r.close)
   with self.assertRaises(ValueError):self.mapping_control(0xc00000b7,1,mutation=mutation)
   self.r.close();self.assertEqual(self.b.retained,set())
 def test_proc_lease_wrong_pid_or_nonstop_raw_rejected(self):
  for data in [b'11 (fixture) t '+b' '.join([b'0']*19)+b'\n',b'10 (fixture) Z '+b' '.join([b'0']*19)+b'\n']:
   with self.assertRaises(ValueError):m.proc_identity(data,10)
 def test_simulated_stop_mapping_lease_checkpoint_and_shared_ledger(self):self.mapping_control(0xc00000b7,1)
 def test_two_epochs_keep_same_actual_fd_and_updated_full_snapshot_both_abis(self):
  original_root=self.root
  for arch in [0xc00000b7,0xc000003e]:
   self.root=original_root/str(arch);self.root.mkdir();self.b=Backend(self.root);self.r=m.Runtime(self.b);self.addCleanup(self.r.close);self.mapping_control(arch,2)
 def test_new_selected_fd_full_binding_two_epochs_both_abis(self):
  original_root=self.root
  for arch in [0xc00000b7,0xc000003e]:
   self.root=original_root/str(arch);self.root.mkdir();self.b=Backend(self.root);self.r=m.Runtime(self.b);self.addCleanup(self.r.close);self.mapping_control(arch,2,True)
if __name__=='__main__':unittest.main()
