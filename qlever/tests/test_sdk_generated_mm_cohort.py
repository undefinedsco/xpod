"""Explicit stopped-MM cohort raw replay; no actual kernel claim."""
import copy,hashlib,unittest
from qlever.tests.test_sdk_generated_file_epochs import generic_fixture
from qlever.tests.test_sdk_generated_vma_bindings import observe,renumber
from qlever.tests.test_sdk_generated_vma_kernel_link import m

def cohort_fixture(arch=0xc000003e,size=6336):
 rows,originals=generic_fixture(arch,size);rows[0]['generatedVmaModel']=m.COHORT_MODEL;serial=100000
 def emit(kind,template,**fields):
  nonlocal serial
  serial+=1;return dict(kind=kind,phase='configure',sequence=serial,observedMonotonicNs=template['observedMonotonicNs'],**fields)
 def maps(data,template,pid=11):
  name='capture-%d.original'%serial;originals[name]=data;ref=dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest());return emit('toolchain-original',template,captureKind='maps',observedPid=pid,original=ref),ref
 t=rows[0];flags=0x3d0f00;call=emit('kernel-syscall',t,pid=10,arch=arch,op='entry',nr=56 if arch==0xc000003e else 220,args=[flags,0,0,0,0,0]);extra=[call,emit('kernel-clone-flags',t,pid=10,entrySequence=call['sequence'],flags=flags),emit('ptrace-event',t,pid=10,event=3),emit('actual-child-binding',t,parentPid=10,childPid=11,event=3,cloneEntrySequence=call['sequence'],cloneFlags=flags,tgid=10,fdTable=10),emit('kernel-syscall',t,pid=10,arch=arch,op='exit',entrySequence=call['sequence'],result=11,isError=False)];rows[1:1]=extra
 for row in rows:
  if row['kind']=='all-stop-barrier':row.update(pids=[10,11],osStates=['t','t'],taskOwnership=[dict(tid=10,tgid=10,fdTable=10),dict(tid=11,tgid=10,fdTable=10)])
 for win in list(rows):
  if win['kind']!='generated-vma-operation-window':continue
  op=win['operation'];bar=next(r for r in rows if r['sequence']==win['barrierSequence'])
  if op in ['map','resize','unmap']:
   item,ref=maps(originals[win['beforeMapsOriginal']['path']],win);rows.insert(rows.index(win),item)
   if op in ['map','resize']:win['peerMaps']=[dict(pid=11,original=ref)]
   else:win.update(memoryDomainMembers=[10,11],sameMemoryDomainMaps=[dict(pid=11,original=ref)])
  if op=='resize':win['reservationBytes']=m.resize_reservation_bytes(0,size,1,4*1024**2)
  if op=='map':win.update(memoryDomainMembers=[10,11],reservationBytes=m.cohort_reservation_bytes(1,1,4*1024**2,size,False))
 for out in list(rows):
  if out['kind']!='generated-vma-operation-exit':continue
  if out['operation']=='map':
   item,ref=maps(originals[out['mapsOriginal']['path']],out);rows.insert(rows.index(out),item);out.update(memoryDomainMembers=[10,11],postMapPeerMaps=[dict(pid=11,original=ref)])
  if out['operation']=='unmap':
   actual=next(r for r in rows if r['sequence']==out['exitSequence']);bar=emit('all-stop-barrier',out,pids=[10,11],osStates=['t','t'],taskOwnership=[dict(tid=10,tgid=10,fdTable=10),dict(tid=11,tgid=10,fdTable=10)]);rows.insert(rows.index(actual)+1,bar);item,ref=maps(originals[out['afterMapsOriginal']['path']],out);rows.insert(rows.index(out),item);out.update(memoryDomainMembers=[10,11],postBarrierSequence=bar['sequence'],afterPeerMaps=[dict(pid=11,original=ref)])
 wait=emit('actual-wait-exit',rows[-1],pid=11,returnCode=0);rows.insert(len(rows)-1,wait);renumber(rows)
 for row in rows:row['observedMonotonicNs']=str(100000000000+row['sequence']*1000000)
 return rows,originals

class Tests(unittest.TestCase):
 def test_complete_stopped_shared_mm_two_abis(self):
  for arch in [0xc000003e,0xc00000b7]:
   report=observe(*cohort_fixture(arch));self.assertTrue(report['generatedMappedConsumerByteCustodyVerified'])
 def test_missing_changed_member_or_new_model_omission_rejected(self):
  for change in ['member','model','barrier','postmap','preunmap','postunmap','reservation']:
   rows,originals=cohort_fixture();win=next(r for r in rows if r['kind']=='generated-vma-operation-window' and r['operation']=='map')
   if change=='member':win['memoryDomainMembers']=[10]
   if change=='model':rows[0]['generatedVmaModel']=m.MODEL
   if change=='barrier':next(r for r in rows if r['sequence']==win['barrierSequence'])['pids']=[10]
   if change=='postmap':next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='map')['postMapPeerMaps']=[]
   if change=='preunmap':next(r for r in rows if r['kind']=='generated-vma-operation-window' and r['operation']=='unmap')['sameMemoryDomainMaps']=[]
   if change=='postunmap':next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='unmap').pop('postBarrierSequence')
   if change=='reservation':win['reservationBytes']-=1
   with self.assertRaises((ValueError,AssertionError,KeyError)):observe(rows,originals)
 def test_explicit_fdtable_is_not_inferred_from_mm(self):
  rows,originals=cohort_fixture();binding=next(r for r in rows if r['kind']=='actual-child-binding');binding['cloneFlags']&=~0x400
  with self.assertRaises(ValueError):observe(rows,originals)
 def test_resealed_peer_geometry_backing_and_late_event_rejected(self):
  for change in ['peer-pid','peer-inode','peer-geometry','late-event','peer-exec','wrong-exec-domain','bad-post-ownership']:
   rows,originals=cohort_fixture();out=next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='map');ref=out['postMapPeerMaps'][0]['original']
   if change=='peer-pid':next(r for r in rows if r['kind']=='toolchain-original' and r['original']['path']==ref['path'])['observedPid']=10
   if change in ['peer-inode','peer-geometry']:
    data=originals[ref['path']].replace(b'00:01 2 ',b'00:01 3 ') if change=='peer-inode' else originals[ref['path']].replace(b'rw-s',b'r--s');originals[ref['path']]=data
    for row in rows:
     if row['kind']=='toolchain-original' and row['original']['path']==ref['path']:row['original'].update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
    ref.update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
   if change=='late-event':
    final=next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='unmap');bar=next(r for r in rows if r['sequence']==final['postBarrierSequence']);index=rows.index(bar);rows.insert(index,dict(kind='kernel-syscall',phase='configure',sequence=200001,observedMonotonicNs=bar['observedMonotonicNs'],pid=10,arch=0xc000003e,op='entry',nr=39,args=[0]*6));renumber(rows)
   if change in ['peer-exec','wrong-exec-domain']:
    index=rows.index(out)+1 if change=='peer-exec' else next(i for i,r in enumerate(rows) if r['kind']=='kernel-syscall' and r.get('op')=='entry' and r.get('nr')==9)
    rows.insert(index,dict(kind='ptrace-event',phase='configure',sequence=200002,observedMonotonicNs=rows[index]['observedMonotonicNs'],pid=11,event=4));renumber(rows)
   if change=='bad-post-ownership':
    post=next(r for r in rows if r['sequence']==out['kernelMappingEvidence']['postBarrierSequence']);post['taskOwnership'][1]['fdTable']=11
   for row in rows:row['observedMonotonicNs']=str(100000000000+row['sequence']*1000000)
   with self.assertRaises((ValueError,AssertionError,KeyError)):observe(rows,originals)
 def test_two_fd_tables_same_mm_cannot_share_selected_writable_backing(self):
  rows,originals=cohort_fixture();flags=0x3d0f00&~0x400
  for row in rows:
   if row['kind']=='kernel-clone-flags':row['flags']=flags
   if row['kind']=='actual-child-binding':row.update(cloneFlags=flags,fdTable=11)
   if row['kind']=='kernel-syscall' and row.get('nr')==56 and row.get('op')=='entry':row['args'][0]=flags
   if row['kind']=='all-stop-barrier':row['taskOwnership'][1]['fdTable']=11
   if row['kind']=='generated-vma-operation-window' and row['operation'] in ['map','resize']:row['aliases'].append(dict(pid=11,fd=6,accessMode=2,flags=2))
  with self.assertRaises(ValueError):observe(rows,originals)
 def test_reservation_exact_cohort_increment(self):
  for p,s in [(0,0),(1,1),(5,3),(127,127)]:
   self.assertEqual(m.cohort_reservation_bytes(p,s,4096,6336),m.reservation_bytes(p,4096,6336)+2*s*(4096+65536)+65536)
  for p,s in [(0,1),(128,1),(1,2),(True,0)]:
   with self.assertRaises(ValueError):m.cohort_reservation_bytes(p,s,4096,1)
if __name__=='__main__':unittest.main()
