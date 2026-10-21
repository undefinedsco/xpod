"""Versioned bounded file resize: simulated raw stops, actual byte originals."""
import copy,hashlib,unittest
from qlever.tests.test_sdk_generated_vma_kernel_link import upgrade,lease,m
from qlever.tests.test_sdk_generated_vma_bindings import fixture,two_epochs,rebound_epochs,renumber,observe

def generic_fixture(arch,size,make=fixture):
 rows,originals=upgrade(*make(arch));rows[0]['generatedVmaModel']=m.MODEL
 # Every retained byte/reference is transformed together; never just a digest.
 for path,data in list(originals.items()):
  data=data.replace(b'8000-9000',b'800000-801000');originals[path]=data
  if data in [b'\0',b'X',b'Y']:originals[path]=data*size
  elif b'1000-2000 rw-s' in data:originals[path]=data.replace(b'1000-2000',('1000-%x'%(4096+((size+4095)//4096)*4096)).encode())
 def update(value):
  if isinstance(value,dict):
   if set(['path','bytes','sha256']).issubset(value) and value['path'] in originals:
    data=originals[value['path']];value.update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
   for key,item in value.items():
    if key.endswith('Identity') or key in ['identity','mapFilesIdentity']:
     if isinstance(item,list) and len(item)==6 and item[3]==1:item[3]=size
    update(item)
  elif isinstance(value,list):
   for item in value:update(item)
 update(rows)
 serial=30000
 def emit(kind,template,**fields):
  nonlocal serial
  serial+=1;return dict(kind=kind,phase='configure',sequence=serial,observedMonotonicNs=template['observedMonotonicNs'],**fields)
 def original(data,template,maps=False):
  name='capture-'+str(serial)+'.original';originals[name]=data;ref=dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest());return emit('toolchain-original' if maps else 'write-original',template,**(dict(captureKind='maps',observedPid=10) if maps else {}),original=ref),ref
 win=next(r for r in rows if r['kind']=='generated-vma-operation-window' and r['operation']=='resize');entry=next(r for r in rows if r['sequence']==win['entrySequence']);entry['args'][1]=size
 pre=next(r for r in rows if r['sequence']==win['barrierSequence']);body,ref=original(b'',win);maps,mapref=original(b'800000-801000 r-xp 00000000 00:01 999 /usr/bin/fixture\n',win,True);rows[rows.index(win):rows.index(win)]=[body,maps]
 win.update(reservationBytes=m.resize_reservation_bytes(0,size,0,4*1024**2),metadataMaximumBytes=4*1024**2,selectedIdentity=copy.deepcopy(win['identity']),selectedOriginal=ref,selectedFlags=2,procLease=lease(),beforeMapsOriginal=mapref,aliases=[dict(pid=10,fd=6,accessMode=2,flags=2)])
 epoch=next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='resize');actual=next(r for r in rows if r['sequence']==epoch['exitSequence']);post=emit('all-stop-barrier',epoch,pids=pre['pids'],osStates=pre['osStates'],taskOwnership=pre['taskOwnership']);rows.insert(rows.index(actual)+1,post);epoch.update(postBarrierSequence=post['sequence'],procAfter=lease(),selectedFlags=2)
 for row in rows:
  if row['kind']=='kernel-syscall' and row.get('op')=='entry':
   if row['nr']==m.ABI[arch]['map']:row['args'][1]=size
   if row['nr']==m.ABI[arch]['unmap']:row['args'][1]=size
   if row['nr']==(63 if arch==0xc00000b7 else 0):row['args'][2]=size
  if row['kind']=='generated-vma-operation-window' and row['operation']=='map':row['reservationBytes']=m.reservation_bytes(0,4*1024**2,size,'selectedFdBindingSequence' in row)
  if row['kind']=='generated-vma-operation-exit' and row['operation']=='map':row['mapping']=next(x for x in __import__('qlever.tests.test_sdk_generated_vma_bindings',fromlist=['b']).b.parse_proc_maps(originals[row['mapsOriginal']['path']]) if x['inode']==2)
  if row['kind']=='generated-vma-kernel-link-original':row['range'][1]='%x'%(4096+((size+4095)//4096)*4096)
 renumber(rows)
 for row in rows:row['observedMonotonicNs']=str(100000000000+row['sequence']*1000000)
 return rows,originals
def multiple_origins_fixture(arch):
 rows,originals=generic_fixture(arch,4097);extra,values=generic_fixture(arch,1);end=next(r['sequence'] for r in extra if r['kind']=='generated-vma-operation-exit' and r['operation']=='resize');end=next(r['sequence'] for r in extra if r['kind']=='exclusive-captured-syscall-exit' and r['entrySequence']==next(x['entrySequence'] for x in extra if x['sequence']==end));extra=[r for r in extra if 1<r['sequence']<=end];names={name:'capture-'+str(90000+i)+'.original' for i,name in enumerate(values)}
 for name,raw in values.items():originals[names[name]]=raw
 def rewrite(value,offset,other=False):
  if isinstance(value,dict):
   if other and value.get('path') in names and 'sha256' in value:value['path']=names[value['path']]
   for key,item in list(value.items()):
    if (key=='sequence' or key.endswith('Sequence')) and type(item) is int:value[key]=item+offset
    elif other and key=='path' and item=='/opt/qlever-sdk/build/probe':value[key]='/opt/qlever-sdk/build/other'
    elif other and isinstance(item,list) and len(item)==6 and (key.endswith('Identity') or key=='identity') and item[:2]==[1,2]:item[1]=3
    elif not other and key in ['fd','selectedFd','previousFd'] and item==6:value[key]=7
    else:rewrite(item,offset,other)
   if not other and value.get('kind')=='kernel-syscall' and value.get('op')=='entry' and value['nr'] in [m.ABI[arch]['resize'],m.ABI[arch]['close']]:value['args'][0]=7
   if not other and value.get('kind')=='kernel-syscall' and value.get('op')=='entry' and value['nr']==m.ABI[arch]['map']:value['args'][4]=7
  elif isinstance(value,list):
   for item in value:rewrite(item,offset,other)
 create=next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='create');create_entry=create['entrySequence']
 for row in rows:
  if row.get('entrySequence')==create_entry and row.get('result')==6:row['result']=7
 rewrite(extra,10000,True);rewrite(rows[1:],20000,False);combined=[rows[0]]+extra+rows[1:];renumber(combined)
 for row in combined:row['observedMonotonicNs']=str(100000000000+row['sequence']*1000000)
 return combined,originals
def write_resize_chain(arch,with_mapping=False):
 rows,originals=generic_fixture(arch,7);resize=next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='resize');last=next(r['sequence'] for r in rows if r['kind']=='exclusive-captured-syscall-exit' and r['entrySequence']==resize['entrySequence']);rows=[r for r in rows if r['sequence']<=last];identity=copy.deepcopy(resize['identity']);origin=resize['sequence'];body=bytes(7)
 def emit(kind,**fields):
  row=dict(kind=kind,phase='configure',sequence=len(rows)+1,observedMonotonicNs=str(100000000000+(len(rows)+1)*1000000),**fields);rows.append(row);return row
 def original(data,maps=False):
  name='capture-'+str(50000+len(originals))+'.original';originals[name]=data;ref=dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest());emit('toolchain-original' if maps else 'write-original',**(dict(captureKind='maps',observedPid=10) if maps else {}),original=ref);return ref
 def digest(raw):return dict(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
 # Genuine syscall write protocol, independently replayed by the existing sole projection.
 call=emit('kernel-syscall',pid=10,arch=arch,op='entry',nr=64 if arch==0xc00000b7 else 1,args=[6,4096,2,0,0,0]);bar=emit('all-stop-barrier',pids=[10],osStates=['t'],taskOwnership=[dict(tid=10,tgid=10,fdTable=10)]);before=original(body);buffer=original(b'XY');window=emit('actual-write-window',pid=10,fd=6,path='/opt/qlever-sdk/build/probe',entrySequence=call['sequence'],barrierSequence=bar['sequence'],beforeIdentity=copy.deepcopy(identity),format='bounded-write-delta-v1',initialBefore=before,before=digest(body),buffer=buffer,offset=0,position=0,flags=2,writers=[dict(pid=10,fd=6)],baseline=origin);emit('exclusive-write-resume',pid=10,entrySequence=call['sequence'],captureSequence=window['sequence']);actual=emit('kernel-syscall',pid=10,arch=arch,op='exit',entrySequence=call['sequence'],result=2,isError=False);body=b'XY'+body[2:];identity=identity[:4]+[50,50];transition=emit('actual-write-transition',pid=10,entrySequence=call['sequence'],windowSequence=window['sequence'],exitSequence=actual['sequence'],afterIdentity=copy.deepcopy(identity),after=digest(body),result=2,isError=False);ref=original(body);bridge=emit('generated-vma-write-origin-transition',pid=10,originSequence=origin,windowSequence=window['sequence'],transitionSequence=transition['sequence'],identity=copy.deepcopy(identity),original=ref);origin=bridge['sequence'];emit('exclusive-captured-syscall-exit',pid=10,entrySequence=call['sequence'],result=2,isError=False)
 for size in [3,3,0,4097]:
  call=emit('kernel-syscall',pid=10,arch=arch,op='entry',nr=m.ABI[arch]['resize'],args=[6,size,0,0,0,0]);bar=emit('all-stop-barrier',pids=[10],osStates=['t'],taskOwnership=[dict(tid=10,tgid=10,fdTable=10)]);before=original(body);selected=original(body);maps=original(b'',True);window=emit('generated-vma-operation-window',operation='resize',pid=10,entrySequence=call['sequence'],barrierSequence=bar['sequence'],originSequence=origin,path='/opt/qlever-sdk/build/probe',identity=copy.deepcopy(identity),fd=6,beforeOriginal=before,selectedIdentity=copy.deepcopy(identity),selectedOriginal=selected,selectedFlags=2,procLease=lease(),beforeMapsOriginal=maps,aliases=[dict(pid=10,fd=6,accessMode=2,flags=2)],metadataMaximumBytes=4*1024**2,reservationBytes=m.resize_reservation_bytes(len(body),size,0,4*1024**2));emit('exclusive-generated-vma-resume',pid=10,entrySequence=call['sequence'],captureSequence=window['sequence']);actual=emit('kernel-syscall',pid=10,arch=arch,op='exit',entrySequence=call['sequence'],result=0,isError=False);post=emit('all-stop-barrier',pids=bar['pids'],osStates=bar['osStates'],taskOwnership=bar['taskOwnership']);body=body[:size]+bytes(max(0,size-len(body)));identity=identity[:3]+[size,identity[4]+1,identity[5]+1];ref=original(body);result=emit('generated-vma-operation-exit',operation='resize',pid=10,entrySequence=call['sequence'],windowSequence=window['sequence'],exitSequence=actual['sequence'],result=0,isError=False,originSequence=origin,identity=copy.deepcopy(identity),original=ref,postBarrierSequence=post['sequence'],procAfter=lease(),selectedFlags=2);origin=result['sequence'];emit('exclusive-captured-syscall-exit',pid=10,entrySequence=call['sequence'],result=0,isError=False)
 if with_mapping:
  donor,values=generic_fixture(arch,4097);first=next(r for r in donor if r['kind']=='kernel-syscall' and r.get('op')=='entry' and r['nr']==m.ABI[arch]['map']);tail=copy.deepcopy([r for r in donor if r['sequence']>=first['sequence']]);old_origin=next(r for r in donor if r['kind']=='generated-vma-operation-exit' and r['operation']=='resize')['sequence'];names={name:'capture-'+str(70000+i)+'.original' for i,name in enumerate(values)}
  for name,data in values.items():originals[names[name]]=data
  def rewrite(value):
   if isinstance(value,dict):
    if value.get('path') in names and 'sha256' in value:value['path']=names[value['path']]
    for key,item in list(value.items()):
     if key=='originSequence' and item==old_origin:value[key]=origin
     elif (key=='sequence' or key.endswith('Sequence')) and type(item) is int:value[key]=item+100000
     elif isinstance(item,list) and len(item)==6 and key in ['identity','selectedIdentity','retainedIdentity','namedIdentity'] and item[:2]==[1,2]:value[key]=identity[:3]+[4097,identity[4]+(1 if item[4]==12 else 0),identity[5]+(1 if item[5]==12 else 0)]
     else:rewrite(item)
   elif isinstance(value,list):
    for item in value:rewrite(item)
  rewrite(tail);rows+=tail;renumber(rows)
  for row in rows:row['observedMonotonicNs']=str(100000000000+row['sequence']*1000000)
 else:emit('actual-wait-exit',pid=10,returnCode=0)
 return rows,originals
class Tests(unittest.TestCase):
 def test_complete_resize_mapping_consumer_two_abis(self):
  for arch in m.ABI:
   for size in [1,4096,65537]:
    result=observe(*generic_fixture(arch,size));self.assertTrue(result['generatedMappedConsumerByteCustodyVerified']);self.assertFalse(result['overallSdkSourceVerified'])
 def test_generalized_size_preserves_two_epochs_and_new_selected_fd_two_abis(self):
  for arch in m.ABI:
   for make in [two_epochs,lambda a:rebound_epochs(a,True,False),lambda a:rebound_epochs(a,False,True)]:self.assertTrue(observe(*generic_fixture(arch,4097,make))['generatedMappedConsumerByteCustodyVerified'])
 def test_multiple_origins_choose_actual_selected_fd_size_two_abis(self):
  for arch in m.ABI:self.assertTrue(observe(*multiple_origins_fixture(arch))['generatedMappedConsumerByteCustodyVerified'])
 def test_deferred_new_fd_entry_never_substitutes_for_full_window_binding(self):
  for arch in m.ABI:
   for mutation in ['missing','wrongfd','wrongorigin']:
    rows,originals=generic_fixture(arch,4097,lambda a:rebound_epochs(a,True,False));window=next(r for r in rows if r['kind']=='generated-vma-operation-window' and 'selectedFdBindingSequence' in r)
    if mutation=='missing':window.pop('selectedFdBindingSequence')
    elif mutation=='wrongfd':window['fd']=99
    else:window['originSequence']=1
    with self.assertRaises((ValueError,AssertionError,KeyError)):observe(rows,originals)
 def test_resize_fd_size_reserve_postbarrier_and_body_rejected(self):
  for arch in m.ABI:
   for change in ['fd','size','reserve','postbarrier','body']:
    rows,originals=generic_fixture(arch,4096);win=next(r for r in rows if r['kind']=='generated-vma-operation-window' and r['operation']=='resize');entry=next(r for r in rows if r['sequence']==win['entrySequence']);epoch=next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='resize')
    if change=='fd':entry['args'][0]=99
    elif change=='size':entry['args'][1]=4097
    elif change=='reserve':win['reservationBytes']-=1
    elif change=='postbarrier':epoch['postBarrierSequence']=win['barrierSequence']
    else:originals[epoch['original']['path']]=b'X'*4096
    with self.assertRaises((ValueError,AssertionError,KeyError)):observe(rows,originals)
 def test_sole_write_projection_then_shrink_noop_zero_regrow_two_abis(self):
  for arch in m.ABI:self.assertFalse(observe(*write_resize_chain(arch))['overallSdkSourceVerified'])
 def test_write_resize_regrow_mapping_and_actual_consumer_full_replay(self):
  for arch in m.ABI:self.assertTrue(observe(*write_resize_chain(arch,True))['generatedMappedConsumerByteCustodyVerified'])
 def test_write_bridge_cannot_adopt_unproven_after_snapshot(self):
  for arch in m.ABI:
   for field in ['originSequence','transitionSequence','windowSequence','identity','original']:
    rows,originals=write_resize_chain(arch);bridge=next(r for r in rows if r['kind']=='generated-vma-write-origin-transition')
    if field=='identity':bridge[field][5]+=1
    elif field=='original':bridge[field]['sha256']='0'*64
    else:bridge[field]=1
    with self.assertRaises((ValueError,AssertionError,KeyError)):observe(rows,originals)
 def test_streaming_resize_full_before_including_shrunk_tail(self):
  for prior,after in [(b'',b''),(b'',bytes(65537)),(b'XYZ',b'X'),(b'XYZ',b'XYZ'),(b'XYZ',b'XYZ'+bytes(4096))]:
   blocks=lambda raw:(raw[i:i+65536] for i in range(0,len(raw),65536));value=m.verify_resize_bytes(blocks(prior),blocks(after),len(prior),len(after),100000);self.assertEqual(value['before']['sha256'],hashlib.sha256(prior).hexdigest())
  for prior,after in [(b'XYZ',b'Y'),(b'X',b'XY'),(b'XYZ',b'XYQ')]:
   with self.assertRaises(ValueError):m.verify_resize_bytes(iter([prior]),iter([after]),len(prior),len(after),100000)
if __name__=='__main__':unittest.main()
