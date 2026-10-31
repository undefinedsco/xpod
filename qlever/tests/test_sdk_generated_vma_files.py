"""Actual temporary regular FDs; simulated stop/backend, never ptrace or child."""
import hashlib,importlib.util,os,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('vma_files',Path(__file__).resolve().parents[1]/'scripts/sdk-generated-vma-originals.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
_OBSERVER=importlib.util.spec_from_file_location('vma_observer_owner',Path(__file__).resolve().parents[1]/'scripts/sdk-ptrace-execution.py')
_observer=importlib.util.module_from_spec(_OBSERVER);_OBSERVER.loader.exec_module(_observer)
class Wait:
 # Mirrors BlockingOwnedWait's shape closely enough for the REAL
 # open/close/owned_window_state code: an active window whose armed deadline is
 # strictly before the parent, one-shot clamp, and restore back to parent.
 def __init__(inner,parent_deadline):
  inner.parent_deadline=parent_deadline;inner.deadline=parent_deadline
  inner.active=True;inner.window=None;inner.token=None;inner.restored=False
 def clamp(inner,end):
  if not inner.active:raise ValueError('active owned wait required to clamp')
  if inner.window is not None:raise ValueError('one active owned wait window required')
  if end>inner.parent_deadline:raise ValueError('window may not extend owned parent deadline')
  inner.deadline=end;inner.token=object();inner.window=inner.token;return inner.token
 def restore(inner,token):
  assert token is inner.token,'owned wait token differs'
  inner.window=None;inner.deadline=inner.parent_deadline;inner.restored=True

class Backend:
 def __init__(self,root):self.maximum_file_bytes=1024**2;self.check=lambda:None;self.check_deadline=lambda:None;self.build=str(root);self.retained=set();self.tasks={10:{'entry':None,'exited':False}};self.seq=0;self.exclusive=None;self.originals={};self.deadline=time.monotonic()+600;self.current_phase='generated-vma-files'
 # REAL owned-window lifecycle: bind the production Observer methods instead of
 # re-implementing them here, so the fixture exercises the actual clamp claim,
 # re-entrancy refusal, exact-tuple ownership test and unconditional reset.
 open_outer_lease_window=_observer.Observer.open_outer_lease_window
 close_outer_lease_window=_observer.Observer.close_outer_lease_window
 outer_lease_window_owned=_observer.Observer.outer_lease_window_owned
 owned_window_state=_observer.Observer.owned_window_state
 def window_arm(self,deadline_ns):self.armed_windows=getattr(self,'armed_windows',[])+[deadline_ns]
 def assert_no_nested_claim(self):
  """No claim may still be held once the runtime/observer finished."""
  if getattr(self,'_outer_lease_coalesce',None) is not None:raise AssertionError('leaked outer lease claim')
  return True
 # Production finish() now brackets its snapshot with the declared substep
 # boundary. Mirror that interface instead of stubbing it out, so the existing
 # timeout/order assertions still exercise the real call shape.
 def instrument_substep(self,name,function,*arguments,**keywords):return function(*arguments,**keywords)
 def emit(self,row):self.seq+=1;return dict(row,sequence=self.seq)
 def barrier(self):return self.emit(dict(kind='all-stop-barrier',pids=[10],taskOwnership=[dict(tid=10,fdTable=10)]))
 def snapshot_write_original(self,fd,size,offset=0):
  data=os.pread(fd,size,offset);ref=dict(path=str(len(self.originals)),bytes=len(data),sha256=hashlib.sha256(data).hexdigest());self.originals[ref['path']]=data;return ref
 def original_blocks(self,ref):
  raw=self.originals[ref['path']];return (raw[i:i+65536] for i in range(0,len(raw),65536))
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
 def test_actual_create_retains_same_held_empty_fd(self):
  path,fd,row=self.create();origin=next(iter(self.r.origins.values()));self.assertEqual(origin['identity'],m.identity(os.fstat(fd)));self.assertEqual(self.b.originals[row['original']['path']],b'');self.assertIsNone(self.r.pending.get(10))

 def resize_control(self,arch,sizes,mutation=None,shared_memory=False):
  path,fd,created=self.create();origin=next(iter(self.r.origins.values()));self.r.mm.domains={10:1};self.b.tool_metadata_bytes=4*1024**2;self.b.reserve_generated_bytes=lambda count:None;self.b.generated_fd_path=lambda *args:str(path);self.b.writable_aliases=lambda *args:[dict(pid=10,fd=fd,accessMode=2,flags=2)];self.b.tool_maps=lambda pid:(dict(original=dict(path='maps',bytes=0,sha256=hashlib.sha256(b'').hexdigest())),[])
  if shared_memory:
   self.r.mm.record(dict(kind='actual-child-binding',parentPid=10,childPid=11,cloneFlags=0x100,sequence=12));self.b.tasks[11]={'entry':None,'exited':False}
   self.b.barrier=lambda:self.b.emit(dict(kind='all-stop-barrier',pids=[10,11],osStates={'10':'t','11':'t'},taskOwnership=[dict(tid=10,fdTable=10),dict(tid=11,fdTable=11)]))
  proc=self.root/'resize-proc';proc.mkdir();(proc/'stat').write_bytes(b'10 (fixture) t '+b' '.join([b'0']*18+[b'123'])+b'\n');opened=m.os.open;statted=m.os.stat
  def redirect(value):return proc if str(value)=='/proc/10' else path if str(value).startswith('/proc/10/fd/') else value
  with patch.object(m.os,'open',side_effect=lambda value,*a,**kw:opened(redirect(value),*a,**kw)),patch.object(m.os,'stat',side_effect=lambda value,*a,**kw:statted(redirect(value),*a,**kw)):
   for index,size in enumerate(sizes):
    before=os.pread(fd,origin['identity'][3],0);start=20+index*50;entry=dict(sequence=start,arch=arch,nr=m.ABI[arch]['resize'],args=[fd,size,0,0,0,0]);self.b.tasks[10]['entry']=entry;self.b.seq=start;self.assertTrue(self.r.classify(10,entry,None));window=self.r.capture(10);self.b.exclusive=(10,start);os.ftruncate(fd,size)
    if mutation=='body' and size:os.pwrite(fd,b'Q',0)
    self.b.seq+=1;result=self.r.finish(10,entry,dict(sequence=self.b.seq,result=0,isError=False));expected=before[:size]+bytes(max(0,size-len(before)));self.assertEqual(self.b.originals[result['original']['path']],expected);self.assertEqual(origin['identity'],m.identity(os.fstat(fd)));self.assertEqual(self.b.originals[window['beforeOriginal']['path']],before)
  return origin
 def test_real_fd_resize_noop_shrink_regrow_zero_both_abis(self):
  parent=self.root
  for arch in m.ABI:
   self.root=parent/str(arch);self.root.mkdir();self.b=Backend(self.root);self.r=m.Runtime(self.b);self.addCleanup(self.r.close);self.resize_control(arch,[0,1,4096,65537,1024,1024,0,7])
 def test_shared_memory_peer_resize_retains_all_stop_and_complete_bytes_but_map_still_refuses(self):
  parent=self.root
  for arch in m.ABI:
   self.root=parent/str(arch);self.root.mkdir();self.b=Backend(self.root);self.r=m.Runtime(self.b);self.addCleanup(self.r.close);origin=self.resize_control(arch,[0,1,4097,3],shared_memory=True)
   self.assertEqual(self.r.mm.domains,{10:1,11:1});entry=dict(sequence=500,arch=arch,nr=m.ABI[arch]['map'],args=[0,origin['identity'][3],m.PROTECTION,m.FLAGS,origin['fd'],0]);self.b.tasks[10]['entry']=entry
   with patch.object(self.r,'lookup_fd',return_value=origin):
    with self.assertRaisesRegex(ValueError,'sole actual memory-domain'):self.r.classify(10,entry,None)
 def test_shared_memory_resize_still_refuses_existing_peer_mapping(self):
  capture=self.r.capture
  def guarded(pid):
   if self.r.pending[pid]['op']=='resize':
    origin=self.r.pending[pid]['origin'];dev,ino=origin['identity'][:2];self.b.tool_maps=lambda observed:(dict(original=dict(path='maps',bytes=0,sha256=hashlib.sha256(b'').hexdigest())),[dict(deviceMajor=os.major(dev),deviceMinor=os.minor(dev),inode=ino)] if observed==11 else [])
   return capture(pid)
  with patch.object(self.r,'capture',side_effect=guarded):
   with self.assertRaisesRegex(ValueError,'peer already maps'):self.resize_control(0xc00000b7,[4097],shared_memory=True)
 def test_resize_reservation_failure_happens_before_preimage_body_allocation(self):
  actual=self.b.snapshot_write_original;calls=[]
  self.b.snapshot_write_original=lambda *a,**kw:(calls.append(a[1]),actual(*a,**kw))[1]
  # create retains its zero-byte original; reserve failure must precede every resize snapshot.
  def denied(count):raise ValueError('remaining original ledger exhausted')
  original=lambda count:None
  # resize_control configures the callback, so wrap capture at its actual call boundary.
  capture=self.r.capture
  def guarded(pid):self.b.reserve_generated_bytes=denied;return capture(pid)
  with patch.object(self.r,'capture',side_effect=lambda pid:capture(pid) if self.r.pending[pid]['op']=='create' else guarded(pid)):
   with self.assertRaisesRegex(ValueError,'remaining original ledger'):self.resize_control(0xc00000b7,[4096])
  self.assertEqual(calls,[0])
 def test_resize_wrong_bytes_rejected_before_origin_update(self):
  with self.assertRaises(ValueError):self.resize_control(0xc00000b7,[4096],mutation='body')
 def test_existing_core_write_engine_advances_retained_origin_from_actual_full_projection(self):
  spec=importlib.util.spec_from_file_location('epoch_core',Path(__file__).resolve().parents[1]/'scripts/sdk-ptrace-execution.py');core=importlib.util.module_from_spec(spec);spec.loader.exec_module(core)
  path,fd,created=self.create();origin=next(iter(self.r.origins.values()));os.ftruncate(fd,7);origin.update(identity=m.identity(os.fstat(fd)),data=(7,hashlib.sha256(bytes(7)).hexdigest()))
  self.b.generated_vma=self.r;self.b.write_states={};self.b.write_projections={};self.b.append_chains={};self.b.producers={};self.b.prepared_inputs={};self.b.sole_writer=lambda pid,selected,current:[dict(pid=pid,fd=selected)];self.b.fd_blocks=lambda held,size:(os.pread(held,min(65536,size-i),i) for i in range(0,size,65536));self.b.reserve_generated_bytes=lambda count:None
  memory=self.root/'actual-buffer';memory.write_bytes(b'XY');entry=dict(kind='kernel-syscall',op='entry',pid=10,sequence=20,arch=0xc00000b7,nr=64,args=[fd,0,2,0,0,0]);self.b.tasks[10]['entry']=entry;self.r.record(entry);opened=core.os.open
  def open_at(value,*a,**kw):return opened(path if str(value)=='/proc/10/fd/'+str(fd) else memory if str(value)=='/proc/10/mem' else value,*a,**kw)
  with patch.object(self.r,'lookup_fd',return_value=origin),patch.object(core.os,'open',side_effect=open_at),patch.object(core,'fdpath',return_value=str(path)),patch.object(core,'descriptor_flags',return_value=2),patch.object(core,'descriptor_position',return_value=0):
   window=core.Observer.capture_write(self.b,10,fd);self.b.exclusive=(10,20);os.pwrite(fd,b'XY',0)
   original_stat=core.os.stat
   with patch.object(core.os,'stat',side_effect=lambda value,*a,**kw:original_stat(path if str(value)=='/proc/10/fd/'+str(fd) else value,*a,**kw)):core.Observer.complete_write(self.b,10,entry,dict(sequence=30,result=2,isError=False))
  self.assertFalse(origin['writePending']);self.assertEqual(origin['data'],(7,hashlib.sha256(b'XY'+bytes(5)).hexdigest()));self.assertEqual(origin['identity'],m.identity(os.fstat(fd)));self.assertEqual(self.b.originals[origin['original']['path']],b'XY'+bytes(5))
  # A new bridge error remains primary even when its writer lease close fails.
  entry['sequence']=40;self.r.record(entry);self.b.tasks[10]['entry']=entry
  with patch.object(self.r,'lookup_fd',return_value=origin),patch.object(core.os,'open',side_effect=open_at),patch.object(core,'fdpath',return_value=str(path)),patch.object(core,'descriptor_flags',return_value=2),patch.object(core,'descriptor_position',return_value=0):window=core.Observer.capture_write(self.b,10,fd)
  writer=self.b.tasks[10]['writeWindow'][1];self.b.exclusive=(10,40);primary=ValueError('actual bridge body failed');real_close=os.close
  def failing_close(selected):
   if selected==writer:raise OSError('writer cleanup failed')
   return real_close(selected)
  with patch.object(core.os,'stat',side_effect=lambda value,*a,**kw:original_stat(path if str(value)=='/proc/10/fd/'+str(fd) else value,*a,**kw)),patch.object(core,'descriptor_flags',return_value=2),patch.object(self.r,'snapshot',side_effect=primary),patch.object(core.os,'close',side_effect=failing_close):
   with self.assertRaises(ValueError) as caught:core.Observer.complete_write(self.b,10,entry,dict(sequence=50,result=2,isError=False))
  self.assertIs(caught.exception,primary);self.assertIn(writer,self.b.retained);self.assertEqual(len(self.r.cleanup_errors),1);real_close(writer);self.b.retained.remove(writer)
  origin.update(identity=m.identity(os.fstat(fd)),data=(7,'0'*64));self.b.tasks[10]['entry']=entry
  with patch.object(self.r,'lookup_fd',return_value=origin),patch.object(core.os,'open',side_effect=open_at),patch.object(core,'fdpath',return_value=str(path)),patch.object(core,'descriptor_flags',return_value=2),patch.object(core,'descriptor_position',return_value=0):
   with self.assertRaisesRegex(AssertionError,'entire before bytes differ'):core.Observer.capture_write(self.b,10,fd)


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
  path=self.root/'large';path.write_bytes(bytes(self.b.maximum_file_bytes+1));fd=os.open(path,os.O_RDONLY);self.addCleanup(os.close,fd)
  with self.assertRaises(ValueError):self.r.snapshot(fd)
 def test_shared_mm_not_tgid_guess(self):
  mm=m.MemoryDomains();mm.record(dict(kind='owned-root-binding',pid=10,sequence=1));mm.record(dict(kind='actual-child-binding',parentPid=10,childPid=11,cloneFlags=0x100,sequence=2))
  with self.assertRaises(ValueError):mm.unique(10)
  mm.record(dict(kind='actual-wait-exit',pid=11,sequence=3));self.assertEqual(mm.unique(10),1)
 def mapping_control(self,arch,epochs,rebind=False,mutation=None,shared_mm=False):
  # Real retained regular FD/bytes; maps/ptrace stops are explicitly simulated.
  path,fd,created=self.create();origin=next(iter(self.r.origins.values()));os.ftruncate(fd,1);origin.update(identity=m.identity(os.fstat(fd)),data=(1,hashlib.sha256(b'\0').hexdigest()))
  self.r.mm.domains={10:1};self.b.tool_metadata_bytes=4*1024**2;self.b.deadline=m.time.monotonic()+100;self.b.check=lambda:None;self.b.writable_aliases=lambda *args:[dict(pid=10,fd=fd,accessMode=2,flags=2)];reserved=[];self.b.reserve_generated_bytes=lambda count:reserved.append(count)
  if shared_mm:
   self.r.model=m.COHORT_MODEL;self.r.mm.domains[11]=1;self.b.tasks[11]={'entry':None,'exited':False};self.b.barrier=lambda:self.b.emit(dict(kind='all-stop-barrier',pids=[10,11],osStates=['t','t'],taskOwnership=[dict(tid=10,tgid=10,fdTable=10),dict(tid=11,tgid=10,fdTable=10)]))
  self.b.waiter=Wait(self.b.deadline);state={'mapped':False}
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
    self.b.seq+=1;self.r.finish(10,entry,dict(sequence=self.b.seq,result=4096,isError=False));self.assertEqual(self.r.owner,10);self.assertEqual(reserved,[(m.cohort_reservation_bytes(1,1,4*1024**2,1,rebind and i>0) if shared_mm else m.reservation_bytes(0,4*1024**2,1,rebind and i>0)) for i in range(index+1)])
    os.pwrite(fd,data,0);entry=dict(sequence=start+10,arch=arch,nr=m.ABI[arch]['unmap'],args=[4096,1,0,0,0,0]);self.b.tasks[10]['entry']=entry;self.b.seq=start+10;self.assertTrue(self.r.classify(10,entry,None));self.r.capture(10);self.b.exclusive=(10,start+10);state['mapped']=False
    if shared_mm:self.b.seq=start+15
    checkpoint=self.r.finish(10,entry,dict(sequence=start+15,result=0,isError=False));self.assertIsNone(self.r.owner);self.assertTrue(self.b.waiter.restored);self.assertEqual(self.b.originals[checkpoint['original']['path']],data);self.r.complete_phase()
    self.assertTrue(self.r.consumer(dict(sequence=start+20,path=str(path)),(1,hashlib.sha256(data).hexdigest()),m.identity(os.fstat(fd))))
   os.pwrite(fd,b'Z',0)
   with self.assertRaises(ValueError):self.r.consumer(dict(sequence=start+21,path=str(path)),(1,hashlib.sha256(data).hexdigest()),m.identity(os.fstat(fd)))
 def test_cohort_insufficient_reserve_reads_no_new_maps_or_body(self):
  snapshots=[];maps=[];actual=self.b.snapshot_write_original;capture=self.r.capture
  self.b.snapshot_write_original=lambda *args,**kwargs:(snapshots.append(args[1]),actual(*args,**kwargs))[1]
  def guarded(pid):
   if self.r.pending[pid]['op']=='map':
    self.b.reserve_generated_bytes=lambda count:(_ for _ in ()).throw(ValueError('remaining original ledger exhausted'))
    self.b.tool_maps=lambda pid:maps.append(pid)
   return capture(pid)
  with patch.object(self.r,'capture',side_effect=guarded):
   with self.assertRaisesRegex(ValueError,'remaining original ledger'):self.mapping_control(0xc000003e,1,shared_mm=True)
  self.assertEqual(snapshots,[0]);self.assertEqual(maps,[])
 def test_cohort_wrong_peer_backing_and_distinct_writable_alias_refused(self):
  original_root=self.root
  for mutation in ['peer-backing','other-table']:
   self.root=original_root/mutation;self.root.mkdir();self.b=Backend(self.root);self.r=m.Runtime(self.b);self.addCleanup(self.r.close);capture=self.r.capture
   def guarded(pid):
    if self.r.pending[pid]['op']=='map':
     if mutation=='other-table':self.b.writable_aliases=lambda *args:[dict(pid=10,fd=self.r.pending[pid]['fd'],accessMode=2,flags=2),dict(pid=11,fd=99,accessMode=2,flags=2)]
     else:
      current=self.b.tool_maps
      def wrong(peer):
       row,items=current(peer)
       if peer==11 and items:items=[dict(item,inode=item['inode']+1) for item in items]
       return row,items
      self.b.tool_maps=wrong
    return capture(pid)
   with patch.object(self.r,'capture',side_effect=guarded):
    with self.assertRaises(ValueError):self.mapping_control(0xc000003e,1,shared_mm=True)
   self.r.close();self.assertEqual(self.b.retained,set())
 def test_stopped_mm_cohort_real_fd_two_epochs_both_abis(self):
  original_root=self.root
  for arch in m.ABI:
   self.root=original_root/str(arch);self.root.mkdir();self.b=Backend(self.root);self.r=m.Runtime(self.b);self.addCleanup(self.r.close);self.mapping_control(arch,2,rebind=True,shared_mm=True)
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
   self.root=original_root/str(arch);self.root.mkdir();self.b=Backend(self.root);self.r=m.Runtime(self.b);self.addCleanup(self.r.close)
   self.mapping_control(arch,2)
   # OWNED-WINDOW LIFECYCLE across both epochs, asserted on the real observer
   # methods bound into this fixture: each epoch armed exactly one clamp, the
   # claim is released after each finish, and nothing leaks at close.
   self.assertTrue(self.b.waiter.restored,'the clamped window must be restored per epoch')
   self.assertIsNone(getattr(self.b,'_outer_lease_coalesce',None),
                     'no outer lease claim may outlive a finished epoch')
   self.assertEqual(len(self.b.armed_windows),2,'each epoch must arm exactly one window')
   self.assertFalse(self.b.outer_lease_window_owned(),
                    'a released claim must not report ownership')
   self.b.assert_no_nested_claim()
 def test_new_selected_fd_full_binding_two_epochs_both_abis(self):
  original_root=self.root
  for arch in [0xc00000b7,0xc000003e]:
   self.root=original_root/str(arch);self.root.mkdir();self.b=Backend(self.root);self.r=m.Runtime(self.b);self.addCleanup(self.r.close);self.mapping_control(arch,2,True)
 def test_outer_lease_window_refuses_nested_and_incomplete_claims(self):
  """Non-no-op lifecycle proof using the REAL open/close methods.

  A claim requires an armed local clamp and is never re-entrant; closing is
  unconditional and idempotent, and a nested attempt must be refused rather than
  silently coalescing into the outer claim.
  """
  self.b=Backend(self.root)
  self.b.waiter=Wait(self.b.deadline)
  self.assertIsNone(getattr(self.b,'_outer_lease_coalesce',None))
  # no clamp armed yet -> claiming must be refused, never silently accepted
  with self.assertRaises(AssertionError):
   self.b.open_outer_lease_window()
  end=min(self.b.deadline,time.monotonic()+m.WINDOW_SECONDS)
  self.b.waiter.clamp(end)
  self.b.open_outer_lease_window()
  claim=self.b._outer_lease_coalesce
  self.assertIsNotNone(claim)
  self.assertTrue(self.b.outer_lease_window_owned())
  # nested claim must be REFUSED, not merged into the held claim
  with self.assertRaises(AssertionError):
   self.b.open_outer_lease_window()
  self.assertIs(self.b._outer_lease_coalesce,claim,'a refused nested claim must not replace the held claim')
  # close is unconditional + idempotent
  self.b.close_outer_lease_window()
  self.assertIsNone(self.b._outer_lease_coalesce)
  self.assertFalse(self.b.outer_lease_window_owned())
  self.b.close_outer_lease_window()
  self.assertTrue(self.b.assert_no_nested_claim())

if __name__=='__main__':unittest.main()
