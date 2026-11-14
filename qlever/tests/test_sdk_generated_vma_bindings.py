"""Two-ABI protocol fixtures only; no kernel execution or capability issuance."""
import copy,hashlib,importlib.util,json,unittest
from pathlib import Path
SCRIPTS=Path(__file__).resolve().parents[1]/'scripts'
spec=importlib.util.spec_from_file_location('generated_bindings',SCRIPTS/'sdk-generation-multiprocess-bindings.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
def fixture(arch=0xc00000b7):
 rules={0xc00000b7:dict(create=56,resize=46,map=222,close=57,unmap=215,read=63),0xc000003e:dict(create=257,resize=77,map=9,close=3,unmap=11,read=0)}[arch]
 rows=[];originals={};path='/opt/qlever-sdk/build/probe';empty=[1,2,0o100600,0,10,10];zero=[1,2,0o100600,1,11,11];dirty=[1,2,0o100600,1,12,12];parent=[1,99,0o40700,4096,1,2];base=b'8000-9000 r-xp 00000000 00:01 999 /usr/bin/fixture\n';mapped=b'1000-2000 rw-s 00000000 00:01 2 '+path.encode()+b'\n'+base
 def emit(kind,**fields):
  sequence=len(rows)+1;row=dict(kind=kind,phase='configure',sequence=sequence,observedMonotonicNs=str(100000000000+sequence*1000000),**fields);rows.append(row);return row
 def entry(op,args):return emit('kernel-syscall',pid=10,arch=arch,op='entry',nr=rules[op],args=args)
 def exit(call,result):return emit('kernel-syscall',pid=10,arch=arch,op='exit',entrySequence=call['sequence'],result=result,isError=False)
 def barrier():return emit('all-stop-barrier',pids=[10],osStates=['t'],taskOwnership=[dict(tid=10,tgid=10,fdTable=10)])
 def original(data,maps=False):
  name='capture-'+str(len(originals)).zfill(4)+'.original';originals[name]=data;ref=dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest());emit('toolchain-original' if maps else 'write-original',**(dict(captureKind='maps',observedPid=10) if maps else {}),original=ref);return ref
 def window(call,op,bar,**fields):return emit('generated-vma-operation-window',operation=op,pid=10,entrySequence=call['sequence'],barrierSequence=bar['sequence'],**fields)
 def resume(call,win):emit('exclusive-generated-vma-resume',pid=10,entrySequence=call['sequence'],captureSequence=win['sequence'])
 def done(call,win,result,**fields):
  actual=exit(call,result);return actual,dict(operation=win['operation'],pid=10,entrySequence=call['sequence'],windowSequence=win['sequence'],exitSequence=actual['sequence'],result=result,isError=False,**fields)
 def close(call,result):emit('exclusive-captured-syscall-exit',pid=10,entrySequence=call['sequence'],result=result,isError=False)
 emit('owned-root-binding',pid=10,backend='ptrace-all-stop-process-v1',taskOwnershipModel='all-tracked-tids-shared-fd-v1',tgid=10,fdTable=10,generatedVmaModel='actual-generated-shared-vma-single-owner-v1',generatedVmaBuildRoot='/opt/qlever-sdk/build',generatedVmaParentDeadlineMonotonicNs='200000000000')
 call=entry('create',[0xffffffffffffff9c,0,194,0o600,0,0]);emit('generated-vma-create-path',pid=10,entrySequence=call['sequence'],path=path,dirFd=0xffffffffffffff9c,pathArgIndex=1);bar=barrier();win=window(call,'create',bar,path=path,parentIdentity=parent,nameAbsenceErrno=2);resume(call,win);actual,fields=done(call,win,6);ref=original(b'');created=emit('generated-vma-operation-exit',**fields,fd=6,fdFlags=2,path=path,parentIdentity=parent,identity=empty,original=ref);close(call,6)
 call=entry('resize',[6,1,0,0,0,0]);bar=barrier();ref=original(b'');win=window(call,'resize',bar,originSequence=created['sequence'],path=path,identity=empty,fd=6,beforeOriginal=ref);resume(call,win);actual,fields=done(call,win,0);ref=original(b'\0');resized=emit('generated-vma-operation-exit',**fields,originSequence=created['sequence'],identity=zero,original=ref);close(call,0)
 call=entry('map',[0,1,3,0x4001,6,0]);bar=barrier();ref=original(b'\0');maps=original(base,True);end=100500000000;win=window(call,'map',bar,originSequence=resized['sequence'],path=path,identity=zero,fd=6,beforeOriginal=ref,beforeMapsOriginal=maps,pageBytes=4096,memoryDomain=1,reservationBytes=4*4*1024**2+40*65536+3,metadataMaximumBytes=4*1024**2,aliases=[dict(pid=10,fd=6,accessMode=2,flags=2)],windowDeadlineMonotonicNs=str(end),parentDeadlineMonotonicNs='200000000000');resume(call,win);actual,fields=done(call,win,4096);maps=original(mapped,True);mapping=b.parse_proc_maps(mapped)[0];epoch=emit('generated-vma-operation-exit',**fields,identity=zero,mapFilesIdentity=zero,mapsOriginal=maps,mapping=mapping,memoryDomain=1,windowDeadlineMonotonicNs=str(end),parentDeadlineMonotonicNs='200000000000');close(call,4096)
 call=entry('close',[6,0,0,0,0,0]);bar=barrier();win=window(call,'close',bar,originSequence=resized['sequence'],path=path,identity=dirty,fd=6);resume(call,win);actual,fields=done(call,win,0);emit('generated-vma-operation-exit',**fields,originSequence=resized['sequence'],fd=6,fdAbsenceErrno=2,identity=dirty,epochSequence=epoch['sequence']);close(call,0)
 call=entry('unmap',[4096,1,0,0,0,0]);bar=barrier();ref=original(b'X');maps=original(mapped,True);win=window(call,'unmap',bar,originSequence=resized['sequence'],path=path,identity=dirty,fd=None,beforeOriginal=ref,beforeMapsOriginal=maps,epochSequence=epoch['sequence']);resume(call,win);actual,fields=done(call,win,0);maps=original(base,True);ref=original(b'X');checkpoint=emit('generated-vma-operation-exit',**fields,path=path,identity=dirty,retainedIdentity=dirty,original=ref,afterMapsOriginal=maps,afterPeerMaps=[],epochSequence=epoch['sequence'],originSequence=resized['sequence']);close(call,0)
 call=entry('read',[7,0,1,0,0,0]);bar=barrier();ref=original(b'X');cap=emit('fd-capture',pid=10,fd=7,entrySequence=call['sequence'],role='consumer',path=path,identity=dirty,barrierSequence=bar['sequence'],writers=[],original=ref);emit('generated-vma-consumer-binding',captureSequence=cap['sequence'],checkpointSequence=checkpoint['sequence'],path=path,identity=dirty);emit('exclusive-captured-syscall-resume',pid=10,entrySequence=call['sequence'],captureSequence=cap['sequence']);exit(call,1);close(call,1);emit('actual-wait-exit',pid=10,returnCode=0)
 return rows,originals

def observe(rows,originals):return b.observe([('configure',[(json.dumps(row)+'\n').encode() for row in rows])],lambda name,maximum:originals[name],required_inputs={})
def renumber(rows):
 mapping={row['sequence']:index+1 for index,row in enumerate(rows)}
 def rewrite(value):
  if isinstance(value,dict):
   for key,item in list(value.items()):
    if (key=='sequence' or key.endswith('Sequence')) and type(item) is int:value[key]=mapping.get(item,item)
    else:rewrite(item)
  elif isinstance(value,list):
   for item in value:rewrite(item)
 for row in rows:rewrite(row)
 return rows
def two_epochs(arch):
 rows,originals=fixture(arch)
 def block(op):
  w=next(r for r in rows if r['kind']=='generated-vma-operation-window' and r['operation']==op);start=w['entrySequence'];last=next(r['sequence'] for r in rows if r['kind']=='exclusive-captured-syscall-exit' and r['entrySequence']==start);return [r for r in rows if start<=r['sequence']<=last]
 closed=block('close');rows=[r for r in rows if r not in closed];new=copy.deepcopy(block('map')+block('unmap'));mapping={r['sequence']:10000+i for i,r in enumerate(new)};refs={}
 def rewrite(value):
  if isinstance(value,dict):
   if set(['path','bytes','sha256']).issubset(value):
    old=value['path'];name=refs.setdefault(old,'capture-'+str(1000+len(refs))+'.original');originals[name]=originals[old];value['path']=name
   for key,item in list(value.items()):
    if (key=='sequence' or key.endswith('Sequence')) and type(item) is int:value[key]=mapping.get(item,item)
    else:rewrite(item)
  elif isinstance(value,list):
   for item in value:rewrite(item)
 for row in new:rewrite(row)
 dirty=[1,2,0o100600,1,12,12];final=[1,2,0o100600,1,13,13]
 def body(ref,data):
  originals[ref['path']]=data
  def update(value):
   if isinstance(value,dict):
    if value.get('path')==ref['path'] and 'sha256' in value:value.update(bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
    for item in value.values():update(item)
   elif isinstance(value,list):
    for item in value:update(item)
  update(new);update(rows)
 for row in new:
  if row['kind']=='generated-vma-operation-window':
   if row['operation']=='map':row['identity']=dirty;body(row['beforeOriginal'],b'X')
   else:row['identity']=final;body(row['beforeOriginal'],b'Y')
  if row['kind']=='generated-vma-operation-exit':
   if row['operation']=='map':row['identity']=dirty;row['mapFilesIdentity']=dirty
   else:row['identity']=final;row['retainedIdentity']=final;body(row['original'],b'Y')
 checkpoint=next(r for r in new if r['kind']=='generated-vma-operation-exit' and r['operation']=='unmap')
 index=next(i for i,r in enumerate(rows) if r['kind']=='fd-capture' and r.get('role')=='consumer');index=next(i for i,r in enumerate(rows) if r['sequence']==rows[index]['entrySequence']);rows[index:index]=new
 for row in rows:
  if row['kind']=='fd-capture' and row.get('role')=='consumer':row['identity']=final;body(row['original'],b'Y')
  if row['kind']=='generated-vma-consumer-binding':row['identity']=final;row['checkpointSequence']=checkpoint['sequence']
 renumber(rows)
 for row in rows:row['observedMonotonicNs']=str(100000000000+row['sequence']*1000000)
 return rows,originals
def rebound_epochs(arch,close_after_unmap=False,close_inside=False):
 rows,originals=two_epochs(arch);window=[r for r in rows if r['kind']=='generated-vma-operation-window' and r['operation']=='map'][1];entry=next(r for r in rows if r['sequence']==window['entrySequence']);entry['args'][4]=7;window['fd']=7;window['aliases'][0]['fd']=7;name='capture-9000.original';originals[name]=b'X';ref=dict(path=name,bytes=1,sha256=hashlib.sha256(b'X').hexdigest());binding=dict(kind='generated-vma-selected-fd-binding',phase='configure',sequence=9998,observedMonotonicNs=window['observedMonotonicNs'],pid=10,entrySequence=window['entrySequence'],barrierSequence=window['barrierSequence'],originSequence=window['originSequence'],selectedFd=7,previousFd=6,fdTable=10,identity=window['identity'],retainedIdentity=window['identity'],namedIdentity=window['identity'],flags=2,path=window['path'],original=ref);window['selectedFdBindingSequence']=9998;index=rows.index(window);rows[index:index]=[dict(kind='write-original',phase='configure',sequence=9997,observedMonotonicNs=window['observedMonotonicNs'],original=copy.deepcopy(ref)),binding];renumber(rows)
 if close_inside:
  epoch=next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='map');win=next(r for r in rows if r['sequence']==epoch['windowSequence']);unmap=next(r for r in rows if r['kind']=='generated-vma-operation-window' and r['operation']=='unmap');index=next(i for i,r in enumerate(rows) if r['sequence']==unmap['entrySequence']);clock=rows[index]['observedMonotonicNs'];common=dict(phase='configure',observedMonotonicNs=clock,pid=10);dirty=unmap['identity'];extra=[dict(common,kind='kernel-syscall',sequence=9940,arch=arch,op='entry',nr=57 if arch==0xc00000b7 else 3,args=[6,0,0,0,0,0]),dict(kind='all-stop-barrier',phase='configure',sequence=9941,observedMonotonicNs=clock,pids=[10],osStates=['t'],taskOwnership=[dict(tid=10,tgid=10,fdTable=10)]),dict(common,kind='generated-vma-operation-window',sequence=9942,operation='close',entrySequence=9940,barrierSequence=9941,originSequence=win['originSequence'],path=win['path'],identity=dirty,fd=6),dict(common,kind='exclusive-generated-vma-resume',sequence=9943,entrySequence=9940,captureSequence=9942),dict(common,kind='kernel-syscall',sequence=9944,arch=arch,op='exit',entrySequence=9940,result=0,isError=False),dict(common,kind='generated-vma-operation-exit',sequence=9945,operation='close',entrySequence=9940,windowSequence=9942,exitSequence=9944,result=0,isError=False,originSequence=win['originSequence'],fd=6,fdAbsenceErrno=2,identity=dirty,epochSequence=epoch['sequence']),dict(common,kind='exclusive-captured-syscall-exit',sequence=9946,entrySequence=9940,result=0,isError=False)];rows[index:index]=extra
 if close_after_unmap:
  first=next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='unmap');end=next(i for i,r in enumerate(rows) if r['kind']=='exclusive-captured-syscall-exit' and r['entrySequence']==first['entrySequence']);clock=rows[end]['observedMonotonicNs'];rows[end+1:end+1]=[dict(kind='kernel-syscall',phase='configure',sequence=9995,observedMonotonicNs=clock,pid=10,arch=arch,op='entry',nr=57 if arch==0xc00000b7 else 3,args=[6,0,0,0,0,0]),dict(kind='kernel-syscall',phase='configure',sequence=9996,observedMonotonicNs=clock,pid=10,arch=arch,op='exit',entrySequence=9995,result=0,isError=False)]
 renumber(rows)
 for row in rows:row['observedMonotonicNs']=str(100000000000+row['sequence']*1000000)
 return rows,originals
class Tests(unittest.TestCase):
 def test_create_resize_map_close_is_not_unmap_checkpoint_then_read_two_abis(self):
  for arch in [0xc00000b7,0xc000003e]:
   report=observe(*fixture(arch));self.assertTrue(report['generatedMappedConsumerByteCustodyVerified']);self.assertEqual(report['observedGeneratedWritableMapCheckpoints'],1);self.assertEqual(report['outputs'][0]['sha256'],hashlib.sha256(b'X').hexdigest());self.assertFalse(report['overallSdkSourceVerified'])
 def test_exact_mapping_dimensions_two_abis(self):
  for arch in [0xc00000b7,0xc000003e]:
   for index,value in [(0,4096),(1,2),(2,7),(3,0x1),(4,9),(5,1)]:
    rows,originals=fixture(arch);row=next(r for r in rows if r['kind']=='kernel-syscall' and r.get('op')=='entry' and r.get('nr') in [9,222]);row['args'][index]=value
    with self.assertRaises((ValueError,AssertionError,KeyError)):observe(rows,originals)
 def test_missing_or_stale_barrier_and_window_interleaving(self):
  for operation in ['create','resize','map','close','unmap']:
   rows,originals=fixture();window=next(r for r in rows if r['kind']=='generated-vma-operation-window' and r['operation']==operation);window['barrierSequence']=2
   with self.assertRaises((ValueError,AssertionError,KeyError)):observe(rows,originals)
 def test_complete_unmap_required_and_close_does_not_end_epoch(self):
  for nr in [215,216,226,46,63,93,98]:
   rows,originals=fixture();call=next(r for r in rows if r['kind']=='kernel-syscall' and r.get('op')=='entry' and r.get('nr')==215);call['nr']=nr;call['args']=[4096,4097,0,0,0,0]
   with self.assertRaises((ValueError,AssertionError,KeyError)):observe(rows,originals)
 def test_epoch_deadline_and_backing_identity_reject(self):
  for field,value in [('mapFilesIdentity',[1,999,0o100600,1,11,11]),('windowDeadlineMonotonicNs','100000000000'),('memoryDomain',999)]:
   rows,originals=fixture();row=next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='map');row[field]=value
   with self.assertRaises((ValueError,AssertionError,KeyError)):observe(rows,originals)
 def test_checkpoint_custody_and_successful_actual_exit_required(self):
  for change in ['identity','path','result','error']:
   rows,originals=fixture()
   if change in ['identity','path']:
    row=next(r for r in rows if r['kind']=='generated-vma-consumer-binding');row[change]=[1,2,0o100600,1,99,99] if change=='identity' else '/opt/qlever-sdk/build/other'
   else:
    row=next(r for r in rows if r['kind']=='kernel-syscall' and r.get('op')=='exit' and r.get('result')==4096);row['result' if change=='result' else 'isError']=-1 if change=='result' else True
   with self.assertRaises((ValueError,AssertionError,KeyError)):observe(rows,originals)
 def test_resealed_actual_execution_cannot_cross_preimage_or_resume_window(self):
  for place in ['snapshot','window']:
   rows,originals=fixture();target=next(r for r in rows if r['kind']=='generated-vma-operation-window' and r['operation']=='map');index=rows.index(target)+(place=='window');call=dict(kind='kernel-syscall',phase='configure',sequence=9991,observedMonotonicNs='100030000000',pid=10,arch=0xc00000b7,op='entry',nr=172,args=[0]*6);exit=dict(kind='kernel-syscall',phase='configure',sequence=9992,observedMonotonicNs='100031000000',pid=10,arch=0xc00000b7,op='exit',entrySequence=9991,result=10,isError=False);rows[index:index]=[call,exit];renumber(rows)
   with self.assertRaises((ValueError,AssertionError,KeyError)):observe(rows,originals)
 def test_resealed_duplicate_completion_and_missing_unmap_reject(self):
  for change in ['duplicate','missing']:
   rows,originals=fixture();row=next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='unmap');index=rows.index(row)
   if change=='duplicate':extra=copy.deepcopy(row);extra['sequence']=9993;rows.insert(index+1,extra)
   else:rows.pop(index)
   renumber(rows)
   with self.assertRaises((ValueError,AssertionError,KeyError)):observe(rows,originals)
 def test_reservation_cannot_be_understated_or_caller_maximum(self):
  for field,value in [('reservationBytes',1),('metadataMaximumBytes',1)]:
   rows,originals=fixture();row=next(r for r in rows if r['kind']=='generated-vma-operation-window' and r['operation']=='map');row[field]=value
   with self.assertRaises(ValueError):observe(rows,originals)
 def test_resealed_remaining_backing_vma_refuses_checkpoint(self):
  rows,originals=fixture();row=next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='unmap');reference=row['afterMapsOriginal'];data=b'1000-2000 rw-s 00000000 00:01 2 /opt/qlever-sdk/build/probe\n';originals[reference['path']]=data;new=dict(path=reference['path'],bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
  for item in rows:
   for key,value in list(item.items()):
    if isinstance(value,dict) and value.get('path')==reference['path']:item[key]=copy.deepcopy(new)
  with self.assertRaises(ValueError):observe(rows,originals)
 def test_actual_resize_fd_cannot_be_substituted_two_abis(self):
  for arch in [0xc00000b7,0xc000003e]:
   rows,originals=fixture(arch);row=next(r for r in rows if r['kind']=='kernel-syscall' and r.get('op')=='entry' and r.get('nr') in [46,77]);row['args'][0]=99
   with self.assertRaises(ValueError):observe(rows,originals)
 def test_epoch_clock_resealed_zero_or_backwards_rejects(self):
  for change in ['allzero','onebackwards']:
   rows,originals=fixture();start=next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='map')['sequence'];end=next(r for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='unmap')['sequence']
   for row in rows:
    if start<row['sequence']<=end:
     row['observedMonotonicNs']='0' if change=='allzero' else str(100000000000+(start-1)*1000000)
     if change=='onebackwards':break
   with self.assertRaises(ValueError):observe(rows,originals)
 def test_same_bytes_maps_cannot_come_from_another_pid(self):
  for index in range(4):
   rows,originals=fixture();maps=[r for r in rows if r['kind']=='toolchain-original' and r.get('captureKind')=='maps'];maps[index]['observedPid']=99
   with self.assertRaises(ValueError):observe(rows,originals)
 def test_window_parent_must_join_actual_root_parent(self):
  rows,originals=fixture();rows[0]['generatedVmaParentDeadlineMonotonicNs']='150000000000'
  with self.assertRaises(ValueError):observe(rows,originals)
 def test_two_actual_fd_epochs_advance_verified_checkpoint_two_abis(self):
  for arch in [0xc00000b7,0xc000003e]:
   report=observe(*two_epochs(arch));self.assertEqual(report['observedGeneratedWritableMapCheckpoints'],2);self.assertTrue(report['generatedMappedConsumerByteCustodyVerified']);self.assertEqual(report['outputs'][0]['sha256'],hashlib.sha256(b'Y').hexdigest());self.assertFalse(report['overallSdkSourceVerified'])
 def test_second_epoch_cannot_reuse_zero_identity_or_wrong_checkpoint(self):
  for arch in [0xc00000b7,0xc000003e]:
   for change in ['identity','checkpoint']:
    rows,originals=two_epochs(arch)
    if change=='identity':row=[r for r in rows if r['kind']=='generated-vma-operation-window' and r['operation']=='map'][1];row['identity']=[1,2,0o100600,1,11,11]
    else:row=next(r for r in rows if r['kind']=='generated-vma-consumer-binding');row['checkpointSequence']=next(r['sequence'] for r in rows if r['kind']=='generated-vma-operation-exit' and r['operation']=='unmap')
    with self.assertRaises(ValueError):observe(rows,originals)
 def test_second_epoch_new_unbound_descriptor_rejects_both_abis(self):
  for arch in [0xc00000b7,0xc000003e]:
   rows,originals=two_epochs(arch);calls=[r for r in rows if r['kind']=='kernel-syscall' and r.get('op')=='entry' and r.get('nr') in [9,222]];calls[1]['args'][4]=7
   with self.assertRaises(ValueError):observe(rows,originals)
 def test_rebound_selected_fd_two_epochs_both_abis(self):
  for arch in [0xc00000b7,0xc000003e]:
   report=observe(*rebound_epochs(arch));self.assertEqual(report['observedGeneratedWritableMapCheckpoints'],2);self.assertTrue(report['generatedMappedConsumerByteCustodyVerified'])
 def test_rebound_fd_wrong_object_fdtable_bytes_or_link_refuse(self):
  for arch in [0xc00000b7,0xc000003e]:
   for field,value in [('selectedFd',8),('previousFd',9),('fdTable',99),('identity',[1,999,0o100600,1,12,12]),('namedIdentity',[1,2,0o100600,1,12,99]),('flags',0),('originSequence',1)]:
    rows,originals=rebound_epochs(arch);row=next(r for r in rows if r['kind']=='generated-vma-selected-fd-binding');row[field]=value
    with self.assertRaises(ValueError):observe(rows,originals)
 def test_close_after_checkpoint_then_rebind_both_abis(self):
  for arch in [0xc00000b7,0xc000003e]:
   report=observe(*rebound_epochs(arch,True));self.assertEqual(report['observedGeneratedWritableMapCheckpoints'],2);self.assertTrue(report['generatedMappedConsumerByteCustodyVerified'])
 def test_close_while_first_epoch_dirty_then_new_fd_second_epoch_both_abis(self):
  for arch in [0xc00000b7,0xc000003e]:
   report=observe(*rebound_epochs(arch,close_inside=True));self.assertEqual(report['observedGeneratedWritableMapCheckpoints'],2);self.assertTrue(report['generatedMappedConsumerByteCustodyVerified'])
if __name__=='__main__':unittest.main()
