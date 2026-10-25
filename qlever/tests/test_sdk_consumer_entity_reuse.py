"""Ordinary real FDs and full raw/ZIP fixtures only; no ptrace/native claim."""
import copy,hashlib,importlib.util,io,json,os,tempfile,time,unittest,contextlib
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
core=load('entity_core',ROOT/'qlever/scripts/sdk-ptrace-execution.py');fixture=load('entity_raw',Path(__file__).with_name('test_sdk_generation_multiprocess_bindings.py'));zip_fixture=load('entity_zip',Path(__file__).with_name('test_sdk_generated_source_originals.py'))
def alias_rows(rows,originals):
 for row in rows:
  if row['kind']=='owned-root-binding':row['captureOriginalEntityModel']='same-phase-producer-original-v1'
 for cap in [r for r in rows if r['kind']=='fd-capture' and r['role']=='consumer']:
  binding=next(r for r in rows if r['kind']=='generated-consumer-binding' and r['captureSequence']==cap['sequence']);prior=next(r for r in rows if r['sequence']==binding['producerCaptureSequence']);entity=[1,10000+prior['sequence'],0o100600,prior['original']['bytes'],5,6,1];prior['originalEntityIdentity']=entity;old=cap['original']['path'];cap.update(original=dict(prior['original']),originalEntityIdentity=list(entity),originalReuse=dict(model='same-phase-producer-original-v1',originCaptureSequence=prior['sequence']));originals.pop(old,None)
 return rows,originals
class ActualFDTests(unittest.TestCase):
 def setUp(self):
  parent=ROOT/'.test-data/sdk-consumer-entity-reuse';parent.mkdir(parents=True,exist_ok=True);self.temp=tempfile.TemporaryDirectory(dir=parent);self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name);self.out=self.root/'out';self.out.mkdir();self.source=self.root/'file';self.data=b'X'*131085;self.source.write_bytes(self.data)
  self.b=core.Observer(self.out,self.root,self.root,maximum_file_bytes=1024**2,maximum_bytes=4*1024**2);self.b.current_phase='compile';self.b.deadline=time.monotonic()+20;self.b.raw=io.BytesIO();self.b.tasks={10:dict(entry=dict(sequence=1,arch=0xc00000b7,nr=57,args=[3,0,0,0,0,0]))};self.b.seq=1;self.b.barrier=lambda:self.b.emit(dict(kind='all-stop-barrier',pids=[10],osStates=['t']));self.b.writable_aliases=lambda *args:[dict(pid=10,fd=3)]
  statfn=core.os.stat;openfn=core.os.open;fake='/proc/10/fd/3';self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close);self.stack.enter_context(patch.object(core,'fdpath',return_value=str(self.source)));self.stack.enter_context(patch.object(core.os,'stat',side_effect=lambda p,*a,**k:statfn(self.source if os.fspath(p)==fake else p,*a,**k)));self.stack.enter_context(patch.object(core.os,'open',side_effect=lambda p,*a,**k:openfn(self.source if os.fspath(p)==fake else p,*a,**k)));self.addCleanup(self.close_retained);self.producer=self.b.capture(10,3,'producer-close');self.b.writable_aliases=lambda *args:[]
 def close_retained(self):
  for fd in list(self.b.retained):
   try:os.close(fd)
   except OSError:pass
   self.b.retained.discard(fd)
 def read(self):
  self.b.tasks[10]['entry']=dict(sequence=self.b.seq+1,arch=0xc00000b7,nr=63,args=[3,0,65536,0,0,0]);return self.b.capture(10,3,'consumer')
 def test_repeated_windows_fullread_actual_and_held_plus_entity_once(self):
  pread=os.pread;seen=[]
  def read(fd,size,offset):
   block=pread(fd,size,offset);seen.append((os.fstat(fd).st_ino,len(block)));return block
  for _ in range(2):
   charge=self.b.domain_bytes;raw=len(self.b.raw.getvalue());seen.clear()
   with patch.object(core.os,'pread',side_effect=read):row=self.read()
   self.assertEqual(row['original'],self.producer['original']);self.assertEqual(row['originalReuse']['originCaptureSequence'],self.producer['sequence']);self.assertEqual(self.b.domain_bytes-charge,len(self.b.raw.getvalue())-raw);self.assertEqual(sum(n for ino,n in seen if ino==self.source.stat().st_ino),2*len(self.data));self.assertEqual(sum(n for ino,n in seen if ino!=self.source.stat().st_ino),len(self.data))
  self.assertEqual(len(list(self.out.glob('capture-*.original'))),1);self.assertEqual(self.b.capture_bytes,len(self.data));self.assertEqual(len(self.b.captures),3);self.assertEqual(len(self.b.phase_capture_files(0)),1)
 def test_crossphase_uses_legacy_physical_copy(self):
  self.b.current_phase='configure';row=self.read();self.assertNotIn('originalReuse',row);self.assertNotEqual(row['original']['path'],self.producer['original']['path']);self.assertEqual(self.b.capture_bytes,2*len(self.data))
 def test_missing_entity_registration_falls_back_without_skipping_actual_copy(self):
  self.b.capture_entities.clear();row=self.read();self.assertNotIn('originalReuse',row);self.assertEqual(self.b.capture_bytes,2*len(self.data))
 def test_source_read_never_uses_consumer_entity_alias(self):
  self.b.tasks[10]['entry']=dict(sequence=self.b.seq+1,arch=0xc00000b7,nr=63,args=[3,0,65536,0,0,0]);row=self.b.capture(10,3,'source-read');self.assertNotIn('originalReuse',row);self.assertEqual(self.b.capture_bytes,2*len(self.data))
 def test_exhausted_raw_budget_refuses_before_body_read(self):
  self.b.maximum_bytes=self.b.domain_bytes
  with patch.object(core.os,'pread') as read,self.assertRaisesRegex(AssertionError,'shared execution original byte bound'):self.read()
  read.assert_not_called()
 def test_expired_parent_refuses_before_body_read(self):
  self.b.deadline=time.monotonic()-1
  with patch.object(core.os,'pread') as read,self.assertRaisesRegex(AssertionError,'observer deadline'):self.read()
  read.assert_not_called()
 def test_readwrite_consumer_uses_original_copy_and_write_transition(self):
  identity=core.probe.identity(self.source.stat());self.b.write_states[tuple(identity[:2])]=dict(sequence=1,afterIdentity=identity,after=dict(bytes=len(self.data),sha256=hashlib.sha256(self.data).hexdigest()));self.b.writable_aliases=lambda *args:[dict(pid=10,fd=3,flags=os.O_RDWR,accessMode=os.O_RDWR)]
  with patch.object(core,'descriptor_flags',return_value=os.O_RDWR),patch.object(core,'descriptor_position',return_value=0):row=self.read()
  self.assertEqual(row['role'],'readwrite-consumer');self.assertNotIn('originalReuse',row);self.assertEqual(self.b.capture_bytes,2*len(self.data))
 def test_changed_bytes_cannot_hit_mocked_identical_metadata(self):
  before=core.probe.identity(self.source.stat());self.source.write_bytes(b'Y'*len(self.data));identity=core.probe.identity
  with patch.object(core.probe,'identity',side_effect=lambda value:before if value.st_ino==before[1] else identity(value)),self.assertRaisesRegex(AssertionError,'consumer bytes differ'):self.read()
 def test_replaced_entity_is_rejected(self):
  entity=self.out/self.producer['original']['path'];entity.unlink();entity.write_bytes(self.data)
  with self.assertRaisesRegex(AssertionError,'entity changed before read'):self.read()
 def test_hardlinked_entity_is_rejected(self):
  os.link(self.out/self.producer['original']['path'],self.root/'extra')
  with self.assertRaises(AssertionError):self.read()
 def test_changed_canonical_bytes_cannot_hit_mocked_identical_metadata(self):
  entity=self.out/self.producer['original']['path'];before=core.probe.identity(entity.stat());entity.write_bytes(b'Z'*len(self.data));identity=core.probe.identity
  with patch.object(core.probe,'identity',side_effect=lambda value:before if value.st_ino==before[1] else identity(value)),self.assertRaisesRegex(AssertionError,'entity bytes or identity changed'):self.read()
 def test_canonical_fifo_is_rejected_without_body_read(self):
  entity=self.out/self.producer['original']['path'];entity.unlink();os.mkfifo(entity);pread=os.pread;reads=[]
  def read(fd,*args):
   if not __import__('stat').S_ISREG(os.fstat(fd).st_mode):reads.append(fd)
   return pread(fd,*args)
  with patch.object(core.os,'pread',side_effect=read),self.assertRaises(AssertionError):self.read()
  self.assertEqual(reads,[])
 def test_new_entity_fd_cleanup_keeps_primary_and_remains_owned_for_abort(self):
  entity=self.out/self.producer['original']['path'];entity_inode=entity.stat().st_ino;close=os.close;pread=os.pread;unclosed=[]
  def read(fd,*args):
   if os.fstat(fd).st_ino==entity_inode:raise ValueError('primary entity read')
   return pread(fd,*args)
  def failing_close(fd):
   if os.fstat(fd).st_ino==entity_inode:unclosed.append(fd);raise OSError('entity cleanup failure')
   return close(fd)
  with patch.object(core.os,'pread',side_effect=read),patch.object(core.os,'close',side_effect=failing_close),self.assertRaisesRegex(ValueError,'primary entity read'):self.read()
  self.assertEqual(len(unclosed),1);self.assertIn(unclosed[0],self.b.retained)
 def test_conflicting_phase_entity_is_rejected(self):
  row=copy.deepcopy(self.producer);row['original']['sha256']='0'*64;self.b.captures.append(row)
  with self.assertRaisesRegex(AssertionError,'conflicting same-phase'):self.b.phase_capture_files(0)
class ReaderTests(unittest.TestCase):
 def test_complete_raw_aliases_preserve_three_actual_consumer_chains(self):
  rows,originals=alias_rows(*fixture.fixture());self.assertEqual(len(originals),3);proof=fixture.observe(rows,originals);self.assertTrue(proof['selectedGeneratedConsumerByteCustodyVerified']);self.assertEqual(len(proof['outputs']),3)
 def test_alias_forward_foreign_crossphase_mixed_and_reverse_binding_reject(self):
  for mode in ['forward','foreign','phase','mixed','missing','duplicate','wrong-binding','links','bool','failed-producer','unmarked','null','no-model']:
   rows,originals=alias_rows(*fixture.fixture());cap=next(r for r in rows if 'originalReuse' in r);prior=next(r for r in rows if r['sequence']==cap['originalReuse']['originCaptureSequence']);binding=next(r for r in rows if r['kind']=='generated-consumer-binding' and r['captureSequence']==cap['sequence'])
   if mode=='forward':cap['originalReuse']['originCaptureSequence']=99999
   elif mode=='foreign':cap['originalReuse']['originCaptureSequence']=next(r['sequence'] for r in rows if r['kind']=='fd-capture' and r['role']=='producer-close' and r is not prior)
   elif mode=='phase':prior['phase']='configure'
   elif mode=='mixed':cap['original']['sha256']='b'*64
   elif mode=='missing':rows.remove(binding)
   elif mode=='duplicate':rows.append(dict(binding,sequence=rows[-1]['sequence']+1))
   elif mode=='wrong-binding':binding['producerCaptureSequence']+=1
   elif mode=='links':cap['originalEntityIdentity'][-1]=2
   elif mode=='bool':cap['originalReuse']['originCaptureSequence']=True
   elif mode=='unmarked':del cap['originalReuse']
   elif mode=='null':cap['originalReuse']=None
   elif mode=='no-model':next(r for r in rows if r['kind']=='owned-root-binding').pop('captureOriginalEntityModel')
   else:next(r for r in rows if r['kind']=='kernel-syscall' and r['op']=='exit' and r['entrySequence']==prior['entrySequence'])['result']=1
   with self.subTest(mode=mode),self.assertRaises(ValueError):fixture.observe(rows,originals)
 def test_sealed_prepared_alias_is_distinct_from_generated_producer(self):
  rows,originals=fixture.fixture();next(row for row in rows if row['kind']=='owned-root-binding')['captureOriginalEntityModel']='same-phase-producer-original-v1';consumer=next(row for row in rows if row['kind']=='fd-capture' and row['role']=='consumer');entity=[1,999,0o100600,consumer['original']['bytes'],5,6,1]
  prior=dict(kind='prepared-build-input-original',phase='compile',sequence=1,path=consumer['path'],identity=consumer['identity'],original=dict(consumer['original']),originalEntityIdentity=entity)
  digest=hashlib.sha256((json.dumps({key:prior[key] for key in ['path','identity','original']},sort_keys=True)+'\n').encode()).hexdigest();seal=dict(kind='prepared-build-input-seal',buildRoot='/build',files=1,inventorySha256=digest,phase='compile',sequence=2)
  for row in rows:
   row['sequence']+=2
   for key in ['entrySequence','barrierSequence','captureSequence','producerCaptureSequence']:
    if key in row:row[key]+=2
  binding=next(row for row in rows if row['kind']=='generated-consumer-binding');binding.update(kind='prepared-consumer-binding',producerCaptureSequence=1);consumer.update(originalReuse=dict(model='same-phase-producer-original-v1',originCaptureSequence=1),originalEntityIdentity=list(entity));rows[:0]=[prior,seal]
  proof=fixture.observe(rows,originals);self.assertTrue(proof['preparedInputConsumerBytesVerified']);self.assertFalse(proof['selectedGeneratedConsumerByteCustodyVerified'])
 def test_actual_zip_closedset_has_three_entities_for_six_captures(self):
  def change(rows,members):
   originals={name.rsplit('/',1)[-1]:value for name,value in members.items()};alias_rows(rows,originals)
   for name in list(members):
    if name.rsplit('/',1)[-1] not in originals:del members[name]
  result=zip_fixture.scenario(change);self.assertTrue(result['selectedGeneratedConsumerByteCustodyVerified']);self.assertTrue(result['generatedInputIoClosureVerified'])
 def test_duplicate_physical_index_resealed_still_rejects(self):
  dumps=json.dumps
  def encode(value,*args,**kwargs):
   if isinstance(value,dict) and value.get('schemaVersion')==1 and isinstance(value.get('files'),list) and value['files'] and 'inner/toolchain-execution/captures/' in value['files'][0].get('path',''):value=dict(value,files=[*value['files'],value['files'][0]])
   return dumps(value,*args,**kwargs)
  with patch.object(zip_fixture.json,'dumps',side_effect=encode),self.assertRaisesRegex(ValueError,'unique registered capture'):zip_fixture.scenario()
if __name__=='__main__':unittest.main()
