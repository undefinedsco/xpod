"""Complete raw two-ABI private WAIT mismatch mechanics; no native authority."""
import copy,hashlib,json,sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT))
from qlever.tests.test_sdk_generated_mm_cohort import cohort_fixture
from qlever.tests.test_sdk_generated_vma_bindings import observe,renumber,b
from qlever.tests.test_sdk_generated_vma_kernel_link import m,lease

def fixture(arch=0xc000003e):
 rows,originals=cohort_fixture(arch);rows[0]['generatedVmaModel']=m.PRIVATE_WAIT_MODEL;epoch=next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='map');mapping=originals[epoch['mapsOriginal']['path']]+b'70000000-70001000 rw-p 00000000 00:00 0 [stack]\n';bar=next(r for r in rows if r['kind']=='all-stop-barrier');serial=500000;extra=[]
 def add(kind,**kw):
  nonlocal serial
  serial+=1;row=dict(kind=kind,phase='configure',sequence=serial,observedMonotonicNs='100000000000',**kw);extra.append(row);return row
 def stop():return add('all-stop-barrier',pids=copy.deepcopy(bar['pids']),osStates=['t','t'],taskOwnership=copy.deepcopy(bar['taskOwnership']))
 def samples():
  result=[]
  for pid in [10,11]:
   name='capture-%d.original'%serial;originals[name]=mapping;ref=dict(path=name,bytes=len(mapping),sha256=hashlib.sha256(mapping).hexdigest());add('toolchain-original',captureKind='maps',observedPid=pid,original=ref);result.append(dict(pid=pid,original=ref,mapping=m.wait_word_mapping(b.parse_proc_maps(mapping),0x70000000)))
  return result
 entry=add('kernel-syscall',pid=10,arch=arch,op='entry',nr=202 if arch==0xc000003e else 98,args=[0x70000000,393,0,0,0,0xffffffff]);pre=stop();before=samples();word=m.raw_record(b'\x01\0\0\0');common=dict(pid=10,entrySequence=entry['sequence'],originSequence=next(r['originSequence'] for r in rows if r['sequence']==epoch['windowSequence']),epochSequence=epoch['sequence'],memoryDomain=epoch['memoryDomain'],memoryDomainMembers=[10,11]);win=add('generated-vma-operation-window',operation='private-wait-mismatch',barrierSequence=pre['sequence'],reservationBytes=m.wait_reservation_bytes(2,4*1024**2),metadataMaximumBytes=4*1024**2,procLease=lease(),wordOriginal=word,cohortMaps=before,machineWordBytes=8,byteOrder='little',**common);add('exclusive-generated-vma-resume',pid=10,entrySequence=entry['sequence'],captureSequence=win['sequence']);actual=add('kernel-syscall',pid=10,arch=arch,op='exit',entrySequence=entry['sequence'],result=-11,isError=True);post=stop();after=samples();close=add('generated-vma-operation-exit',operation='private-wait-mismatch',windowSequence=win['sequence'],exitSequence=actual['sequence'],result=-11,isError=True,postBarrierSequence=post['sequence'],wordOriginal=word,cohortMaps=after,procAfter=lease(),**common);add('exclusive-captured-syscall-exit',pid=10,entrySequence=entry['sequence'],result=-11,isError=True)
 last=next(r for r in rows if r['kind']=='exclusive-captured-syscall-exit' and r['entrySequence']==epoch['entrySequence']);at=rows.index(last)+1;rows[at:at]=extra;renumber(rows)
 for row in rows:row['observedMonotonicNs']=str(100000000000+row['sequence']*1000000)
 return rows,originals
class Tests(unittest.TestCase):
 def test_complete_two_abi_mismatch_keeps_mapping_and_consumer(self):
  for arch in m.ABI:
   rows,originals=fixture(arch);proof=observe(rows,originals);self.assertEqual(len(proof['verifiedPrivateWaitMismatchEntrySequences']),1);self.assertTrue(proof['generatedMappedConsumerByteCustodyVerified']);self.assertFalse(proof['overallSdkSourceVerified'])
 def test_dimensions_and_complete_word_bounds(self):
  active=dict(address=4096,span=8192);entry=dict(arch=0xc000003e,nr=202,args=[0x70000000,393,0,0,0,0xffffffff]);self.assertEqual(m.private_wait_dimensions(entry,active),0x70000000)
  for index,values in [(0,[0,1,4096,(1<<64)-1]),(1,[129,137,9,394,True]),(2,[1,1<<32,True]),(3,[1]),(4,[1]),(5,[0,1,1<<64])]:
   for value in values:
    bad=copy.deepcopy(entry);bad['args'][index]=value
    with self.subTest(index=index,value=value),self.assertRaises(ValueError):m.private_wait_dimensions(bad,active)
  for data in [b'\0'*4,b'\1',b'\1'*8]:
   with self.assertRaises(ValueError):m.verify_wait_word(m.raw_record(data),entry,active)
 def test_complete_resealed_negatives(self):
  for arch in m.ABI:
   for mode in ['equal','success','timeout','errno','missing-barrier','peer','domain','reserve','pid','file','shared','wordchanged','proc','proc-empty','proc-mode','proc-length','proc-bool','oldmodel']:
    rows,originals=fixture(arch);win=next(r for r in rows if r.get('operation')=='private-wait-mismatch' and r['kind']=='generated-vma-operation-window');close=next(r for r in rows if r.get('operation')=='private-wait-mismatch' and r['kind']=='generated-vma-operation-exit');actual=next(r for r in rows if r['sequence']==close['exitSequence'])
    if mode=='equal':win['wordOriginal']=m.raw_record(b'\0'*4)
    elif mode in ['success','timeout','errno']:actual['result']={'success':0,'timeout':-110,'errno':-14}[mode];actual['isError']=mode!='success';close.update(result=actual['result'],isError=actual['isError'])
    elif mode=='missing-barrier':close['postBarrierSequence']=win['barrierSequence']
    elif mode=='peer':actual['pid']=11
    elif mode=='domain':win['memoryDomain']+=1
    elif mode=='reserve':win['reservationBytes']-=1
    elif mode=='pid':win['cohortMaps'][1]['pid']=10
    elif mode in ['file','shared']:
     ref=win['cohortMaps'][0]['original'];data=originals[ref['path']].replace(b'00:00 0 [stack]',b'00:00 1 [stack]') if mode=='file' else originals[ref['path']].replace(b'rw-p',b'rw-s');originals[ref['path']]=data;ref.update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
    elif mode=='wordchanged':close['wordOriginal']=m.raw_record(b'\2\0\0\0')
    elif mode=='proc':close['procAfter']['starttime']='124'
    elif mode.startswith('proc-'):
     for item in [win['procLease'],close['procAfter']]:
      if mode=='proc-empty':item['directoryIdentity']=[];item['statIdentity']=[]
      elif mode=='proc-mode':item['directoryIdentity'][2]=0o100444;item['statIdentity'][2]=0o40500
      elif mode=='proc-length':item['directoryIdentity'].append(1)
      elif mode=='proc-bool':item['directoryIdentity'][0]=True
    elif mode=='oldmodel':rows[0]['generatedVmaModel']=m.PRIVATE_WAKE_MODEL
    with self.subTest(arch=arch,mode=mode),self.assertRaises((ValueError,AssertionError,KeyError)):observe(rows,originals)

class RuntimeTests(unittest.TestCase):
 def setup(self):
  import importlib.util,io,time,threading
  spec=importlib.util.spec_from_file_location('wait_core',ROOT/'qlever/scripts/sdk-ptrace-execution.py');core=importlib.util.module_from_spec(spec);spec.loader.exec_module(core)
  backend=core.Observer(ROOT,ROOT,m.BUILD_ROOT,maximum_bytes=64*1024**2,maximum_file_bytes=1024**2,shared_tasks=True,capture_toolchain=True,generated_vma_output=True,generated_vma_shared_mm=True,generated_vma_private_wake=True,generated_vma_private_wait_mismatch=True);backend.raw=io.BytesIO();backend.current_phase='configure';backend.deadline=time.monotonic()+10;backend.seq=10;backend.tasks={pid:dict(stopped=True,exited=False,fdTable=10,tgid=10) for pid in [10,11]};g=backend.generated_vma;g.mm.record(dict(kind='owned-root-binding',pid=10,sequence=1));g.mm.record(dict(kind='actual-child-binding',parentPid=10,childPid=11,event=3,sequence=2,cloneFlags=0x100));g.active=dict(pid=10,address=4096,span=8192,length=6336,page=4096,sequence=3,origin=dict(sequence=2),memoryDomain=1,memoryDomainMembers=[10,11]);g.reserved=100000;g.spending_thread=threading.get_ident();backend.barrier=lambda:backend.emit(dict(kind='all-stop-barrier',pids=[10,11],osStates=['t','t'],taskOwnership=[dict(tid=p,tgid=10,fdTable=10) for p in [10,11]]))
  data=b'70000000-70001000 rw-p 00000000 00:00 0 [stack]\n'
  def maps(pid):
   backend.claim(len(data));ref=dict(path='capture-%d.original'%backend.seq,bytes=len(data),sha256=hashlib.sha256(data).hexdigest());return backend.emit(dict(kind='toolchain-original',captureKind='maps',observedPid=pid,original=ref)),core.bindings.parse_proc_maps(data)
  backend.tool_maps=maps
  class Lease:
   def __init__(self,*args):self.first=lease()
   def sample(self):return lease()
   def close(self):return []
  return core,backend,g,Lease
 def entry(self,backend):
  row=backend.emit(dict(kind='kernel-syscall',op='entry',pid=10,arch=0xc000003e,nr=202,args=[0x70000000,393,0,0,0,0xffffffff]));backend.tasks[10]['entry']=row;return row
 def test_actual_ledger_complete_restores_only_closing_share(self):
  from unittest.mock import patch
  core,backend,g,Lease=self.setup();baseline=g.reserved
  with patch.object(core.generated_vma_module,'ProcLease',Lease),patch.object(core.single,'trace',return_value=1) as peek:
   entry=self.entry(backend);self.assertTrue(g.classify(10,entry,None));win=g.capture(10);backend.emit(dict(kind='exclusive-generated-vma-resume',pid=10,entrySequence=entry['sequence'],captureSequence=win['sequence']));backend.exclusive=(10,entry['sequence']);actual=backend.emit(dict(kind='kernel-syscall',op='exit',pid=10,arch=entry['arch'],entrySequence=entry['sequence'],result=-11,isError=True));g.finish(10,entry,actual);backend.emit(dict(kind='exclusive-captured-syscall-exit',pid=10,entrySequence=entry['sequence'],result=-11,isError=True));self.assertEqual(peek.call_count,2)
  self.assertEqual(g.reserved,baseline);self.assertEqual(g.pending,{});self.assertIsNotNone(g.active);self.assertIsNone(g.wake_closing)
 def test_reserve_minus_one_has_zero_maps_word_or_lease_reads(self):
  from unittest.mock import patch
  core,backend,g,Lease=self.setup();entry=self.entry(backend);g.classify(10,entry,None);backend.maximum_bytes=backend.domain_bytes+g.reserved+m.wait_reservation_bytes(2,backend.tool_metadata_bytes)-1
  with patch.object(backend,'barrier') as barrier,patch.object(backend,'tool_maps') as maps,patch.object(backend,'generated_wait_word') as word,patch.object(core.generated_vma_module,'ProcLease') as proc,self.assertRaises(AssertionError):g.capture(10)
  for mock in [barrier,maps,word,proc]:mock.assert_not_called()
  self.assertIn(10,g.pending);self.assertIsNotNone(g.active)
 def test_equal_word_never_resumes_or_seals(self):
  from unittest.mock import patch
  core,backend,g,Lease=self.setup();entry=self.entry(backend);g.classify(10,entry,None)
  with patch.object(core.generated_vma_module,'ProcLease',Lease),patch.object(core.single,'trace',return_value=0),self.assertRaisesRegex(ValueError,'must differ'):g.capture(10)
  self.assertIn(10,g.pending);self.assertIsNotNone(g.active);self.assertIsNone(g.wake_closing)
 def test_sole_ptrace_word_lanes_and_errno(self):
  from unittest.mock import patch
  import errno
  core,backend,g,Lease=self.setup()
  with patch.object(core.single,'trace',return_value=0x1122334455667788) as peek:
   self.assertEqual(backend.generated_wait_word(10,0x70000000),bytes.fromhex('88776655'));self.assertEqual(backend.generated_wait_word(10,0x70000004),bytes.fromhex('44332211'));self.assertEqual(peek.call_args.args[2],0x70000000)
  with patch.object(core.single,'trace',side_effect=OSError(errno.EIO,'peek denied')),self.assertRaises(OSError):backend.generated_wait_word(10,0x70000000)
  with patch.object(core.sys,'byteorder','big'),self.assertRaises(AssertionError):backend.generated_wait_word(10,0x70000000)

class EntryTests(unittest.TestCase):
 def test_source_zip_complete_mismatch_only(self):
  from unittest.mock import patch
  from qlever.tests import test_sdk_generated_private_wake as prior
  with patch.object(prior,'wake_fixture',side_effect=lambda arch:fixture(arch)):
   prior.SourceZipTests('test_complete_source_zip_only_discharges_verified_entry').test_complete_source_zip_only_discharges_verified_entry()
 def test_normal_explicit_and_generic_false_parent_unchanged(self):
  from unittest.mock import patch
  import inspect,time
  core,backend,g,Lease=RuntimeTests().setup();self.assertIs(inspect.signature(core.Observer).parameters['generated_vma_private_wait_mismatch'].default,False)
  marker=RuntimeError('before-platform');end=time.monotonic()+10;check=lambda:None
  with patch.object(core.Observer,'__init__',side_effect=marker) as called:
   with self.assertRaises(RuntimeError) as caught:core.SdkExecutionObserver(ROOT,'/opt/qlever-sdk/source',m.BUILD_ROOT,deadline_monotonic=end,check_budget=check,maximum_bytes=4096,maximum_stdio_bytes=1024)
  self.assertIs(caught.exception,marker);kw=called.call_args.kwargs;self.assertIs(kw['generated_vma_private_wait_mismatch'],True);self.assertIs(kw['generated_vma_private_wake'],True);self.assertIs(kw['generated_vma_shared_mm'],True);self.assertEqual(kw['deadline_monotonic'],end);self.assertIs(kw['check_budget'],check);self.assertEqual(kw['maximum_bytes'],4096);self.assertEqual(kw['maximum_stdio_bytes'],1024)
if __name__=='__main__':unittest.main()
