import copy,hashlib,importlib.util,json,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('strict_rename',Path(__file__).resolve().parents[1]/'scripts/sdk-generation-multiprocess-bindings.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def fixture():
 rows=[];originals={};data=b'actual generated header';pre=[1,2,33188,len(data),4,5];ren=[1,2,33188,len(data),4,6];mode=[1,2,33261,len(data),4,7]
 def emit(kind,**fields):
  row=dict(kind=kind,phase='compile',sequence=len(rows)+1,**fields);rows.append(row);return row
 def entry(nr,args):return emit('kernel-syscall',pid=11,arch=0xc00000b7,op='entry',nr=nr,args=args)
 def exit(call,result):return emit('kernel-syscall',pid=11,arch=0xc00000b7,op='exit',entrySequence=call['sequence'],result=result,isError=False)
 def barrier():return emit('all-stop-barrier',pids=[10,11],osStates=['t','t'])
 def original():
  name='capture-'+str(len(originals)).zfill(4)+'.original';originals[name]=data;ref=dict(path=name,bytes=len(data),sha256=hashlib.sha256(data).hexdigest());emit('write-original',original=ref);return ref
 def capture(call,role,path,identity):
  b=barrier();ref=original();cap=emit('fd-capture',pid=11,fd=3,entrySequence=call['sequence'],role=role,path=path,identity=identity,barrierSequence=b['sequence'],writers=[dict(pid=11,fd=3)] if role=='producer-close' else [],original=ref);emit('exclusive-captured-syscall-resume',pid=11,entrySequence=call['sequence'],captureSequence=cap['sequence']);return cap
 emit('owned-root-binding',pid=10,backend='ptrace-all-stop-process-v1');emit('actual-child-binding',parentPid=10,childPid=11,event=1)
 close=entry(57,[3,0,0,0,0,0]);producer=capture(close,'producer-close','/build/temp',pre);exit(close,0);emit('exclusive-captured-syscall-exit',pid=11,entrySequence=close['sequence'],result=0,isError=False)
 rename=entry(38,[0,0,0,0,0,0]);emit('kernel-path-arguments',pid=11,entrySequence=rename['sequence'],renamePaths=['/build/temp','/build/final']);b=barrier();before=original();window=emit('actual-rename-window',pid=11,entrySequence=rename['sequence'],barrierSequence=b['sequence'],producerCaptureSequence=producer['sequence'],fromPath='/build/temp',toPath='/build/final',beforeIdentity=pre,namedIdentity=pre,destinationAbsenceErrno=2,beforeOriginal=before,leaseSequence=len(rows)+1);emit('exclusive-rename-resume',pid=11,entrySequence=rename['sequence'],captureSequence=window['sequence']);end=exit(rename,0);after=original();change=emit('actual-rename-transition',pid=11,entrySequence=rename['sequence'],windowSequence=window['sequence'],leaseSequence=window['sequence'],exitSequence=end['sequence'],afterIdentity=ren,namedIdentity=ren,afterOriginal=after,oldPathAbsent=True,oldPathAbsenceErrno=2,result=0,isError=False);emit('exclusive-captured-syscall-exit',pid=11,entrySequence=rename['sequence'],result=0,isError=False)
 chmod=entry(52,[3,0o755,0,0,0,0]);b=barrier();mw=emit('actual-mode-window',pid=11,path='/build/final',entrySequence=chmod['sequence'],barrierSequence=b['sequence'],beforeIdentity=ren,requestedMode=0o755);emit('exclusive-mode-resume',pid=11,entrySequence=chmod['sequence'],captureSequence=mw['sequence']);end=exit(chmod,0);mc=emit('actual-mode-transition',pid=11,entrySequence=chmod['sequence'],windowSequence=mw['sequence'],exitSequence=end['sequence'],afterIdentity=mode,result=0,isError=False);emit('exclusive-captured-syscall-exit',pid=11,entrySequence=chmod['sequence'],result=0,isError=False)
 read=entry(63,[3,0,100,0,0,0]);consumer=capture(read,'consumer','/build/final',mode);exit(read,len(data));emit('exclusive-captured-syscall-exit',pid=11,entrySequence=read['sequence'],result=len(data),isError=False);emit('retained-fd-namespace-binding',producerCaptureSequence=producer['sequence'],consumerCaptureSequence=consumer['sequence'],path='/build/final',namedIdentity=mode,retainedIdentity=mode,modeTransitions=[change['sequence'],mc['sequence']],metadataChainModel='actual-rename-mode-chain-v1');emit('generated-consumer-binding',captureSequence=consumer['sequence'],producerCaptureSequence=producer['sequence'],path='/build/final',identity=mode,retainedIdentity=mode);emit('actual-wait-exit',pid=11,returnCode=0);emit('actual-wait-exit',pid=10,returnCode=0)
 return rows,originals

def observe(rows,originals):return m.observe([('compile',[(json.dumps(row)+'\n').encode() for row in rows])],lambda name,maximum:originals[name],required_inputs={})
def insert_row(rows,at,inserted):
 rows.insert(at,inserted);mapping={r['sequence']:i+1 for i,r in enumerate(rows) if 'sequence' in r}
 for i,row in enumerate(rows):
  row['sequence']=i+1
  for key in ['entrySequence','barrierSequence','producerCaptureSequence','consumerCaptureSequence','captureSequence','windowSequence','leaseSequence','exitSequence']:
   if key in row:row[key]=mapping[row[key]]
  if 'modeTransitions' in row:row['modeTransitions']=[mapping[n] for n in row['modeTransitions']]

class Tests(unittest.TestCase):
 def test_complete_raw_ref_chain(self):
  rows,originals=fixture();report=observe(rows,originals);self.assertEqual(len(report['outputs']),1);self.assertFalse(report['overallSdkSourceVerified'])
 def test_two_abi_tables_use_actual_entry_arch(self):
  for arch in [0xc00000b7,0xc000003e]:
   rows,originals=fixture()
   if arch==0xc000003e:
    for row in rows:
     if row['kind']=='kernel-syscall':
      row['arch']=arch
      if row['op']=='entry':row['nr']={57:3,38:82,52:91,63:0}[row['nr']]
   self.assertEqual(len(observe(rows,originals)['outputs']),1)
 def test_postimage_cannot_borrow_preimage_ref_and_same_task_cannot_run_next_entry(self):
  rows,originals=fixture();window=next(r for r in rows if r['kind']=='actual-rename-window');change=next(r for r in rows if r['kind']=='actual-rename-transition');change['afterOriginal']=window['beforeOriginal']
  with self.assertRaises(ValueError):observe(rows,originals)
  rows,originals=fixture();resume=next(r for r in rows if r['kind']=='exclusive-rename-resume');row=rows[rows.index(resume)+1];row.update(op='entry',nr=172,args=[0]*6)
  with self.assertRaises(ValueError):observe(rows,originals)
 def test_stale_barrier_and_intervening_peer_entry_refuse(self):
  rows,originals=fixture();window=next(r for r in rows if r['kind']=='actual-rename-window');window['barrierSequence']=next(r['sequence'] for r in rows if r['kind']=='all-stop-barrier')
  with self.assertRaises(ValueError):observe(rows,originals)
  rows,originals=fixture();window=next(r for r in rows if r['kind']=='actual-rename-window');at=next(i for i,r in enumerate(rows) if r['sequence']==window['barrierSequence'])+1;inserted=dict(kind='kernel-syscall',phase='compile',pid=10,arch=0xc00000b7,op='entry',nr=172,args=[0]*6);insert_row(rows,at,inserted)
  with self.assertRaisesRegex(ValueError,'barrier'):observe(rows,originals)
 def test_snapshot_and_window_allow_no_intervening_events(self):
  for where in ['after-barrier','before-window']:
   rows,originals=fixture();window=next(r for r in rows if r['kind']=='actual-rename-window');at=rows.index(window) if where=='before-window' else next(i for i,r in enumerate(rows) if r['sequence']==window['barrierSequence'])+1
   insert_row(rows,at,dict(kind='ptrace-event',phase='compile',pid=10,event=128))
   with self.assertRaisesRegex(ValueError,'snapshot'):observe(rows,originals)
 def test_required_operation_fields_and_originals(self):
  mutations=[('actual-rename-window','leaseSequence',999),('actual-rename-window','barrierSequence',999),('actual-rename-window','producerCaptureSequence',999),('actual-rename-window','fromPath','/wrong'),('actual-rename-transition','leaseSequence',999),('actual-rename-transition','oldPathAbsent',False),('actual-rename-transition','result',1),('actual-rename-transition','isError',True),('actual-rename-transition','exitSequence',999)]
  for kind,key,value in mutations:
   with self.subTest(kind=kind,key=key):
    rows,originals=fixture();next(r for r in rows if r['kind']==kind)[key]=value
    with self.assertRaises(ValueError):observe(rows,originals)
  rows,originals=fixture();r=next(r for r in rows if r['kind']=='actual-rename-transition');ref=r['afterOriginal'];originals[ref['path']]=b'x'*ref['bytes'];ref['sha256']=hashlib.sha256(originals[ref['path']]).hexdigest()
  with self.assertRaises(ValueError):observe(rows,originals)
 def test_mode_preimage_ctime_gap_cannot_be_ignored(self):
  rows,originals=fixture();r=next(r for r in rows if r['kind']=='actual-mode-window');r['beforeIdentity']=list(r['beforeIdentity']);r['beforeIdentity'][5]+=1
  with self.assertRaises(ValueError):observe(rows,originals)
 def test_new_pair_cannot_drop_namespace_or_use_old_model(self):
  for drop in [True,False]:
   rows,originals=fixture();r=next(r for r in rows if r['kind']=='retained-fd-namespace-binding')
   if drop:rows.remove(r)
   else:r.pop('metadataChainModel')
   with self.assertRaises(ValueError):observe(rows,originals)
if __name__=='__main__':unittest.main()
