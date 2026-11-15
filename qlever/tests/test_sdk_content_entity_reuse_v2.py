"""Same-phase physical content reuse: real ordinary FDs, no native claim."""
import copy,hashlib,importlib.util,json,os,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('content_entity_legacy_fixture',Path(__file__).with_name('test_sdk_consumer_entity_reuse.py'))
old=importlib.util.module_from_spec(spec);spec.loader.exec_module(old)
core=old.core;fixture=old.fixture
MODEL='same-phase-content-entity-v2'
class ActualContentTests(unittest.TestCase):
 close_retained=old.ActualFDTests.close_retained
 read=old.ActualFDTests.read
 def setUp(self):
  constructor=core.Observer
  def create(*args,**kwargs):
   kwargs.update(capture_content_entities=True,maximum_file_bytes=8*1024**2,maximum_bytes=32*1024**2)
   return constructor(*args,**kwargs)
  with patch.object(core,'Observer',side_effect=create):old.ActualFDTests.setUp(self)
 def test_no_match_budget_exact_and_minus_one(self):
  # Exercise body-only charging with the real held FD; raw metadata is separately
  # charged by emit in integration fixtures.
  path=self.root/'budget';data=b'B'*65537;path.write_bytes(data);fd=os.open(path,os.O_RDONLY);self.addCleanup(os.close,fd);ident=core.probe.identity(path.stat());start=self.b.domain_bytes
  self.b.maximum_bytes=start+len(data)-1
  with self.assertRaisesRegex(AssertionError,'shared execution original byte bound'):self.b.content_capture_original(fd,str(path),ident,'capture-9997.original',{})
  self.assertEqual(self.b.domain_bytes-start,65536);self.assertEqual((self.out/'capture-9997.original').stat().st_size,65536)
  start=self.b.domain_bytes;self.b.maximum_bytes=start+len(data)
  result=self.b.content_capture_original(fd,str(path),ident,'capture-9998.original',{})
  self.assertEqual(self.b.domain_bytes-start,len(data));self.assertEqual(result[-1],(len(data),hashlib.sha256(data).hexdigest()))
 def test_same_fd_second_pass_aba_rejects(self):
  path=self.root/'second-pass';data=b'A'*131085;path.write_bytes(data);fd=os.open(path,os.O_RDONLY);self.addCleanup(os.close,fd);ident=core.probe.identity(path.stat());pread=os.pread;passes=0
  def read(reader,size,offset):
   nonlocal passes
   if reader==fd and offset==0:
    passes+=1
    if passes==2:path.write_bytes(b'B'*len(data))
   return pread(reader,size,offset)
  with patch.object(core.os,'pread',side_effect=read),self.assertRaisesRegex(AssertionError,'fresh physical content pass changed'):self.b.content_capture_original(fd,str(path),ident,'capture-9999.original',{})
 # Old-model expectation tests remain in their original suite, not inherited here.
 def test_large_different_inode_same_bytes_preserves_windows_and_one_entity(self):
  data=b'entity-content\n'*(3807335//15)+b'Z'*(3807335%15)
  self.source=self.root/'large-a';self.source.write_bytes(data)
  with patch.object(core,'fdpath',side_effect=lambda *args:str(self.source)):
   self.b.tasks[10]['entry']=dict(sequence=self.b.seq+1,arch=0xc00000b7,nr=57,args=[3,0,0,0,0,0]);self.b.writable_aliases=lambda *args:[dict(pid=10,fd=3)]
   first=self.b.capture(10,3,'producer-close');physical=self.b.capture_bytes
   self.source=self.root/'large-b';self.source.write_bytes(data)
   self.assertNotEqual(first['identity'][1],self.source.stat().st_ino)
   reads=[];pread=os.pread
   def read(fd,size,offset):
    block=pread(fd,size,offset);reads.append((os.fstat(fd).st_ino,len(block)));return block
   with patch.object(core.os,'pread',side_effect=read):second=self.b.capture(10,3,'producer-close')
  self.assertEqual(first['original'],second['original']);self.assertEqual(second['originalReuse']['originCaptureSequence'],first['sequence']);self.assertNotEqual(first['identity'],second['identity']);self.assertEqual(second['captureWindowIdentity'][:6],second['identity']);self.assertEqual(second['namedWindowIdentity'],second['captureWindowIdentity']);self.assertEqual(self.b.capture_bytes,physical)
  self.assertEqual(sum(n for ino,n in reads if ino==second['identity'][1]),len(data));self.assertEqual(sum(n for ino,n in reads if ino==second['originalEntityIdentity'][1]),len(data));self.assertEqual(len(data),3807335)
  print('CONTENT_ENTITY_ORDINARY_FD_MEASUREMENT '+json.dumps(dict(bodyBytes=len(data),bodySHA256=hashlib.sha256(data).hexdigest(),sourceInodesDistinct=first['identity'][1]!=second['identity'][1],secondActualFDReadBytes=sum(n for ino,n in reads if ino==second['identity'][1]),canonicalRetainedReadBytes=sum(n for ino,n in reads if ino==second['originalEntityIdentity'][1]),secondPhysicalBodyBytes=self.b.capture_bytes-physical,qualification=False),sort_keys=True))
 def test_different_bytes_clean_copy_two_full_passes(self):
  self.b.writable_aliases=lambda *args:[dict(pid=10,fd=3)];self.source=self.root/'different';data=b'Y'*len(self.data);self.source.write_bytes(data);pread=os.pread;reads=[]
  def read(fd,size,offset):
   block=pread(fd,size,offset);reads.append(len(block));return block
  with patch.object(core,'fdpath',return_value=str(self.source)),patch.object(core.os,'pread',side_effect=read):row=self.b.capture(10,3,'producer-close')
  self.assertNotIn('originalReuse',row);self.assertEqual(sum(reads),2*len(data));self.assertEqual(self.b.capture_bytes,2*len(data));self.assertEqual(row['original']['sha256'],hashlib.sha256(data).hexdigest())
 def test_crossphase_copy(self):
  self.b.current_phase='configure';row=self.read();self.assertNotIn('originalReuse',row);self.assertEqual(self.b.capture_bytes,2*len(self.data))
 def test_canonical_body_change_rejected(self):
  entity=self.out/self.producer['original']['path'];entity.write_bytes(b'Z'*len(self.data))
  with self.assertRaises(AssertionError):self.read()
 def test_canonical_aba_rejected(self):
  entity=self.out/self.producer['original']['path'];replacement=self.root/'replacement';replacement.write_bytes(self.data);os.replace(replacement,entity)
  with self.assertRaises(AssertionError):self.read()
def content_rows(arch=0xc00000b7):
 rows,originals=fixture.fixture()
 if arch==0xc000003e:
  for row in rows:
   if row['kind']=='kernel-syscall' and row['op']=='entry':row['arch']=arch;row['nr']={57:3,38:82,63:0}.get(row['nr'],row['nr'])
 for row in rows:
  if row['kind']=='owned-root-binding':row['captureOriginalEntityModel']=MODEL
  if row['kind']=='fd-capture':row.update(originalEntityIdentity=[1,10000+row['sequence'],0o100600,row['original']['bytes'],5,6,1],captureWindowIdentity=[*row['identity'],1],captureWindowAfterIdentity=[*row['identity'],1])
 for cap in [r for r in rows if r['kind']=='fd-capture' and r['role']=='consumer']:
  binding=next(r for r in rows if r['kind']=='generated-consumer-binding' and r['captureSequence']==cap['sequence']);prior=next(r for r in rows if r['sequence']==binding['producerCaptureSequence']);discard=cap['original']['path'];cap.update(original=dict(prior['original']),originalEntityIdentity=list(prior['originalEntityIdentity']),originalReuse=dict(model=MODEL,originCaptureSequence=prior['sequence']),captureWindowIdentity=[*cap['identity'],1],namedWindowIdentity=[*cap['identity'],1],namedWindowAfterIdentity=[*cap['identity'],1]);originals.pop(discard)
 return rows,originals
class ReaderTests(unittest.TestCase):
 def test_same_content_different_source_inodes_uses_one_storage_anchor(self):
  rows,originals=content_rows();first=next(r for r in rows if r['kind']=='fd-capture');body=originals[first['original']['path']]
  for row in rows:
   if row['kind']!='fd-capture':continue
   original=row['original'];originals[original['path']]=body;original['bytes']=len(body);original['sha256']=hashlib.sha256(body).hexdigest();row['identity'][3]=len(body);row['originalEntityIdentity'][3]=len(body)
   if row is not first:
    row.update(original=dict(first['original']),originalEntityIdentity=list(first['originalEntityIdentity']),originalReuse=dict(model=MODEL,originCaptureSequence=first['sequence']),captureWindowIdentity=[*row['identity'],1],namedWindowIdentity=[*row['identity'],1],namedWindowAfterIdentity=[*row['identity'],1])
  # Every source/rename/binding identity remains its own inode; all header bodies
  # have equal lengths, so existing syscall read lengths remain exact.
  proof=fixture.observe(rows,{first['original']['path']:body});self.assertEqual(len(proof['outputs']),3)
 def test_full_zip_closed_members(self):
  def change(rows,members):
   for row in rows:
    if row['kind']=='owned-root-binding':row['captureOriginalEntityModel']=MODEL
    if row['kind']=='fd-capture':row.update(originalEntityIdentity=[1,10000+row['sequence'],0o100600,row['original']['bytes'],5,6,1],captureWindowIdentity=[*row['identity'],1],captureWindowAfterIdentity=[*row['identity'],1])
   for cap in [r for r in rows if r['kind']=='fd-capture' and r['role']=='consumer']:
    binding=next(r for r in rows if r['kind']=='generated-consumer-binding' and r['captureSequence']==cap['sequence']);prior=next(r for r in rows if r['sequence']==binding['producerCaptureSequence']);discard=cap['original']['path'];cap.update(original=dict(prior['original']),originalEntityIdentity=list(prior['originalEntityIdentity']),originalReuse=dict(model=MODEL,originCaptureSequence=prior['sequence']),captureWindowIdentity=[*cap['identity'],1],namedWindowIdentity=[*cap['identity'],1],namedWindowAfterIdentity=[*cap['identity'],1])
    for name in list(members):
     if name.rsplit('/',1)[-1]==discard:del members[name]
  result=old.zip_fixture.scenario(change);self.assertTrue(result['generatedInputIoClosureVerified'])
 def test_duplicate_canonical_physical_path_rejected(self):
  rows,originals=content_rows();prior=next(r for r in rows if r['kind']=='fd-capture');duplicate=dict(kind='write-original',phase='compile',sequence=rows[-1]['sequence']+1,original=dict(prior['original']),originalEntityIdentity=list(prior['originalEntityIdentity']));rows.append(duplicate)
  with self.assertRaisesRegex(ValueError,'canonical physical content path repeated'):fixture.observe(rows,originals)
 def test_each_canonical_window_requires_exact_seven_pre_post(self):
  for mode in ['missing','post','boolean','namedpost']:
   rows,originals=content_rows();row=next(r for r in rows if r['kind']=='fd-capture')
   if mode=='missing':row.pop('captureWindowAfterIdentity')
   elif mode=='post':row['captureWindowAfterIdentity'][-1]+=1
   elif mode=='boolean':row['captureWindowIdentity'][0]=True
   else:row['namedWindowIdentity']=list(row['captureWindowIdentity']);row['namedWindowAfterIdentity']=[0]*7
   with self.subTest(mode=mode),self.assertRaises(ValueError):fixture.observe(rows,originals)
 def test_pre_root_prepared_storage_anchor_preserves_generated_provenance(self):
  rows,originals=content_rows();consumer=next(r for r in rows if 'originalReuse' in r);prior=next(r for r in rows if r['sequence']==consumer['originalReuse']['originCaptureSequence']);ref=dict(prior['original'],path='capture-9999.original');originals[ref['path']]=originals[prior['original']['path']]
  prepared=dict(kind='prepared-build-input-original',phase='compile',sequence=1,path=consumer['path'],identity=list(consumer['identity']),original=ref,originalEntityIdentity=[1,9999,0o100600,ref['bytes'],5,6,1]);digest=hashlib.sha256((json.dumps({key:prepared[key] for key in ['path','identity','original']},sort_keys=True)+'\n').encode()).hexdigest();seal=dict(kind='prepared-build-input-seal',phase='compile',sequence=2,buildRoot='/build',files=1,inventorySha256=digest)
  for row in rows:
   row['sequence']+=2
   for key in ['entrySequence','barrierSequence','captureSequence','producerCaptureSequence']:
    if key in row:row[key]+=2
   if 'originalReuse' in row:row['originalReuse']['originCaptureSequence']+=2
  consumer.update(original=dict(ref),originalEntityIdentity=list(prepared['originalEntityIdentity']),originalReuse=dict(model=MODEL,originCaptureSequence=1));rows[:0]=[prepared,seal]
  proof=fixture.observe(rows,originals);self.assertTrue(proof['selectedGeneratedConsumerByteCustodyVerified'])
 def test_complete_three_own_provenance_chains(self):
  for arch in [0xc000003e,0xc00000b7]:
   proof=fixture.observe(*content_rows(arch));self.assertTrue(proof['selectedGeneratedConsumerByteCustodyVerified']);self.assertEqual(len(proof['outputs']),3)
 def test_backward_phase_reference_identity_and_binding_rejections(self):
  for mode in ['forward','crossphase','mixed','unmarked','null','links','bool','window','named','missing','foreign','duplicate']:
   rows,originals=content_rows();cap=next(r for r in rows if 'originalReuse' in r);prior=next(r for r in rows if r['sequence']==cap['originalReuse']['originCaptureSequence']);binding=next(r for r in rows if r['kind']=='generated-consumer-binding' and r['captureSequence']==cap['sequence'])
   if mode=='forward':cap['originalReuse']['originCaptureSequence']=cap['sequence']+1
   elif mode=='crossphase':prior['phase']='configure'
   elif mode=='mixed':cap['original']['sha256']='b'*64
   elif mode=='unmarked':del cap['originalReuse']
   elif mode=='null':cap['originalReuse']=None
   elif mode=='links':cap['originalEntityIdentity'][-1]=2
   elif mode=='bool':cap['captureWindowIdentity'][0]=True
   elif mode=='window':cap['captureWindowIdentity'][1]+=1
   elif mode=='named':cap['namedWindowIdentity'][1]+=1
   elif mode=='missing':rows.remove(binding)
   elif mode=='foreign':binding['producerCaptureSequence']+=1
   elif mode=='duplicate':rows.append(dict(binding,sequence=rows[-1]['sequence']+1))
   with self.subTest(mode=mode),self.assertRaises(ValueError):fixture.observe(rows,originals)
if __name__=='__main__':unittest.main()
