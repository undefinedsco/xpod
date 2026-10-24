"""Complete real file reads with modeled proc metadata; native probes are separate."""
import contextlib,copy,hashlib,importlib.util,io,json,os,tempfile,time,types,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('maps_content_backend',ROOT/'qlever/scripts/sdk-ptrace-execution.py');core=importlib.util.module_from_spec(spec);spec.loader.exec_module(core)
MODEL='same-phase-maps-content-entity-v1'
BODY=b'1000-2000 r--p 00000000 00:00 0 /bin/fixture\n'
class ActualStorageTests(unittest.TestCase):
 def setUp(self):
  parent=ROOT/'.test-data/sdk-maps-content';parent.mkdir(exist_ok=True);self.temp=tempfile.TemporaryDirectory(dir=parent);self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name);self.out=self.root/'out';self.out.mkdir();self.source=self.root/'modeled-proc-maps';self.source.write_bytes(BODY)
  self.b=core.Observer(self.out,self.root,self.root,maximum_bytes=4*1024**2,capture_content_entities=True,capture_toolchain=True,capture_maps_content_entities=True);self.b.raw=io.BytesIO();self.b.current_phase='compile';self.b.deadline=time.monotonic()+20;self.read_bytes=0
  real_open=open;real_stat=os.stat;real_fstat=os.fstat;inode=real_stat(self.source).st_ino
  def metadata(value):return types.SimpleNamespace(**{key:getattr(value,key)for key in ['st_dev','st_ino','st_mode','st_nlink','st_mtime_ns','st_ctime_ns']},st_size=0)
  class Reader:
   def __init__(inner):inner.file=real_open(self.source,'rb')
   def __enter__(inner):return inner
   def __exit__(inner,*args):return inner.file.__exit__(*args)
   def fileno(inner):return inner.file.fileno()
   def read(inner,size):
    block=inner.file.read(size);self.read_bytes+=len(block);return block
  self.addCleanup(self.b.close);self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close)
  self.stack.enter_context(patch.object(core,'open',side_effect=lambda path,*a,**k:Reader()if os.fspath(path)in ['/proc/10/maps','/proc/11/maps']else real_open(path,*a,**k),create=True))
  self.stack.enter_context(patch.object(core.os,'stat',side_effect=lambda path,*a,**k:metadata(real_stat(self.source))if os.fspath(path)in ['/proc/10/maps','/proc/11/maps']else real_stat(path,*a,**k)))
  self.stack.enter_context(patch.object(core.os,'fstat',side_effect=lambda fd:metadata(real_fstat(fd))if real_fstat(fd).st_ino==inode else real_fstat(fd)))
 def test_each_sample_reads_complete_current_file_and_rechecks_retained_entity(self):
  first,_=self.b.tool_maps(10);start=self.b.capture_bytes;seen=[];pread=os.pread
  def read(fd,size,offset):
   block=pread(fd,size,offset);seen.append(len(block));return block
  with patch.object(core.os,'pread',side_effect=read):second,_=self.b.tool_maps(11)
  self.assertEqual(self.read_bytes,2*len(BODY));self.assertEqual(sum(seen),len(BODY));self.assertEqual(self.b.capture_bytes,start)
  self.assertEqual(core.bindings.physical_original_reference(first['original']),core.bindings.physical_original_reference(second['original']))
  self.assertNotEqual(first['original']['observationSequence'],second['original']['observationSequence']);self.assertEqual(second['originalReuse'],dict(model=MODEL,originCaptureSequence=first['sequence']))
  self.assertEqual(len(self.b.phase_capture_files(0)),1);self.assertEqual(len(list(self.out.glob('capture-*.original'))),1)
 def test_different_body_and_different_phase_are_new_physical_originals(self):
  first,_=self.b.tool_maps(10);self.source.write_bytes(BODY.replace(b'1000',b'1100'));second,_=self.b.tool_maps(10)
  self.b.current_phase='configure';third,_=self.b.tool_maps(10)
  self.assertEqual(len({row['original']['path']for row in [first,second,third]}),3)
  self.assertNotIn('originalReuse',second);self.assertNotIn('originalReuse',third)
 def test_changed_canonical_entity_refuses_after_fresh_current_read(self):
  first,_=self.b.tool_maps(10);path=self.out/first['original']['path'];path.write_bytes(b'x'*len(BODY))
  with self.assertRaisesRegex(AssertionError,'capture entity changed|capture entity bytes'):self.b.tool_maps(10)
  self.assertEqual(self.read_bytes,2*len(BODY))
 def test_body_budget_refuses_before_physical_write(self):
  self.b.maximum_bytes=len(BODY)-1
  with self.assertRaisesRegex(AssertionError,'shared execution original byte bound'):self.b.tool_maps(10)
  self.assertEqual(self.read_bytes,len(BODY));self.assertEqual(self.b.domain_bytes,0)
  self.assertEqual((self.out/'capture-0000.original').stat().st_size,0)
 def test_old_storage_mode_keeps_unique_complete_physical_files(self):
  self.b.capture_maps_content_entities=False;first,_=self.b.tool_maps(10);second,_=self.b.tool_maps(10)
  self.assertNotEqual(first['original']['path'],second['original']['path']);self.assertNotIn('observationSequence',first['original']);self.assertEqual(self.b.capture_bytes,2*len(BODY))

def fixture():
 ref=dict(path='capture-0000.original',bytes=len(BODY),sha256=hashlib.sha256(BODY).hexdigest());entity=[2,100,0o100600,len(BODY),4,5,1];window=[1,33,0o100444,0,4,5,1]
 rows=[dict(kind='owned-root-binding',pid=10,backend='ptrace-all-stop-process-v1',captureOriginalEntityModel='same-phase-content-entity-v2',mapsOriginalEntityModel=MODEL),dict(kind='all-stop-barrier',pids=[10],osStates=['t'])]
 for seq in [3,4]:
  row=dict(kind='toolchain-original',captureKind='maps',observedPid=10,original=dict(ref,observationSequence=seq),originalEntityIdentity=entity,mapsWindowIdentity=window,mapsWindowAfterIdentity=window,mapsNamedWindowIdentity=window,mapsNamedWindowAfterIdentity=window)
  if seq==4:row['originalReuse']=dict(model=MODEL,originCaptureSequence=3)
  rows.append(row)
 rows.append(dict(kind='actual-wait-exit',pid=10,returnCode=0))
 return [dict(row,phase='compile',sequence=i+1)for i,row in enumerate(rows)]
class IndependentReplayTests(unittest.TestCase):
 def inspect(self,rows):return core.bindings.observe([('compile',[(json.dumps(row)+'\n').encode()for row in rows])],lambda name,maximum:BODY,{})
 def test_actual_observations_share_storage_without_granting_source_authority(self):
  report=self.inspect(fixture());self.assertFalse(report['overallSdkSourceVerified'])
 def test_mixed_missing_forward_and_relabelled_originals_refuse(self):
  for mode in ['model','unmarked','null','forward','nonmaps','pid','sample','missing-sample','entity','window','named','prior-phase','other-body']:
   rows=copy.deepcopy(fixture());row=rows[3]
   if mode=='model':rows[0].pop('mapsOriginalEntityModel')
   elif mode=='unmarked':row.pop('originalReuse')
   elif mode=='null':row['originalReuse']=None
   elif mode=='forward':row['originalReuse']['originCaptureSequence']=4
   elif mode=='nonmaps':row['captureKind']='file'
   elif mode=='pid':row['observedPid']=11
   elif mode=='sample':row['original']['observationSequence']=3
   elif mode=='missing-sample':row['original'].pop('observationSequence')
   elif mode=='entity':row['originalEntityIdentity']=[*row['originalEntityIdentity'][:1],999,*row['originalEntityIdentity'][2:]]
   elif mode=='window':row['mapsWindowAfterIdentity']=[0]*7
   elif mode=='named':row['mapsNamedWindowIdentity']=[0]*7
   elif mode=='prior-phase':rows[2]['phase']='configure'
   elif mode=='other-body':row['original']['sha256']='a'*64
   with self.subTest(mode=mode),self.assertRaises((ValueError,KeyError)):self.inspect(rows)
if __name__=='__main__':unittest.main()
