"""Typed complete two-ABI wake replay; no kernel/native or source authority."""
import copy,hashlib,importlib.util,json,sys,unittest,io,time,threading
from unittest.mock import patch
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT))
from qlever.tests.test_sdk_generated_mm_cohort import cohort_fixture
from qlever.tests.test_sdk_generated_vma_bindings import observe,renumber
from qlever.tests.test_sdk_generated_vma_kernel_link import m

def wake_fixture(arch=0xc000003e,wakes=1):
 rows,originals=cohort_fixture(arch);rows[0]['generatedVmaModel']=m.PRIVATE_WAKE_MODEL
 epoch=next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='map');window=next(r for r in rows if r['sequence']==epoch['windowSequence']);bar=next(r for r in rows if r['sequence']==window['barrierSequence']);end=next(r for r in rows if r['kind']=='exclusive-captured-syscall-exit' and r['entrySequence']==window['entrySequence']);index=rows.index(end)+1;serial=200000
 for _ in range(wakes):
  def row(kind,**fields):
   nonlocal serial
   serial+=1;return dict(kind=kind,phase='configure',sequence=serial,observedMonotonicNs='100000000000',**fields)
  entry=row('kernel-syscall',pid=10,arch=arch,op='entry',nr=202 if arch==0xc000003e else 98,args=[0x70000000,129,1,0,(1<<64)-1,129]);before=row('all-stop-barrier',pids=list(bar['pids']),osStates=list(bar['osStates']),taskOwnership=copy.deepcopy(bar['taskOwnership']));win=row('generated-vma-operation-window',operation='private-wake',pid=10,entrySequence=entry['sequence'],barrierSequence=before['sequence'],epochSequence=epoch['sequence'],originSequence=window['originSequence'],memoryDomain=epoch['memoryDomain'],memoryDomainMembers=list(epoch['memoryDomainMembers']),wakeCount=1,reservationBytes=m.WAKE_RESERVATION_BYTES);resume=row('exclusive-generated-vma-resume',pid=10,entrySequence=entry['sequence'],captureSequence=win['sequence']);actual=row('kernel-syscall',pid=10,arch=arch,op='exit',entrySequence=entry['sequence'],result=0,isError=False);post=row('all-stop-barrier',pids=list(before['pids']),osStates=list(before['osStates']),taskOwnership=copy.deepcopy(before['taskOwnership']));closed=row('generated-vma-operation-exit',operation='private-wake',pid=10,entrySequence=entry['sequence'],windowSequence=win['sequence'],exitSequence=actual['sequence'],result=0,isError=False,originSequence=window['originSequence'],epochSequence=epoch['sequence'],memoryDomain=epoch['memoryDomain'],memoryDomainMembers=list(epoch['memoryDomainMembers']),postBarrierSequence=post['sequence'],wakeCount=1);last=row('exclusive-captured-syscall-exit',pid=10,entrySequence=entry['sequence'],result=0,isError=False);items=[entry,before,win,resume,actual,post,closed,last];rows[index:index]=items;index+=len(items)
 renumber(rows)
 for r in rows:r['observedMonotonicNs']=str(100000000000+r['sequence']*1000000)
 return rows,originals
class Tests(unittest.TestCase):
 def test_both_abis_complete_repeated_wakes_preserve_final_checkpoint(self):
  for arch in [0xc000003e,0xc00000b7]:
   rows,originals=wake_fixture(arch,2);proof=observe(rows,originals);expected=[r['sequence'] for r in rows if r['kind']=='generated-vma-operation-window' and r['operation']=='private-wake'];self.assertEqual(proof['verifiedPrivateWakeEntrySequences'],[next(r['entrySequence'] for r in rows if r['sequence']==seq) for seq in expected]);self.assertTrue(proof['generatedMappedConsumerByteCustodyVerified']);self.assertFalse(proof['overallSdkSourceVerified'])
 def test_canonical_positive_fullword_only(self):
  active=dict(address=0x1000,span=0x2000);base=dict(arch=0xc000003e,nr=202,args=[0x70000000,129,1,0,123,456]);self.assertEqual(m.private_wake_dimensions(base,active),1)
  for index,values in [(0,[0,1,0x1000,0x2ffc]),(1,[1,128,130,133,137,138,129+(1<<32),True]),(2,[0,-1,1<<31,1<<32,True])]:
   for value in values:
    row=copy.deepcopy(base);row['args'][index]=value
    with self.subTest(index=index,value=value),self.assertRaises(ValueError):m.private_wake_dimensions(row,active)
 def test_old_v4_still_refuses_exact_private_wake(self):
  rows,originals=wake_fixture();rows[0]['generatedVmaModel']=m.COHORT_MODEL
  with self.assertRaises(ValueError):observe(rows,originals)
 def test_full_raw_negatives(self):
  for arch in [0xc000003e,0xc00000b7]:
   for mode in ['shared','wait','pi','requeue','highcount','bad-address','negative','overcount','error','stale-pre','missing-post','ownership','missing-member','wrong-domain','peer','reserve-minus','reserve-plus','gap','missing-close']:
    rows,originals=wake_fixture(arch);win=next(r for r in rows if r['kind']=='generated-vma-operation-window' and r['operation']=='private-wake');entry=next(r for r in rows if r['sequence']==win['entrySequence']);actual=next(r for r in rows if r['kind']=='kernel-syscall' and r.get('op')=='exit' and r.get('entrySequence')==entry['sequence']);close=next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='private-wake');post=next(r for r in rows if r['sequence']==close['postBarrierSequence'])
    if mode in ['shared','wait','pi','requeue']:entry['args'][1]={'shared':1,'wait':128,'pi':134,'requeue':131}[mode]
    elif mode=='highcount':entry['args'][2]=1<<32
    elif mode=='bad-address':entry['args'][0]=0x1000
    elif mode=='negative':actual['result']=-1;actual['isError']=True
    elif mode=='overcount':actual['result']=2;close['result']=2
    elif mode=='error':actual['isError']=True
    elif mode=='stale-pre':win['barrierSequence']=next(r['sequence'] for r in rows if r['kind']=='all-stop-barrier')
    elif mode=='missing-post':close['postBarrierSequence']=win['barrierSequence']
    elif mode=='ownership':post['taskOwnership'][1]['fdTable']=11
    elif mode=='missing-member':win['memoryDomainMembers']=[10]
    elif mode=='wrong-domain':win['memoryDomain']+=1
    elif mode=='peer':entry['pid']=11
    elif mode=='reserve-minus':win['reservationBytes']-=1
    elif mode=='reserve-plus':win['reservationBytes']+=1
    elif mode=='gap':rows.insert(rows.index(post),dict(kind='all-stop-barrier',phase='configure',sequence=999999,observedMonotonicNs=post['observedMonotonicNs'],pids=post['pids'],osStates=post['osStates'],taskOwnership=post['taskOwnership']));renumber(rows)
    elif mode=='missing-close':rows.remove(next(r for r in rows if r['kind']=='exclusive-captured-syscall-exit' and r['entrySequence']==entry['sequence']));renumber(rows)
    with self.subTest(arch=arch,mode=mode),self.assertRaises((ValueError,AssertionError,KeyError)):observe(rows,originals)

class SourceZipTests(unittest.TestCase):
 def test_complete_source_zip_only_discharges_verified_entry(self):
  import tempfile,zipfile
  spec=importlib.util.spec_from_file_location('wake_source_scanner',ROOT/'qlever/scripts/sdk-generated-source-originals.py');scanner=importlib.util.module_from_spec(spec);spec.loader.exec_module(scanner)
  for arch in [0xc000003e,0xc00000b7]:
   for outside in [False,True]:
    rows,originals=wake_fixture(arch);prefix='inner/toolchain-execution/';members={prefix+'captures/'+name:data for name,data in originals.items()};rows[0]['command']=['fixed-fixture-command']
    if outside:
     target=next(r for r in rows if r['kind']=='actual-wait-exit');i=rows.index(target);rows[i:i]=[dict(kind='kernel-syscall',phase='configure',sequence=90000,observedMonotonicNs=target['observedMonotonicNs'],pid=10,arch=arch,op='entry',nr=202 if arch==0xc000003e else 98,args=[0x70000000,129,1,0,0,0]),dict(kind='kernel-syscall',phase='configure',sequence=90001,observedMonotonicNs=target['observedMonotonicNs'],pid=10,arch=arch,op='exit',entrySequence=90000,result=0,isError=False)];renumber(rows)
    def ref(path):return dict(path=path,bytes=len(members[path]),sha256=hashlib.sha256(members[path]).hexdigest())
    captures=[ref(path) for path in sorted(members)];index=prefix+'capture-index-0000.json';members[index]=json.dumps(dict(schemaVersion=1,files=captures)).encode();raw=prefix+'configure.trace-0000.jsonl';members[raw]=b''.join((json.dumps(row)+'\n').encode() for row in rows);provider=prefix+'source-provider.mountinfo.raw';members[provider]=b'1 0 0:1 / / ro - overlay overlay rw\n';required={r['path']:dict(bytes=r['original']['bytes'],sha256=r['original']['sha256']) for r in rows if r['kind']=='fd-capture' and r['role']=='consumer'}
    plan=dict(sourceRoot='/opt/qlever-sdk/source',sourceProviderOriginals=dict(mountinfo=ref(provider)),remainingMilliseconds=5000,phases=[dict(name='configure',actualCommand=['fixed-fixture-command'],rawTraceShards=[ref(raw)],captures=dict(indexes=[ref(index)],files=len(captures),bytes=sum(r['bytes'] for r in captures)))],sourceFiles={},requiredInputs=required)
    base=ROOT/'.test-data/sdk-private-wake-zip';base.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(dir=base) as directory:
     archive=Path(directory)/'originals.zip'
     with zipfile.ZipFile(archive,'w') as out:
      for path,data in members.items():out.writestr(path,data)
     result=scanner.observe(archive,plan)
    label='unclassified-kernel-operation:'+hex(arch)+':'+str(202 if arch==0xc000003e else 98)
    self.assertEqual(label in result['uncoveredOperations'],outside);self.assertFalse(result['overallSdkSourceVerified'])

class RuntimeTests(unittest.TestCase):
 def setup_runtime(self):
  spec=importlib.util.spec_from_file_location('wake_core',ROOT/'qlever/scripts/sdk-ptrace-execution.py');core=importlib.util.module_from_spec(spec);spec.loader.exec_module(core)
  b=core.Observer(ROOT,ROOT,m.BUILD_ROOT,maximum_bytes=2*1024**2,maximum_file_bytes=1024**2,shared_tasks=True,capture_toolchain=True,generated_vma_output=True,generated_vma_shared_mm=True,generated_vma_private_wake=True);b.raw=io.BytesIO();b.current_phase='configure';b.deadline=time.monotonic()+10;b.seq=10;b.tasks={pid:dict(stopped=True,exited=False,fdTable=10,tgid=10) for pid in [10,11]};g=b.generated_vma;g.mm.record(dict(kind='owned-root-binding',pid=10,sequence=1));g.mm.record(dict(kind='actual-child-binding',parentPid=10,childPid=11,event=3,sequence=2,cloneFlags=0x100));g.active=dict(pid=10,address=4096,span=8192,length=6336,page=4096,sequence=3,origin=dict(sequence=2),memoryDomain=1,memoryDomainMembers=[10,11]);g.reserved=100000;g.spending_thread=threading.get_ident();b.barrier=lambda:b.emit(dict(kind='all-stop-barrier',pids=[10,11],osStates=['t','t'],taskOwnership=[dict(tid=pid,tgid=10,fdTable=10) for pid in [10,11]]));return core,b,g
 def entry(self,b):
  row=b.emit(dict(kind='kernel-syscall',op='entry',pid=10,arch=0xc000003e,nr=202,args=[0x70000000,129,1,0,123,129]));b.tasks[10]['entry']=row;return row
 def complete(self,b,g):
  baseline=g.reserved;entry=self.entry(b);self.assertTrue(g.classify(10,entry,None));window=g.capture(10);b.emit(dict(kind='exclusive-generated-vma-resume',pid=10,entrySequence=entry['sequence'],captureSequence=window['sequence']));b.exclusive=(10,entry['sequence']);actual=b.emit(dict(kind='kernel-syscall',op='exit',pid=10,arch=0xc000003e,entrySequence=entry['sequence'],result=0,isError=False));g.finish(10,entry,actual);self.assertIsNotNone(g.wake_closing);b.emit(dict(kind='exclusive-captured-syscall-exit',pid=10,entrySequence=entry['sequence'],result=0,isError=False));b.exclusive=None;self.assertEqual(g.reserved,baseline);self.assertIsNone(g.wake_closing);self.assertEqual(g.pending,{});self.assertIsNotNone(g.active)
 def test_actual_claim_ledger_restores_only_unused_wake_share(self):
  core,b,g=self.setup_runtime();raw_start=len(b.raw.getvalue());before=b.domain_bytes
  with patch.object(core.os,'pread',side_effect=AssertionError('no payload read')),patch.object(core.os,'stat',side_effect=AssertionError('no proc read')):self.complete(b,g);self.complete(b,g)
  rows=[json.loads(raw) for raw in b.raw.getvalue().splitlines()];self.assertEqual(len(rows),16);self.assertEqual(b.domain_bytes-before,len(b.raw.getvalue())-raw_start);self.assertEqual(b.capture_bytes,0);self.assertLess(b.domain_bytes,2*m.WAKE_RESERVATION_BYTES)
 def test_reservation_exact_and_minus_one_before_any_barrier_or_body(self):
  for delta in [-1,0]:
   core,b,g=self.setup_runtime();entry=self.entry(b);g.classify(10,entry,None);b.maximum_bytes=b.domain_bytes+g.reserved+m.WAKE_RESERVATION_BYTES+delta
   if delta<0:
    with patch.object(b,'barrier') as barrier,patch.object(core.os,'pread') as read,self.assertRaisesRegex(AssertionError,'cannot reserve generated checkpoint'):g.capture(10)
    barrier.assert_not_called();read.assert_not_called();self.assertIsNotNone(g.active);self.assertIn(10,g.pending)
   else:self.assertEqual(g.capture(10)['reservationBytes'],m.WAKE_RESERVATION_BYTES)
 def test_failure_never_restores_epoch_as_closed(self):
  core,b,g=self.setup_runtime();entry=self.entry(b);g.classify(10,entry,None);window=g.capture(10);b.emit(dict(kind='exclusive-generated-vma-resume',pid=10,entrySequence=entry['sequence'],captureSequence=window['sequence']));b.exclusive=(10,entry['sequence']);actual=b.emit(dict(kind='kernel-syscall',op='exit',pid=10,arch=0xc000003e,entrySequence=entry['sequence'],result=-14,isError=True))
  with self.assertRaises(ValueError):g.finish(10,entry,actual)
  self.assertIsNotNone(g.active);self.assertIn(10,g.pending);self.assertIsNone(g.wake_closing)
 def test_generic_default_false_normal_explicit_true(self):
  import inspect
  core,b,g=self.setup_runtime();self.assertIs(inspect.signature(core.Observer).parameters['generated_vma_private_wake'].default,False)
  self.assertEqual(g.model,m.PRIVATE_WAKE_MODEL)
  marker=RuntimeError('stop-before-platform');end=time.monotonic()+10;check=lambda:None
  with patch.object(core.Observer,'__init__',side_effect=marker) as constructor:
   with self.assertRaises(RuntimeError) as caught:core.SdkExecutionObserver(ROOT,'/opt/qlever-sdk/source',m.BUILD_ROOT,deadline_monotonic=end,check_budget=check,maximum_bytes=4096,maximum_stdio_bytes=1024)
  self.assertIs(caught.exception,marker);kw=constructor.call_args.kwargs
  for key in ['generated_vma_output','generated_vma_shared_mm','generated_vma_private_wake','shared_tasks','capture_toolchain','deny_optional_io_uring','verified_identity_noop','terminal_exit_evidence']:self.assertIs(kw[key],True)
  self.assertIs(kw['check_budget'],check);self.assertEqual(kw['deadline_monotonic'],end);self.assertEqual(kw['maximum_bytes'],4096);self.assertEqual(kw['maximum_stdio_bytes'],1024);self.assertNotIn('verified_setresuid_noop',kw)
if __name__=='__main__':unittest.main()
